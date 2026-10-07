import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentLease } from "../../cloud-agent-lease";
import { CloudNativeBoundary, cloudNativeProviderEnvironment } from "../cloud-native-boundary";
import { CLOUD_COORDINATOR_HOME } from "../cloud-coordinator-view.mjs";
import { CLOUD_NATIVE_HOME } from "../cloud-native-view.mjs";
import type { BoundarySpawnRequest, PreparedBoundary } from "../types";

vi.mock("../cloud-runtime-root.mjs",async original=>({
  ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime:(await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const mocked = vi.hoisted(() => ({ rm: vi.fn(async () => {}) }));
const gitAuthor = { name: "Test Member", email: "1234+test-member@users.noreply.github.com" };
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), rm: mocked.rm }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const admission = { executionId: randomUUID(), delegationId: randomUUID(), provider: "cursor" as const, model: "qualified-model",
    source: { kind: "session" as const, actorSessionId: randomUUID() } };
  const request = vi.fn(async (input: { kind: string }) => input.kind === "release" ? { released: true } : {
    leaseId: randomUUID(), authorityId: "a".repeat(64), expiresAt: new Date(Date.now() + 45000).toISOString(), credentialVersion: 1,
    credentialKind: "cursor-api-key", provider: "cursor", model: "qualified-model", material: { kind: "cursor-api-key", apiKey: "synthetic-cursor-key" }, gitAuthor,
  });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() });
  const stop = vi.fn(async () => {});
  const process = { stopAndProve: stop, wait: () => new Promise(() => {}) };
  const workload = {
    generation: "workload", status: { backend: "cloud-worker", parity: { level: "full", restrictions: [] } }, attestation: Promise.resolve(),
    wrapSpawn: vi.fn((input: BoundarySpawnRequest) => ({ command: "/usr/bin/node", args: ["supervisor", "private-descriptor"], env: {}, cwd: "/", stdio: input.stdio ?? "pipe" })),
    trackProcess: vi.fn(() => process), cancelUnstartedLaunch: vi.fn(), stopAndProve: stop,
  } as unknown as PreparedBoundary;
  const view = { directory: `/run/zeros/coordinators/${"a".repeat(32)}`,
    history: { provider: "cursor" as const, directory: `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/cursor` } };
  const release = vi.fn(async () => {});
  const Constructor = CloudNativeBoundary as unknown as new (...args: unknown[]) => CloudNativeBoundary;
  const boundary = new Constructor(lease, workload, view, { HOME: "/srv/zeros/home/agent", CURSOR_API_KEY: "synthetic-cursor-key" }, { release });
  lease.attach(boundary);
  return { boundary, lease, workload, view, request, release };
}

describe("native provider process ownership", () => {
  it("preserves admitted literals when translating managed native-home paths", () => {
    const values = { APP_PATH: `${CLOUD_COORDINATOR_HOME}/app`, ORG_SECRET: `${CLOUD_COORDINATOR_HOME}/synthetic-private-value` };
    const env = cloudNativeProviderEnvironment({ kind: "cursor-api-key", apiKey: "synthetic-cursor-key" }, "qualified-model", undefined, values);
    expect(env.HOME).toBe(CLOUD_NATIVE_HOME);
    expect({ APP_PATH: env.APP_PATH, ORG_SECRET: env.ORG_SECRET }).toEqual(values);
  });
  it("uses the existing workspace policy and supplies only the active run's environment and home", async () => {
    const { boundary, lease, workload, view } = await fixture();
    try {
      const launch = boundary.wrapSpawn({ command: "/opt/zeros-runtime/bin/node", args: ["native-host"], cwd: "/srv/zeros/workspace", env: { DATABASE_URL: "untrusted", CURSOR_API_KEY: "override", GIT_AUTHOR_NAME: "Another Member" } });
      boundary.cancelUnstartedLaunch(launch);
      expect(workload.wrapSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/zeros/workspace", cloudNativeHome: view,
        env: { HOME: "/srv/zeros/home/agent", CURSOR_API_KEY: "synthetic-cursor-key",
          GIT_AUTHOR_NAME: gitAuthor.name, GIT_AUTHOR_EMAIL: gitAuthor.email,
          GIT_COMMITTER_NAME: gitAuthor.name, GIT_COMMITTER_EMAIL: gitAuthor.email } }));
      expect(boundary.status).toBe(workload.status);
    } finally { await lease.close(); }
  });

  it("does not release history or erase HOME while a native spawn is untracked", async () => {
    vi.useFakeTimers();
    const { boundary, lease, release, workload } = await fixture();
    const launch = boundary.wrapSpawn({ command: "/opt/zeros-runtime/bin/node", args: ["native-host"], cwd: "/srv/zeros/workspace", env: {} });
    await expect(lease.close()).rejects.toThrow(/retirement/);
    expect(release).not.toHaveBeenCalled(); expect(mocked.rm).not.toHaveBeenCalled();
    const child = Object.assign(new EventEmitter(), { pid: 123, spawnfile: launch.command, spawnargs: [launch.command, ...launch.args] }) as ChildProcess;
    expect(() => boundary.trackProcess(child)).toThrow(/retired/);
    await lease.close();
    expect(workload.stopAndProve).toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(mocked.rm).toHaveBeenCalledOnce();
  });
});

import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentLease } from "../../cloud-agent-lease";
import { CloudNativeBoundary, cloudNativeProviderEnvironment } from "../cloud-native-boundary";
import { createCloudNativeHome } from "../cloud-native-home";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import type { BoundaryProcess, BoundarySpawnRequest, PreparedBoundary } from "../types";

vi.mock("../cloud-runtime-root.mjs",async original=>({
  ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime:(await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
const mocked = vi.hoisted(() => ({ rm: vi.fn(async (_file: import("node:fs").PathLike, _options?: import("node:fs").RmOptions) => {}) }));
const configuration = vi.hoisted(() => ({ version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => configuration, isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
const gitAuthor = { name: "Test Member", email: "1234+test-member@users.noreply.github.com" };
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(), rm: mocked.rm }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.clearAllMocks(); });

async function fixture() {
  const admission = { executionId: randomUUID(), delegationId: randomUUID(), provider: "cursor" as const, model: "qualified-model",
    source: { kind: "session" as const, actorSessionId: randomUUID() } };
  const request = vi.fn(async (input: { kind: string }) => input.kind === "release" ? { released: true } : {
    leaseId: randomUUID(), authorityId: "a".repeat(64), expiresAt: new Date(Date.now() + 45000).toISOString(), credentialVersion: 1,
    credentialKind: "cursor-api-key", provider: "cursor", model: "qualified-model", material: { kind: "cursor-api-key", apiKey: "synthetic-cursor-key" }, gitAuthor,
  });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() });
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-process-"));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  cleanups.push(() => actual.rm(root, { recursive: true, force: true }));
  const registry = portableCloudWorkloads(configuration); cleanups.push(() => registry.drain(registry.fence()));
  const workload = await new CloudExecutionBoundary({ configuration, workloads: registry }).prepare({ executionId: admission.executionId,
    actor: "agent-code", cwd: root, workspaceRoot: root });
  const originalStop = workload.stopAndProve;
  const stop = vi.spyOn(workload, "stopAndProve").mockImplementation(() => originalStop());
  const process: BoundaryProcess = { pid: 123, stdin: null, stdout: null, stderr: null,
    signal: async () => {}, stopAndProve: stop, wait: () => new Promise<never>(() => {}) };
  vi.spyOn(workload, "wrapSpawn").mockImplementation((input: BoundarySpawnRequest) => ({ command: "/usr/bin/node", args: ["supervisor", "private-descriptor"], env: {}, cwd: "/", stdio: input.stdio ?? "pipe" }));
  vi.spyOn(workload, "trackProcess").mockReturnValue(process);
  vi.spyOn(workload, "cancelUnstartedLaunch").mockImplementation(() => {});
  const nativeHome = await createCloudNativeHome({ dataRoot: root, conversationId: "conversation", executionId: admission.executionId, provider: "cursor" });
  const release = vi.fn(async () => {});
  const Constructor = CloudNativeBoundary as unknown as new (...args: unknown[]) => CloudNativeBoundary;
  const boundary = new Constructor(lease, workload, nativeHome, { HOME: nativeHome.paths.home, CURSOR_API_KEY: "synthetic-cursor-key" }, { release, capture: vi.fn(async () => {}) });
  lease.attach(boundary);
  return { boundary, lease, workload, nativeHome, request, release };
}

describe("native provider process ownership", () => {
  it.each(["sdk-ts","cli","invalid","sdk-ts\n"])("allowlists the pinned SDK entrypoint only (%j)",async entrypoint=>{
    const {boundary,lease,workload,nativeHome}=await fixture();
    try{
      const launch=boundary.wrapSpawn({command:"/opt/zeros-runtime/bin/node",args:["native-host"],cwd:"/srv/zeros/workspace",env:{CLAUDE_CODE_ENTRYPOINT:entrypoint,CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS:"1",HOME:"/untrusted",CURSOR_API_KEY:"override"}});
      boundary.cancelUnstartedLaunch(launch);
      const env=vi.mocked(workload.wrapSpawn).mock.calls[0]![0].env;
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe(entrypoint==="sdk-ts"?"sdk-ts":undefined);
      expect(env.HOME).toBe(nativeHome.paths.home);expect(env.CURSOR_API_KEY).toBe("synthetic-cursor-key");
      expect(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
    }finally{await lease.close();}
  });
  it("preserves admitted literals alongside the original physical native-home paths", async () => {
    const { nativeHome, lease } = await fixture();
    const values = { APP_PATH: "/home/zeros-agent/app", ORG_SECRET: "/home/zeros-agent/synthetic-private-value" };
    const env = cloudNativeProviderEnvironment({ kind: "cursor-api-key", apiKey: "synthetic-cursor-key" }, "qualified-model", undefined, values, nativeHome);
    expect(env.HOME).toBe(nativeHome.paths.home);
    expect({ APP_PATH: env.APP_PATH, ORG_SECRET: env.ORG_SECRET }).toEqual(values);
    await lease.close();
  });
  it("uses the existing workspace policy and supplies only the active run's environment and home", async () => {
    const { boundary, lease, workload, nativeHome } = await fixture();
    try {
      const launch = boundary.wrapSpawn({ command: "/opt/zeros-runtime/bin/node", args: ["native-host"], cwd: "/srv/zeros/workspace", env: { DATABASE_URL: "untrusted", CURSOR_API_KEY: "override", GIT_AUTHOR_NAME: "Another Member" } });
      boundary.cancelUnstartedLaunch(launch);
      expect(workload.wrapSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/srv/zeros/workspace",
        env: { HOME: nativeHome.paths.home, CURSOR_API_KEY: "synthetic-cursor-key",
          GIT_AUTHOR_NAME: gitAuthor.name, GIT_AUTHOR_EMAIL: gitAuthor.email,
          GIT_COMMITTER_NAME: gitAuthor.name, GIT_COMMITTER_EMAIL: gitAuthor.email } }));
      expect(boundary.status).toBe(workload.status);
    } finally { await lease.close(); }
  });

  it("does not release history or erase HOME while a native spawn is untracked", async () => {
    vi.useFakeTimers();
    const { boundary, lease, release, workload, nativeHome } = await fixture();
    const launch = boundary.wrapSpawn({ command: "/opt/zeros-runtime/bin/node", args: ["native-host"], cwd: "/srv/zeros/workspace", env: {} });
    await expect(lease.close()).rejects.toThrow(/retirement/);
    expect(release).not.toHaveBeenCalled(); expect(mocked.rm).not.toHaveBeenCalled();
    const child = Object.assign(new EventEmitter(), { pid: 123, spawnfile: launch.command, spawnargs: [launch.command, ...launch.args] }) as ChildProcess;
    expect(() => boundary.trackProcess(child)).toThrow(/retired/);
    await lease.close();
    expect(workload.stopAndProve).toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
    expect(mocked.rm.mock.calls.filter(([file]) => file === nativeHome.paths.directory)).toHaveLength(1);
  });
});

import { portableCloudWorkloads } from "./helpers/portable-cloud-custody";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudAgentLease } from "../../cloud-agent-lease";
import { CloudExecutionBoundary } from "../cloud-execution-boundary";
import { CloudNativeBoundary } from "../cloud-native-boundary";

const fixture = vi.hoisted(() => ({ root: "", configuration: { version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } } }));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => fixture.configuration,
  isCloudWorkerConfiguration: (value: unknown) => value === fixture.configuration }));
vi.mock("../cloud-runtime-root.mjs", async original => ({ ...await original<typeof import("../cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../__tests__/helpers/test-cloud-runtime")).testCloudRuntime }));
vi.mock("../../../db/paths", async original => ({ ...await original<typeof import("../../../db/paths")>(), zerosDataDir: () => fixture.root }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); fixture.root = ""; });

async function nativeWorkload() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-failure-")); fixture.root = root;
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const registry = portableCloudWorkloads(fixture.configuration); cleanups.push(() => registry.drain(registry.fence()));
  const admission = { executionId: randomUUID(), delegationId: randomUUID(), provider: "cursor" as const, model: "test-model",
    source: { kind: "session" as const, actorSessionId: randomUUID() } };
  const request = vi.fn(async (input: { kind: string }) => input.kind === "release" ? { released: true } : {
    leaseId: randomUUID(), authorityId: "a".repeat(64), expiresAt: new Date(Date.now() + 45000).toISOString(), credentialVersion: 1,
    credentialKind: "cursor-api-key", provider: admission.provider, model: admission.model,
    material: { kind: "cursor-api-key", apiKey: "synthetic-selected-key" },
    gitAuthor: { name: "Sending member", email: "1234+sender@users.noreply.github.com" } });
  const lease = await CloudAgentLease.admit(admission, request, new AbortController().signal, { onRetirementFailure: vi.fn() });
  cleanups.push(() => lease.close());
  const workload = await new CloudExecutionBoundary({ configuration: fixture.configuration, workloads: registry }).prepare({
    executionId: admission.executionId, actor: "agent-code", cwd: root, workspaceRoot: root });
  lease.attach(workload);
  return { root, registry, lease, workload, takeMaterial: vi.spyOn(lease, "takeMaterial"), spawn: vi.spyOn(workload, "spawn") };
}

describe("closed native preparation failures", () => {
  it.each(["cloud_validation_rate_limited", "cloud_validation_lease_expired", "cloud_agent_credential_revoked",
    "cloud_containment_canary_failed"])("preserves the known authority cause %s without starting the provider", async code => {
    const f = await nativeWorkload();
    Object.defineProperty(f.workload, "attestation", { value: Promise.reject(Object.assign(new Error("private preparation diagnostic"), { code })) });
    await expect(CloudNativeBoundary.prepare(f.lease, f.workload, "conversation"))
      .rejects.toMatchObject({ code, message: expect.not.stringContaining("private") });
    expect(f.takeMaterial).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
    await expect(lstat(path.join(f.root, "native-agent-homes"))).rejects.toMatchObject({ code: "ENOENT" });
    await f.lease.close();
    expect(f.registry.snapshot().scopes).toEqual([]);
  });
  it.each([undefined, "private_unknown_code"])("closes an unknown preparation cause (%s) without exposing it", async code => {
    const f = await nativeWorkload();
    Object.defineProperty(f.workload, "attestation", { value: Promise.reject(Object.assign(new Error("private preparation diagnostic"), { code })) });
    await expect(CloudNativeBoundary.prepare(f.lease, f.workload, "conversation"))
      .rejects.toMatchObject({ code: "cloud_containment_attestation_failed", message: expect.not.stringContaining("private") });
    expect(f.takeMaterial).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
    await expect(lstat(path.join(f.root, "native-agent-homes"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

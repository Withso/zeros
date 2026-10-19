import { createHash } from "node:crypto";
import { vi } from "vitest";
import evidenceFixture from "../../packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json";
import { effectiveCloudResourceLimits } from "../cloud-workspace-validation/sandbox/cgroup-resources.mjs";

export function canonical(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const root = "/sys/fs/cgroup/system.slice/zeros-host.service";
export const common = `${root}/engine-runtime`;
export const control = `${common}/engine-12345678-1234-4234-8234-123456789abc`;
export const workload = `${common}/engine-workload-shared/workload`;
const id = (directory: string, ino: string) => ({ directory, dev: "1", ino });

export function bootFixture() {
  const evidence = structuredClone(evidenceFixture);
  const selection = { mode: "build", qualificationId: "55555555-5555-4555-8555-555555555555", evidenceSha256: hash(evidence), evidence,
    snapshot: { name: "fixture-alpha-computer-v1", snapshotId: "fixture-snapshot", treeSha256: "c".repeat(64) } };
  const attempt = { execution: { organizationId: evidence.scope.organizationId, workspaceId: "66666666-6666-4666-8666-666666666666",
    generation: 2, setupRunId: "77777777-7777-4777-8777-777777777777", executionFence: 3 }, phase: "launch", nonce: "a1".repeat(32) };
  const runtime = { runtimeId: evidence.runtime.runtimeId, manifestSha256: evidence.runtime.manifestSha256,
    installerReceiptSha256: evidence.runtime.installerReceiptSha256, baseCompatibilityId: evidence.base.baseCompatibilityId,
    bootId: "88888888-8888-4888-8888-888888888888", supervisorSessionId: "99999999-9999-4999-8999-999999999999" };
  const installation = { ...runtime, profile: "v4", cgroupRoot: root, root: `/opt/zeros-infra/${runtime.runtimeId}`,
    workerRoot: `/opt/zeros-infra/${runtime.runtimeId}/worker` };
  const binding = { containerInitStartTicks: "12345", namespaces: { cgroup: "cgroup:[123]", mnt: "mnt:[124]", pid: "pid:[125]" } };
  const files = { [`${common}/cpu.max`]: "400000 100000", [`${common}/memory.max`]: String(7 * 1024 ** 3), [`${common}/pids.max`]: "4096" };
  const resources = { ...effectiveCloudResourceLimits(`0::${control.slice("/sys/fs/cgroup".length)}\n`, (file: string) => files[file] ?? null),
    memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
      hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false },
    cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100,
      cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } };
  const probe = { schema: "zeros.cloud-boot-probe/v1", identity: { uid: 10003, euid: 10003, gid: 10003, egid: 10003,
    uidMap: "10003 10003 1", gidMap: "10003 10003 1", noNewPrivs: 1, seccompMode: 2,
    capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } },
    apparmor: { profile: "zeros-cloud-engine", mode: "unconfined" }, mounts: true, storage: true, credentials: true,
    resources, custody: { common: id(common, "2"), workload: id(workload, "3"),
      controller: { pid: 1122, startToken: "6789", scope: id(control, "4") } },
    census: { sha256: "1".repeat(64), groups: 4, processes: 1 },
    retirement: { ...id(common, "2"), populated: 0, pruned: true }, outputJoined: true };
  let now = Date.parse("2026-10-19T12:00:00Z");
  let proof: unknown;
  let currentAttempt = structuredClone(attempt);
  const store = {
    clear: vi.fn(() => { proof = undefined; }),
    publish: vi.fn((value: unknown) => { proof = structuredClone(value); }),
    consume: vi.fn(async (validate: (value: unknown) => unknown) => {
      const acquired = proof; proof = undefined;
      if (!acquired) throw new Error("launch_proof");
      return validate(acquired);
    }),
  };
  const verifyBuildQualification = vi.fn(async () => ({ schema: "zeros.computer-build-verification/v1",
    qualificationId: selection.qualificationId, evidenceSha256: selection.evidenceSha256,
    bootIntegritySha256: evidence.base.bootIntegritySha256, kernelSha256: hash(evidence.kernel), runtime: structuredClone(runtime) }));
  const assertCurrent = vi.fn();
  const ports = { now: () => now,
    fullAttest: vi.fn(() => ({ version: 2 })),
    fullConsume: vi.fn(() => ({ version: 2 })),
    loadContract: async () => import("../cloud-workspace-validation/sandbox/cloud-boot-contract"),
    readRuntime: vi.fn(() => structuredClone(installation)), readBinding: vi.fn(() => structuredClone(binding)),
    withLocks: vi.fn(async (operation: (locks: { assertCurrent: () => void }) => unknown) => operation({ assertCurrent })),
    runProbe: vi.fn(async () => structuredClone(probe)), checkResources: vi.fn(() => ({ admitted: true })), proofStore: store };
  const options = { selection, attempt, deadlineMs: now + 5000, verifyBuildQualification,
    readAttempt: vi.fn(() => structuredClone(currentAttempt)) };
  return { options, ports, selection, attempt, runtime, installation, binding, probe, store, verifyBuildQualification, assertCurrent,
    advance(ms: number) { now += ms; }, current(value: typeof attempt) { currentAttempt = value; },
    get proof() { return proof as Record<string, any> | undefined; }, set proof(value) { proof = value; } };
}

import { expect, it, vi } from "vitest";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
import { cloudWorkspaceImageAdmissionChecks, cloudWorkspaceImageAdmissionDiagnostic } from "../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs";
import { CLOUD_V4_IDENTITY_FIELDS } from "../cloud-workspace-validation/sandbox/attest-cloud-worker.mjs";
const contract = { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 40960 };
function report() {
  const runtime = testCloudRuntime();
  return { version: 2, boundary: "workspace-vm", profile: "zeros-cloud-worker-v4", qualified: true,
    runtime: Object.fromEntries(CLOUD_V4_IDENTITY_FIELDS.map(name => [name, runtime[name as keyof typeof runtime]])),
    helpers: { deploymentTrusted: { setupHelper: true, hostProcessSupervisor: true } },
    resources: { finite: true, cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
      allocation: { architecture: "linux/amd64", cpuMillicores: 4000, memoryBytes: 8 * 1024 ** 3, storageBytes: 40 * 1024 ** 3 },
      memoryBudget: { nominalMemoryBytes: String(8 * 1024 ** 3), measuredMemoryBytes: String(8 * 1024 ** 3),
        hostMemoryMax: String(256 * 1024 ** 2), source: "nominal", capped: false },
      cpuSplit: { engine: { cpuMax: "max 100000", cpuWeight: 100 }, workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } } },
    qualification: { identity: { hostUid: 10003, namespaceUid: 10003, noNewPrivs: 1, seccompMode: 2, capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } },
      execution: { sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true, originalProcessGroupsRetired: true, timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true },
      capture: { sameEngineIdentity: true, chromiumSandbox: true }, humanServices: { sameEngineIdentity: true, noSandbox: true } } };
}
const checks = (value: ReturnType<typeof report>) => cloudWorkspaceImageAdmissionChecks({ image: { resources: contract } },
  { version: 4, profile: "zeros-cloud-worker-v4" }, { code: 0, timedOut: false, overflow: false }, value);
it("admits the measured nominal common-parent bounds with an uncapped engine and exact workload split", () => {
  expect(Object.values(checks(report()))).toEqual(Array(8).fill(true));
});
it("refuses an unbounded nominal common parent or missing broker mode", () => {
  const unbounded = report(); Object.assign(unbounded.resources, { finite: false, cpuMax: null });
  expect(checks(unbounded).resources).toBe(false);
  const missing = report(); delete (missing.resources as { memoryBudget?: unknown }).memoryBudget;
  expect(checks(missing).resources).toBe(false);
});
it("uses the actual non-root/group-vs-VM diagnostic rather than archived roles", () => {
  expect(cloudWorkspaceImageAdmissionDiagnostic(report())).toMatchObject({ identity: true, workload: true, capture: true, humanServices: true });
});
it.each(["originalProcessGroupsRetired", "timeoutRetired", "workloadCgroup", "vmWorkloadDrain", "noSandbox"] as const)("refuses lost execution evidence %s", name => {
  const value = report(); value.qualification.execution[name] = false;
  expect(checks(value).runtime).toBe(false); expect(cloudWorkspaceImageAdmissionDiagnostic(value).workload).toBe(false);
});
it("refuses source-only inner success, a missing CPU split and a lost common-parent bound", () => {
  const value = report(); value.qualified = false;
  expect(checks(value).runtime).toBe(false);
  const missing = report(); delete (missing.resources as { cpuSplit?: unknown }).cpuSplit; expect(checks(missing).resources).toBe(false);
  const unbounded = report(); Object.assign(unbounded.resources, { memoryMax: null }); expect(checks(unbounded).resources).toBe(false);
});

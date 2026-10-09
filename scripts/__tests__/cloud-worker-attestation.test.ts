import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { attestationFixture, activePath, compatibilityPath, digest, markerPath, proofPath } from "./cloud-worker-attestation-fixture";
import { ClosedDiagnosticSchema } from "../../packages/protocol/src/cloud-runtime-bundle";
import { verifyRuntimeTransferReport } from "../../apps/control-plane/src/cloud-workspaces/runtime-transfer-proof";

const fixtures: ReturnType<typeof attestationFixture>[] = [];
function fixture(version = 4, observations: { availableCPUs?: number } = {}) {
  const value = attestationFixture(version, observations); fixtures.push(value); return value;
}
afterEach(() => { for (const tree of fixtures.splice(0)) tree.dispose(); });
function failed(tree: ReturnType<typeof fixture>, check: string, args?: string[]) {
  const result = tree.execute("attest-cloud-worker.mjs", args);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  const diagnostic = JSON.parse(result.stdout);
  expect(ClosedDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  expect(diagnostic).toMatchObject({ component: "attester", ok: false, exitCode: 1, failedChecks: [check] });
  expect(fs.existsSync(tree.physical(proofPath))).toBe(false);
  return diagnostic;
}

describe("cloud worker attestation", () => {
  it.each([1, 2, 3])("refuses worker-v%i before qualification or proof publication", version => {
    const tree = fixture(version);
    failed(tree, "host_marker");
    expect(tree.calls).toHaveLength(0);
  });
  it("never falls back to legacy from a pinned v4 executable", () => {
    const tree = fixture(); tree.write(markerPath, { ...tree.marker, version: 3, profile: "zeros-cloud-worker-v3" });
    failed(tree, "host_marker");
  });

  it("qualifies v4 without legacy metadata and binds its installed identity", () => {
    const tree = fixture(), result = tree.execute();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const [report, diagnostic] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(report).toMatchObject({ version: 2, boundary: "workspace-vm", qualified: true, profile: "zeros-cloud-worker-v4", runtime: {
      runtimeId: tree.descriptor.runtimeId, manifestSha256: tree.descriptor.manifestSha256,
      baseCompatibilityId: tree.descriptor.baseCompatibilityId, installerReceiptSha256: tree.descriptor.installerReceiptSha256,
      bootId: tree.descriptor.bootId, supervisorSessionId: tree.descriptor.supervisorSessionId } });
    expect(report.helpers.trusted).toEqual({node:true});
    expect(report.helpers.deploymentTrusted.hostProcessSupervisor).toBe(true);
    expect(report.helpers.deploymentTrusted).not.toHaveProperty("workerSupervisor");
    expect(report.qualification.identity).toEqual({ hostUid: 10003, namespaceUid: 10003, noNewPrivs: 1, seccompMode: 2,
      capabilities: { effective: 0, permitted: 0, inheritable: 0, bounding: 0, ambient: 0 } });
    expect(report.qualification.execution).toEqual({ sameEngineIdentity: true, noSandbox: true, ownedProcessGroups: true,
      originalProcessGroupsRetired: true, timeoutRetired: true, workloadCgroup: true, vmWorkloadDrain: true });
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/secure|unprivileged|Design/);
    expect(diagnostic).toEqual({ schema: "zeros.diagnostic/v1", component: "attester", stage: "done", ok: true,
      exitCode: 0, timedOut: false, failedChecks: [], timings: expect.any(Object) });
    expect(ClosedDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(result.stdout).not.toMatch(/buildSha256|imageContract|sourceIntegrity|nativeInventory/);
    const proof = JSON.parse(fs.readFileSync(tree.physical(proofPath), "utf8"));
    expect(proof).toMatchObject({ version: 2, ...report.runtime, profile: report.profile });
    expect(proof).not.toHaveProperty("buildSha256");
    expect(tree.calls.filter(call => call.args.includes("--qualify")).map(call => call.args[0])).toEqual([
      `${tree.root}/lib/zeros/cloud-engine-launcher.mjs`, `${tree.root}/lib/zeros/cloud-setup-process.mjs`]);
    expect(tree.calls.every(call => call.file === `${tree.root}/bin/node`)).toBe(true);
    for (const call of tree.calls) expect(Object.keys(call.options.env as object).sort()).toEqual([
      "HOME", "PATH"]);
  });

  it.each([
    ["receipt_digest", (tree: ReturnType<typeof fixture>) => tree.write(tree.receiptPath, { ...tree.receipt, archiveSha256: "f".repeat(64) }, 0o600)],
    ["manifest_digest", (tree: ReturnType<typeof fixture>) => tree.write(`${tree.root}/manifest.json`, "{}")],
    ["base_compatibility", (tree: ReturnType<typeof fixture>) => tree.write(compatibilityPath, "{}")],
    ["host_marker", (tree: ReturnType<typeof fixture>) => tree.write(markerPath, { ...tree.marker, uid: 0 })],
    ["root_ownership", (tree: ReturnType<typeof fixture>) => tree.owners.set(tree.root, 10001)],
    ["active_descriptor", (tree: ReturnType<typeof fixture>) => tree.write(activePath, { ...tree.descriptor, root: "/tmp/forged" }, 0o600)],
  ] as const)("rejects a v4 identity mismatch with %s", (check, mutate) => {
    const tree = fixture(); mutate(tree);
    failed(tree, check);
    expect(tree.calls).toHaveLength(0);
  });

  it.each([
    { schema: "future" }, { runtimeId: `r1-${"e".repeat(64)}` }, { manifestSha256: "e".repeat(64) },
    { baseCompatibilityId: `bc1-${"e".repeat(64)}` }, { archiveSha256: "invalid" }, { bootstrapVersion: 2 },
    { expandedBytes: 1 }, { fileCount: 1 }, { installedAt: "invalid" }, { unknown: true },
  ])("checks receipt semantics even when its raw digest matches: %j", change => {
    const tree = fixture(); tree.updateReceipt({ ...tree.receipt, ...change });
    failed(tree, "installer_receipt");
  });
  it("rejects absent receipts, duplicate JSON keys and incomplete installations", () => {
    const missing = fixture(); fs.unlinkSync(missing.physical(missing.receiptPath));
    failed(missing, "installer_receipt");
    const duplicate = fixture();
    duplicate.updateReceipt(`{"schema":"ignored",${JSON.stringify(duplicate.receipt).slice(1)}`);
    failed(duplicate, "installer_receipt");
    const incomplete = fixture(); incomplete.write(`${incomplete.root}.incomplete`, "", 0o600);
    failed(incomplete, "file_inventory");
    expect(incomplete.calls).toHaveLength(0);
  });
  it("rejects a package link that leaves the runtime before reentering it", () => {
    const tree = fixture();
    tree.link(`${tree.root}/worker/reentry`, `../../${tree.descriptor.runtimeId}/worker/package.json`);
    failed(tree, "symlink_escape");
  });
  it.each(["2026-02-30T00:00:00Z", "2026-10-04T24:00:00Z", "2026-10-04T00:00:00Z\u2028"])(
    "rejects normalized non-RFC3339 receipt timestamps", installedAt => {
      const tree = fixture(); tree.updateReceipt({ ...tree.receipt, installedAt });
      failed(tree, "installer_receipt");
    });
  it("hashes raw receipt and compatibility bytes without reserialization", () => {
    const tree = fixture();
    const rawCompatibility = JSON.stringify(tree.compatibility, null, 2) + "\n";
    tree.write(compatibilityPath, rawCompatibility);
    tree.descriptor.baseCompatibilityId = `bc1-${digest(rawCompatibility)}`;
    tree.updateReceipt(JSON.stringify({ ...tree.receipt, baseCompatibilityId: tree.descriptor.baseCompatibilityId }, null, 2) + "\n");
    expect(tree.execute().exitCode).toBe(0);
  });
  it.each([
    ["file_mode", (tree: ReturnType<typeof fixture>) => fs.chmodSync(tree.physical(`${tree.root}/worker/package.json`), 0o666)],
    ["file_mode", (tree: ReturnType<typeof fixture>) => fs.chmodSync(tree.physical(`${tree.root}/worker/package.json`), 0o4555)],
    ["hard_link", (tree: ReturnType<typeof fixture>) => fs.linkSync(tree.physical(`${tree.root}/worker/package.json`), tree.physical(`${tree.root}/alias`))],
    ["symlink_escape", (tree: ReturnType<typeof fixture>) => tree.link(`${tree.root}/worker/escape`, "../../../../etc")],
    ["apparmor", (tree: ReturnType<typeof fixture>) => fs.unlinkSync(tree.physical("/etc/apparmor.d/zeros-cloud-engine"))],
    ["boot_identity", (tree: ReturnType<typeof fixture>) => tree.write("/proc/sys/kernel/random/boot_id", "32345678-1234-4234-8234-123456789abc")],
    ["namespace_binding", (tree: ReturnType<typeof fixture>) => { tree.namespaces.user = ""; }],
  ] as const)("retains host safety checks: %s", (check, change) => {
    const tree = fixture(); change(tree); failed(tree, check);
  });
  it.each(["effective", "permitted", "inheritable", "bounding", "ambient"] as const)("refuses nonzero %s capability", name => {
    const tree = fixture(); tree.qualification.identity.capabilities[name] = 1; failed(tree, "seccomp");
  });
  it.each([
    ["uid_map", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.hostUid = 0; }],
    ["seccomp", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.noNewPrivs = 0; }],
    ["seccomp", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.seccompMode = 0; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.ownedProcessGroups = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.originalProcessGroupsRetired = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.workloadCgroup = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.vmWorkloadDrain = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.capture.chromiumSandbox = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.humanServices.noSandbox = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.actorTools.noSandbox = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.sameEngineIdentity = false; }],
    ["uid_map", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.namespaceUid = 0; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.execution.noSandbox = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.capture.sameEngineIdentity = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.humanServices.sameEngineIdentity = false; }],
    ["engine_lifecycle", (tree: ReturnType<typeof fixture>) => { tree.qualification.actorTools.sameEngineIdentity = false; }],
    ["finite_resources", (tree: ReturnType<typeof fixture>) => { tree.limits.finite = false; }],
    ["cgroup_controllers", (tree: ReturnType<typeof fixture>) => { tree.limits.hierarchy[0].path = "/zeros-cloud-engine"; }],
    ["cgroup_controllers", (tree: ReturnType<typeof fixture>) => tree.write(`${tree.descriptor.cgroupRoot}/cgroup.subtree_control`, "cpu")],
    ["setup_exit", (tree: ReturnType<typeof fixture>) => { tree.setupQualification.hostUid = 0; }],
    ["setup_exit", (tree: ReturnType<typeof fixture>) => { tree.setupQualification.detachedDescendantsRetired = false; }],
    ["setup_exit", (tree: ReturnType<typeof fixture>) => { tree.setupQualification.timeoutRetired = false; }],
  ] as const)("retains credential-free engine/setup qualification: %s", (check, change) => {
    const tree = fixture(); change(tree); failed(tree, check);
  });
  it("measures allocation from the delegated subtree and its ancestors, outside the SSH scope", () => {
    const tree = fixture();
    tree.write("/sys/fs/cgroup/ssh.scope/cpu.max", "10000 100000");
    tree.write("/sys/fs/cgroup/system.slice/cpu.max", "200000 100000");
    tree.write(`${tree.descriptor.cgroupRoot}/memory.max`, String(4 * 1024 ** 3));
    tree.write(`${tree.descriptor.cgroupRoot}/engine-runtime/memory.max`, String(3 * 1024 ** 3));
    tree.write("/run/zeros/cloud-resource-contract.json", { version: 1,
      resources: { architecture: "linux/amd64", cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } }, 0o600);
    tree.limits.memoryBudget.nominalMemoryBytes = String(4 * 1024 ** 3);
    tree.refreshLimits();
    tree.limits.cpuSplit.workload.cap.cpuMax = "150000 100000";
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.split("\n")[0]).resources.allocation).toMatchObject({ cpuMillicores: 2000, memoryBytes: 4 * 1024 ** 3 });
  });
  it("rejects unlimited captured CPU against the genuine nominal SKU", () => {
    const tree = fixture();
    tree.write(`${tree.descriptor.cgroupRoot}/engine-runtime/cpu.max`, "max 100000"); tree.refreshLimits();
    failed(tree, "finite_resources");
  });
  it.each(["cpuset_unavailable", "cpuset_invalid", "memory_unavailable", "memory_invalid"])("projects only the closed cap fallback %s", diagnostic => {
    const tree = fixture();
    Object.assign(tree.limits.cpuSplit.workload, { cap: { kind: "skipped", cpuMax: "max 100000", diagnostic } });
    tree.limits.memoryBudget.source = "fallback";
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
  });
  it("projects the genuine applied memory budget into the strict v2 report", () => {
    const tree = fixture(), result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.resources.memoryBudget).toEqual(tree.limits.memoryBudget);
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
  });
  it("admits ordinary MemTotal overhead through the actual nominal-budget report and strict reader", () => {
    const tree = fixture(); tree.write("/proc/meminfo", "MemTotal: 8131788 kB\n");
    tree.limits.memoryBudget.measuredMemoryBytes = String(8131788 * 1024);
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.resources.memoryMax).toBe(String(7 * 1024 ** 3));
    expect(report.resources.allocation.memoryBytes).toBe(8131788 * 1024);
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
  });
  it("records the actual host-ceiling cap through the generated report and strict reader", () => {
    const tree = fixture(), memory = 8131788 * 1024;
    tree.write("/proc/meminfo", "MemTotal: 8131788 kB\n");
    tree.write(`${tree.descriptor.cgroupRoot}/host/memory.max`, String(1024 ** 3));
    tree.write(`${tree.descriptor.cgroupRoot}/engine-runtime/memory.max`, String(memory - 1024 ** 3));
    Object.assign(tree.limits.memoryBudget, { measuredMemoryBytes: String(memory), hostMemoryMax: String(1024 ** 3), capped: true });
    tree.refreshLimits();
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.resources.memoryBudget).toEqual(tree.limits.memoryBudget);
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
  });
  it("scales a genuine sixteen GiB nominal contract to fifteen GiB despite measured overhead", () => {
    const tree = fixture(), memory = Math.floor(16 * 1024 ** 3 * 0.98 / 1024) * 1024;
    tree.write("/proc/meminfo", `MemTotal: ${memory / 1024} kB\n`);
    tree.write(`${tree.descriptor.cgroupRoot}/engine-runtime/memory.max`, String(15 * 1024 ** 3));
    tree.write("/run/zeros/cloud-resource-contract.json", { version: 1,
      resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 16384, storageMiB: 20480 } }, 0o600);
    Object.assign(tree.limits.memoryBudget, { nominalMemoryBytes: String(16 * 1024 ** 3), measuredMemoryBytes: String(memory) });
    tree.refreshLimits();
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.resources.memoryMax).toBe(String(15 * 1024 ** 3));
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: 4000, memoryMiB: 16384, storageMiB: 20480 })).not.toBeNull();
  });
  it.each([1, 2, 4, 8, 16])("publishes exact main fallback on an actual sufficient %i CPU allocation without applying the nominal ceiling", cpus => {
    const tree = fixture(4, { availableCPUs: cpus }), memory = 8131788 * 1024;
    tree.write("/proc/meminfo", "MemTotal: 8131788 kB\n");
    tree.write(`${tree.descriptor.cgroupRoot}/host/memory.max`, String(1024 ** 3));
    tree.write("/run/zeros/cloud-resource-contract.json", { version: 1,
      resources: { architecture: "linux/amd64", cpuMillicores: cpus * 1000, memoryMiB: 8192, storageMiB: 20480 } }, 0o600);
    Object.assign(tree.limits.memoryBudget, { measuredMemoryBytes: String(memory), hostMemoryMax: String(1024 ** 3),
      source: "fallback", capped: false });
    Object.assign(tree.limits.cpuSplit.workload, { cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "cpuset_unavailable" } });
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.split("\n")[0]);
    expect(report.resources).toMatchObject({ cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
      allocation: { cpuMillicores: cpus * 1000 }, memoryBudget: tree.limits.memoryBudget });
    expect(verifyRuntimeTransferReport(report, report.runtime, { cpuMillicores: cpus * 1000, memoryMiB: 8192, storageMiB: 20480 })).not.toBeNull();
  });
  it("refuses nominal captured CPU that differs from the genuine root SKU", () => {
    const tree = fixture(4, { availableCPUs: 8 });
    tree.write("/run/zeros/cloud-resource-contract.json", { version: 1,
      resources: { architecture: "linux/amd64", cpuMillicores: 8000, memoryMiB: 8192, storageMiB: 20480 } }, 0o600);
    failed(tree, "finite_resources");
  });
  it.each(["nominal", "host", "measurement", "mode", "missing", "malformed"])("refuses a captured budget that lost its original %s provenance", kind => {
    const tree = fixture();
    if (kind === "nominal") tree.write("/run/zeros/cloud-resource-contract.json", { version: 1,
      resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 16384, storageMiB: 20480 } }, 0o600);
    if (kind === "host") tree.write(`${tree.descriptor.cgroupRoot}/host/memory.max`, String(1024 ** 3));
    if (kind === "measurement") tree.write("/proc/meminfo", "MemTotal: 8131788 kB\n");
    if (kind === "mode") fs.chmodSync(tree.physical("/run/zeros/cloud-resource-contract.json"), 0o644);
    if (kind === "missing") fs.unlinkSync(tree.physical("/run/zeros/cloud-resource-contract.json"));
    if (kind === "malformed") tree.write("/run/zeros/cloud-resource-contract.json", { version: 1, resources: {} }, 0o600);
    failed(tree, kind === "mode" ? "file_mode" : "finite_resources");
  });
  it("keeps an actually undersized parent negative even when the raw MemTotal and SKU are valid", () => {
    const tree = fixture(); tree.write(`${tree.descriptor.cgroupRoot}/memory.max`, String(7 * 1024 ** 3 - 1));
    tree.refreshLimits(); failed(tree, "finite_resources");
  });
  it.each([
    { engine: { cpuMax: "400000 100000", cpuWeight: 100 } },
    { workload: { controllers: ["cpu", "memory"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300000 100000" } } },
    { workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "applied", effectiveCpus: 4, cpuMax: "300001 100000" } } },
    { workload: { controllers: ["cpu"], cpuWeight: 100, cap: { kind: "skipped", cpuMax: "max 100000", diagnostic: "private error" } } },
  ])("refuses malformed or contradictory CPU split %j", change => {
    const tree = fixture(); Object.assign(tree.limits.cpuSplit, change); failed(tree, "finite_resources");
  });
  it("invalidates an earlier proof before failed re-attestation", () => {
    const tree = fixture(); expect(tree.execute().exitCode).toBe(0);
    tree.write(`${tree.root}/manifest.json`, "{}"); failed(tree, "manifest_digest");
  });
  it("rejects a supervisor restart during qualification before publishing a proof", () => {
    const tree = fixture();
    tree.setSpawn(() => {
      tree.write(activePath, { ...tree.descriptor, supervisorSessionId: "32345678-1234-4234-8234-123456789abc" }, 0o600);
    });
    failed(tree, "active_descriptor");
  });
  it.each([
    ["engine_lifecycle", { status: 1 }], ["timeout", { status: null, error: { code: "ETIMEDOUT" } }],
    ["process_signal", { status: null, signal: "SIGTERM" }], ["diagnostic_missing", { status: 0 }],
  ] as const)("closes %s probe failures without forwarding output", (check, result) => {
    const tree = fixture();
    tree.setSpawn(() => ({ stdout: "private child output", stderr: "private exception and URL", ...result }));
    const diagnostic = failed(tree, check);
    expect(diagnostic.timedOut).toBe(check === "timeout");
  });
  it.each([
    ["lock_busy", { status: 75 }], ["timeout", { error: { code: "ETIMEDOUT" } }],
    ["process_signal", { signal: "SIGTERM" }], ["diagnostic_missing", { status: 1 }],
  ] as const)("closes outer lock/process failure: %s", (check, result) => {
    const tree = fixture();
    tree.setSpawn(() => ({ stdout: "private child output", stderr: "private process error", ...result }));
    failed(tree, check, []);
    expect(fs.readdirSync(tree.physical("/run/zeros")).some(name => name.startsWith(".attest-lock-"))).toBe(false);
  });
  it("forwards only a closed inner failure diagnostic", () => {
    const tree = fixture();
    const diagnostic = { schema: "zeros.diagnostic/v1", component: "attester", stage: "verify_tree", ok: false,
      exitCode: 1, timedOut: false, failedChecks: ["receipt_digest"] };
    tree.setSpawn(() => ({ status: 1, stdout: `private preceding output\n${JSON.stringify(diagnostic)}\n`, stderr: "private stderr" }));
    expect(failed(tree, "receipt_digest", [])).toEqual(diagnostic);
  });
});

import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { attestationFixture, activePath, compatibilityPath, digest, markerPath, proofPath } from "./cloud-worker-attestation-fixture";
import { ClosedDiagnosticSchema } from "../../packages/protocol/src/cloud-runtime-bundle";

const fixtures: ReturnType<typeof attestationFixture>[] = [];
function fixture(version = 4) { const value = attestationFixture(version); fixtures.push(value); return value; }
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
  it.each([1, 2, 3])("keeps the v%i report and launch proof byte-for-byte", version => {
    const tree = fixture(version), result = tree.execute();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchSnapshot();
    expect(fs.readFileSync(tree.physical(proofPath), "utf8")).toMatchSnapshot();
    expect(tree.execute("consume-cloud-admission.mjs")).toEqual({ stdout: "[cloud-admission] qualified runtime proof consumed\n", stderr: "", exitCode: 0 });
  });
  it.each([1, 2, 3])("keeps the v%i resolver's legacy ownership rejection", version => {
    const tree = fixture(version); tree.owners.set(markerPath, 10001);
    expect(() => tree.execute()).toThrow("Cloud runtime descriptor or installation is invalid");
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
    expect(report).toMatchObject({ version: 1, qualified: true, profile: "zeros-cloud-worker-v4", runtime: {
      runtimeId: tree.descriptor.runtimeId, manifestSha256: tree.descriptor.manifestSha256,
      baseCompatibilityId: tree.descriptor.baseCompatibilityId, installerReceiptSha256: tree.descriptor.installerReceiptSha256,
      bootId: tree.descriptor.bootId, supervisorSessionId: tree.descriptor.supervisorSessionId } });
    expect(diagnostic).toEqual({ schema: "zeros.diagnostic/v1", component: "attester", stage: "done", ok: true,
      exitCode: 0, timedOut: false, failedChecks: [] });
    expect(result.stdout).not.toMatch(/buildSha256|imageContract|sourceIntegrity|nativeInventory/);
    const proof = JSON.parse(fs.readFileSync(tree.physical(proofPath), "utf8"));
    expect(proof).toMatchObject({ version: 2, ...report.runtime, profile: report.profile });
    expect(proof).not.toHaveProperty("buildSha256");
    expect(tree.calls.filter(call => call.args.includes("--qualify")).map(call => call.args[0])).toEqual([
      `${tree.root}/lib/zeros/cloud-engine-launcher.mjs`, `${tree.root}/lib/zeros/cloud-setup-process.mjs`]);
    expect(tree.calls.every(call => call.file === `${tree.root}/bin/node`)).toBe(true);
    for (const call of tree.calls) expect(Object.keys(call.options.env as object).sort()).toEqual([
      "HOME", "PATH", "ZEROS_ZSR_QUALIFICATION_GID", "ZEROS_ZSR_QUALIFICATION_UID"]);
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
  it.each([
    ["uid_map", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.hostUid = 0; }],
    ["seccomp", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.noNewPrivs = 0; }],
    ["seccomp", (tree: ReturnType<typeof fixture>) => { tree.qualification.identity.seccompMode = 0; }],
    ["containment_smoke", (tree: ReturnType<typeof fixture>) => { tree.qualification.workload.secure = false; }],
    ["containment_smoke", (tree: ReturnType<typeof fixture>) => { tree.qualification.capture.secure = false; }],
    ["containment_smoke", (tree: ReturnType<typeof fixture>) => { tree.qualification.humanServices.secure = false; }],
    ["containment_smoke", (tree: ReturnType<typeof fixture>) => { tree.qualification.actorTools.secure = false; }],
    ["finite_resources", (tree: ReturnType<typeof fixture>) => { tree.limits.finite = false; }],
    ["cgroup_controllers", (tree: ReturnType<typeof fixture>) => { tree.limits.hierarchy[0].path = "/zeros-cloud-engine"; }],
    ["cgroup_controllers", (tree: ReturnType<typeof fixture>) => tree.write(`${tree.descriptor.cgroupRoot}/cgroup.subtree_control`, "cpu")],
    ["setup_exit", (tree: ReturnType<typeof fixture>) => { tree.setupQualification.secure = false; }],
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
    const result = tree.execute(); expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.split("\n")[0]).resources.allocation).toMatchObject({ cpuMillicores: 2000, memoryBytes: 4 * 1024 ** 3 });
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
    ["containment_smoke", { status: 1 }], ["timeout", { status: null, error: { code: "ETIMEDOUT" } }],
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

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSetupDiagnostic } from "../../apps/control-plane/src/cloud-workspaces/cloud-diagnostics";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { activePath, attestationFixture } from "./cloud-worker-attestation-fixture";

const host = vi.hoisted(() => ({ resolve: vi.fn(), spawn: vi.fn() }));
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async (original) => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: host.resolve,
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: host.spawn,
}));

const profile = { version: 4, profile: "zeros-cloud-worker-v4" };
const resources = { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 };
function material() {
  return {
    // Deliberately unrelated legacy image hashes: v4 binds the runtime witness.
    image: { ref: `boat:base-fixture@sha256:${"e".repeat(64)}`, sourceCommit: "e".repeat(40), resources },
    repository: { credential: { expiresAtMs: Date.now() + 60 * 60_000 } },
    engine: { registration: { expiresAtMs: Date.now() + 60 * 60_000 } },
  };
}

let tree: ReturnType<typeof attestationFixture>;
beforeEach(() => {
  vi.resetModules();
  tree = attestationFixture();
  host.resolve.mockReset().mockImplementation(createCloudRuntimeResolver({
    filesystem: tree.filesystem, executable: () => `${tree.root}/bin/node`, isEngine: () => false,
  }).resolve);
  host.spawn.mockReset();
});
afterEach(() => { tree.dispose(); });

function attesterOutput() {
  const result = tree.execute();
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  return { ...result, code: result.exitCode, timedOut: false, overflow: false };
}

function returnOutput(result: { stdout: string; stderr: string; code: number }) {
  host.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.end(Buffer.from(result.stdout));
      child.stderr.end(Buffer.from(result.stderr));
      child.emit("close", result.code, null);
    });
    return child;
  });
}

function rewriteReport(stdout: string, mutate: (report: Record<string, any>) => void) {
  const lines = stdout.trimEnd().split("\n"), report = JSON.parse(lines[0]);
  mutate(report);
  return `${JSON.stringify(report)}\n${lines[1]}\n`;
}
function rewriteDiagnostic(stdout: string, change: Record<string, unknown>) {
  const lines = stdout.trimEnd().split("\n");
  return `${lines[0]}\n${JSON.stringify({ ...JSON.parse(lines[1]), ...change })}\n`;
}

describe("v4 attester to setup admission", () => {
  it("returns closed stage clocks after proof publication and carries them through setup", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), diagnostic = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(diagnostic.timings.clocks[0].spans.map((span: any) => span.stage)).toEqual([
      "lock", "verify_tree", "qualify_engine", "run_setup", "publish_proof",
    ]);
    returnOutput(result);
    const recordTimings = vi.fn();
    await attestImage(material(), profile, vi.fn(), recordTimings);
    expect(recordTimings).toHaveBeenCalledWith(diagnostic.timings);
  });
  it("admits the real report against the resolver witness without legacy metadata", async () => {
    const { cloudWorkspaceImageAdmissionChecks } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), report = JSON.parse(result.stdout.split("\n")[0]);
    const checks = cloudWorkspaceImageAdmissionChecks(material(), profile, result, report);
    expect(Object.values(checks).every(value => value === true)).toBe(true);
    expect(checks).not.toHaveProperty("source");
    expect(checks).not.toHaveProperty("build");
  });

  it("feeds the attester's exact two-line stdout through the real setup caller", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), record = vi.fn();
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(2);
    returnOutput(result);
    await expect(attestImage(material(), profile, record)).resolves.toBeUndefined();
    expect(host.spawn).toHaveBeenCalledWith(`${tree.root}/bin/node`, [`${tree.root}/lib/zeros/attest-cloud-worker.mjs`], expect.any(Object));
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toEqual({ execution: true, report: true, profile: true, qualified: true,
      metadata: true, helpers: true, resources: true, runtime: true });
    expect(record.mock.calls[0][1]).toMatchObject({ identity: true, workload: true, capture: true,
      humanServices: true, setup: { secure: true, unprivileged: true, detachedDescendantsRetired: true, timeoutRetired: true } });
  });

  it("rejects the attester's actual closed failure without legacy inventory diagnostics", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    tree.write(`${tree.root}.incomplete`, "", 0o600);
    const result = tree.execute(), record = vi.fn();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, failedChecks: ["file_inventory"] });
    returnOutput({ ...result, code: result.exitCode });
    await expect(attestImage(material(), profile, record)).rejects.toMatchObject({ code: "image_contract_invalid" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ execution: false, report: false });
    const diagnostic = { version: 1, phase: "image_preflight", checks: record.mock.calls[0][0] };
    expect(parseSetupDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it.each([1, 2, 3])("refuses worker v%i before attestation or material access", async version => {
    tree.dispose();
    tree = attestationFixture(version);
    host.resolve.mockImplementation(createCloudRuntimeResolver({
      filesystem: tree.filesystem, executable: () => "/usr/local/bin/node", isEngine: () => false,
    }).resolve);
    await expect(import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs"))
      .rejects.toThrow(/runtime descriptor/);
    expect(host.spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["missing diagnostic", (stdout: string) => `${stdout.split("\n")[0]}\n`],
    ["diagnostic only", (stdout: string) => `${stdout.split("\n")[1]}\n`],
    ["reversed lines", (stdout: string) => `${stdout.trimEnd().split("\n").reverse().join("\n")}\n`],
    ["leading output", (stdout: string) => `private output\n${stdout}`],
    ["trailing output", (stdout: string) => `${stdout}private output\n`],
    ["extra report", (stdout: string) => `${stdout.split("\n")[0]}\n${stdout}`],
    ["truncated diagnostic", (stdout: string) => stdout.slice(0, -3)],
    ["wrong component", (stdout: string) => rewriteDiagnostic(stdout, { component: "installer" })],
    ["wrong schema", (stdout: string) => rewriteDiagnostic(stdout, { schema: "future" })],
    ["unfinished stage", (stdout: string) => rewriteDiagnostic(stdout, { stage: "verify_tree" })],
    ["unknown stage", (stdout: string) => rewriteDiagnostic(stdout, { stage: "private output" })],
    ["failed diagnostic", (stdout: string) => rewriteDiagnostic(stdout, { ok: false, exitCode: 1, failedChecks: ["receipt_digest"] })],
    ["exit mismatch", (stdout: string) => rewriteDiagnostic(stdout, { exitCode: 1 })],
    ["timeout", (stdout: string) => rewriteDiagnostic(stdout, { timedOut: true })],
    ["failed check on success", (stdout: string) => rewriteDiagnostic(stdout, { failedChecks: ["receipt_digest"] })],
    ["free-text diagnostic", (stdout: string) => rewriteDiagnostic(stdout, { error: "private output" })],
    ["duplicate diagnostic key", (stdout: string) => stdout.replace('"ok":true', '"ok":false,"ok":true')],
    ["duplicate report key", (stdout: string) => stdout.replace('"qualified":true', '"qualified":false,"qualified":true')],
  ] as const)("rejects %s without retaining child output", async (_name, corrupt) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), record = vi.fn();
    returnOutput({ ...result, stdout: corrupt(result.stdout) });
    await expect(attestImage(material(), profile, record)).rejects.toMatchObject({ code: "image_contract_invalid" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].report).toBe(false);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private output");
  });

  it.each([
    ["runtimeId", `r1-${"f".repeat(64)}`], ["manifestSha256", "f".repeat(64)],
    ["baseCompatibilityId", `bc1-${"f".repeat(64)}`], ["installerReceiptSha256", "f".repeat(64)],
    ["bootId", "32345678-1234-4234-8234-123456789abc"], ["supervisorSessionId", "32345678-1234-4234-8234-123456789abc"],
  ])("rejects a report with mismatched %s", async (field, value) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), record = vi.fn();
    returnOutput({ ...result, stdout: rewriteReport(result.stdout, report => { report.runtime[field] = value; }) });
    await expect(attestImage(material(), profile, record)).rejects.toMatchObject({ code: "image_contract_invalid" });
    expect(record.mock.calls[0][0]).toMatchObject({ report: true, metadata: false });
  });

  it("pins the redemption witness across a supervisor restart before attestation", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    tree.write(activePath, { ...tree.descriptor, supervisorSessionId: "32345678-1234-4234-8234-123456789abc" }, 0o600);
    const result = attesterOutput(), record = vi.fn();
    returnOutput(result);
    await expect(attestImage(material(), profile, record)).rejects.toMatchObject({ code: "image_contract_invalid" });
    expect(record.mock.calls[0][0]).toMatchObject({ report: true, metadata: false });
  });

  it.each([
    ["report", (report: Record<string, any>) => { report.version = 2; }],
    ["profile", (report: Record<string, any>) => { report.profile = "zeros-cloud-worker-v3"; }],
    ["qualified", (report: Record<string, any>) => { report.qualified = false; }],
    ["helpers", (report: Record<string, any>) => { report.helpers.deploymentTrusted.setupHelper = false; }],
    ["helpers", (report: Record<string, any>) => { report.helpers.deploymentTrusted.workerSupervisor = false; }],
    ["resources", (report: Record<string, any>) => { report.resources.finite = false; }],
    ["resources", (report: Record<string, any>) => { report.resources.allocation.cpuMillicores = 1000; }],
    ["runtime", (report: Record<string, any>) => { report.qualification.secure = false; }],
  ] as const)("retains the %s admission gate", async (gate, corrupt) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), record = vi.fn();
    returnOutput({ ...result, stdout: rewriteReport(result.stdout, corrupt) });
    await expect(attestImage(material(), profile, record)).rejects.toMatchObject({ code: "image_contract_invalid" });
    expect(record.mock.calls[0][0][gate]).toBe(false);
  });

  it.each([{ code: 1 }, { timedOut: true }, { overflow: true }])("retains execution checks: %j", async change => {
    const { cloudWorkspaceImageAdmissionChecks } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), report = JSON.parse(result.stdout.split("\n")[0]);
    expect(cloudWorkspaceImageAdmissionChecks(material(), profile, { ...result, ...change }, report).execution).toBe(false);
  });
});

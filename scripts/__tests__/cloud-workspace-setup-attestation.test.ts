import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSetupDiagnostic } from "../../apps/control-plane/src/cloud-workspaces/cloud-diagnostics";
import { CloudWorkspaceLinuxSetupExecutor } from "../../apps/control-plane/src/cloud-workspaces/linux-setup-executor";
import type { CloudWorkspaceSetupExecution } from "../../apps/control-plane/src/cloud-workspaces/setup-worker";
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

function subprobePerformance() {
  return { version: 1, truncated: false, groups: [{ source: "attester_preflight", stages: [
    { stage: "actor_tools", count: 1, totalMs: 31, maxMs: 31, lastOutcome: "passed" },
  ] }] };
}

function wrapCompletion(stdout: string, performance: unknown = subprobePerformance()) {
  const lines = stdout.trimEnd().split("\n");
  lines[lines.length - 1] = JSON.stringify({ schema: "zeros.diagnostic/v2",
    diagnostic: JSON.parse(lines.at(-1)!), performance });
  return `${lines.join("\n")}\n`;
}

async function classifyBoatFailure(diagnostic: unknown) {
  const input: CloudWorkspaceSetupExecution = {
    setupRunId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
    organizationId: "33333333-3333-4333-8333-333333333333", generation: 1, attempt: 1, executionFence: 1,
    authority: { accountUserId: "44444444-4444-4444-8444-444444444444" },
    provider: { name: "boat", resourceId: "sandbox-fixture" }, image: { ref: "snapshot-fixture", sourceCommit: "a".repeat(40) },
    repository: { forge: "github.com", owner: "fixture", name: "repo", revision: "main",
      githubInstallationId: "55555555-5555-4555-8555-555555555555" },
    settings: { version: 1, snapshot: { schemaVersion: 1, values: {} }, sha256: "b".repeat(64) },
  };
  const grant = { id: "66666666-6666-4666-8666-666666666666", token: `zws_${"A".repeat(43)}`,
    endpoint: "https://control.example.test/v1/internal/cloud-workspaces/setup", expiresAt: new Date(Date.now() + 60_000),
    setupRunId: input.setupRunId, workspaceId: input.workspaceId, organizationId: input.organizationId,
    generation: input.generation, executionFence: input.executionFence };
  const revoke = vi.fn(async () => {});
  const executor = new CloudWorkspaceLinuxSetupExecutor({
    admissionBroker: { issue: async () => grant, revoke }, runtimeArtifacts: null, engineProtocolVersion: 1, timeoutSeconds: 300,
    commandRunner: { execute: async () => ({ exitCode: 1, outputTruncated: false,
      output: JSON.stringify({ version: 2, audience: "zeros-cloud-workspace-setup-result-v1", outcome: "error",
        code: "image_contract_invalid", diagnostic }) }) },
  });
  const failure = await executor.execute(input, new AbortController().signal).catch((error: unknown) => error);
  expect(revoke).toHaveBeenCalledWith(grant, "failed");
  return failure;
}

describe("v4 attester to setup admission", () => {
  it("keeps negotiated subprobe measurements outside the exact one-use proof", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const baseline = attesterOutput(), originalProof = JSON.parse(tree.filesystem.readFileSync("/run/zeros/cloud-worker-admission.json", "utf8"));
    const performance = { version: 1, truncated: false, groups: [{ source: "attester_preflight", stages: [
      { stage: "actor_tools", count: 1, totalMs: 31, maxMs: 31, lastOutcome: "passed" },
    ] }] };
    Object.assign(tree.qualification, { performance });
    tree.write("/run/zeros/.test-lock", "e".repeat(64), 0o600);
    const measured = tree.execute("attest-cloud-worker.mjs", ["--engine-lock-held", "/run/zeros/.test-lock", "--performance"]);
    expect(measured.exitCode).toBe(0);
    const lines = measured.stdout.trim().split("\n"), envelope = JSON.parse(lines[1]);
    expect(lines[0]).toBe(baseline.stdout.split("\n")[0]);
    expect(JSON.parse(tree.filesystem.readFileSync("/run/zeros/cloud-worker-admission.json", "utf8"))).toEqual(originalProof);
    expect(envelope.schema).toBe("zeros.diagnostic/v2");
    expect(envelope.performance).toEqual(performance);
    expect(envelope.diagnostic).toMatchObject({ schema: "zeros.diagnostic/v1", ok: true });
    returnOutput({ ...measured, code: measured.exitCode });
    const recordPerformance = vi.fn();
    await (attestImage as any)(material(), profile, vi.fn(), vi.fn(), recordPerformance);
    expect(recordPerformance).toHaveBeenCalledWith(performance);
    expect(host.spawn).toHaveBeenCalledWith(`${tree.root}/bin/node`, [`${tree.root}/lib/zeros/attest-cloud-worker.mjs`, "--performance"], expect.any(Object));
  });

  it.each([
    ["incomplete inventory", "file_inventory", true],
    ["missing manifest", "root_ownership", true],
    ["seccomp", "seccomp", false],
    ["engine spawn EAGAIN", "engine_lifecycle", true],
    ["setup spawn EAGAIN", "setup_exit", true],
  ] as const)("preserves the closed %s refusal and retry decision inside a performance envelope", async (fault, check, retryable) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    if (fault === "incomplete inventory") tree.write(`${tree.root}.incomplete`, "", 0o600);
    else if (fault === "missing manifest") unlinkSync(tree.physical(`${tree.root}/manifest.json`));
    else if (fault === "seccomp") tree.qualification.identity.seccompMode = 0;
    else tree.setSpawn((_file, args) => args[0]?.endsWith(fault === "engine spawn EAGAIN"
      ? "cloud-engine-launcher.mjs" : "cloud-setup-process.mjs")
      ? { status: null, signal: null, error: { code: "EAGAIN" }, stdout: "", stderr: "" } : undefined);
    const result = tree.execute();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).failedChecks).toEqual([check]);
    returnOutput({ ...result, code: result.exitCode });
    const legacyChecks = vi.fn(), legacyTimings = vi.fn();
    const legacy = await attestImage(material(), profile, legacyChecks, legacyTimings).catch((error: any) => error);

    returnOutput({ ...result, code: result.exitCode, stdout: wrapCompletion(result.stdout) });
    const recordChecks = vi.fn(), recordTimings = vi.fn(), recordPerformance = vi.fn();
    const wrapped = await (attestImage as any)(material(), profile, recordChecks, recordTimings, recordPerformance)
      .catch((error: any) => error);
    expect(wrapped).toMatchObject({ code: "image_contract_invalid", diagnostic: legacy.diagnostic });
    expect(recordChecks.mock.calls).toEqual(legacyChecks.mock.calls);
    expect(recordTimings.mock.calls).toEqual(legacyTimings.mock.calls);
    expect(recordPerformance).toHaveBeenCalledWith(subprobePerformance());
    const diagnostic = { version: 1, phase: "image_preflight", ...wrapped.diagnostic };
    await expect(classifyBoatFailure(diagnostic)).resolves.toMatchObject({
      code: "setup_image_contract_invalid", retryable, diagnostic,
    });
  });

  it.each([
    ["extra output", (stdout: string) => `private-canary\n${stdout}`],
    ["extra envelope field", (stdout: string) => JSON.stringify({ ...JSON.parse(stdout), message: "private-canary" }) + "\n"],
    ["wrong exit", (stdout: string) => stdout.replace('"exitCode":1', '"exitCode":0')],
    ["unknown check", (stdout: string) => stdout.replace('"file_inventory"', '"private-canary"')],
    ["duplicate diagnostic key", (stdout: string) => stdout.replace('"ok":false', '"ok":true,"ok":false')],
    ["duplicate envelope key", (stdout: string) => stdout.replace('"schema":"zeros.diagnostic/v2"',
      '"schema":"zeros.diagnostic/v1","schema":"zeros.diagnostic/v2"')],
  ])("rejects a wrapped failure with %s before projecting diagnostics or measurements", async (_name, corrupt) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    tree.write(`${tree.root}.incomplete`, "", 0o600);
    const result = tree.execute(), recordChecks = vi.fn(), recordTimings = vi.fn(), recordPerformance = vi.fn();
    expect(result.exitCode).toBe(1);
    returnOutput({ ...result, code: result.exitCode, stdout: corrupt(wrapCompletion(result.stdout)) });
    const error = await (attestImage as any)(material(), profile, recordChecks, recordTimings, recordPerformance)
      .catch((failure: any) => failure);
    expect(error.code).toBe("image_contract_invalid");
    expect(error.diagnostic.attester).toBeUndefined();
    expect(recordTimings).not.toHaveBeenCalled();
    expect(recordPerformance).not.toHaveBeenCalled();
    expect(JSON.stringify([error, recordChecks.mock.calls])).not.toContain("private-canary");
  });

  it.each([null, { message: "private-canary" }, { ...subprobePerformance(), truncated: "private-canary" }])(
    "keeps malformed optional performance outside successful admission: %j", async performance => {
      const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
      const result = attesterOutput(), recordTimings = vi.fn(), recordPerformance = vi.fn();
      returnOutput({ ...result, stdout: wrapCompletion(result.stdout, performance) });
      await expect((attestImage as any)(material(), profile, vi.fn(), recordTimings, recordPerformance))
        .resolves.toBeUndefined();
      expect(recordTimings).toHaveBeenCalledWith(JSON.parse(result.stdout.trimEnd().split("\n")[1]).timings);
      expect(recordPerformance).not.toHaveBeenCalled();
    });

  it("keeps throwing timing and performance observers outside wrapped admission", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    const result = attesterOutput(), recordPerformance = vi.fn(() => { throw new Error("private-canary"); });
    returnOutput({ ...result, stdout: wrapCompletion(result.stdout) });
    await expect((attestImage as any)(material(), profile, vi.fn(),
      () => { throw new Error("private-canary"); }, recordPerformance)).resolves.toBeUndefined();
    expect(recordPerformance).toHaveBeenCalledOnce();
  });

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
  it("keeps a timing observer failure outside admission", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    returnOutput(attesterOutput());
    await expect(attestImage(material(), profile, vi.fn(), () => { throw new Error("private-observer-canary"); }))
      .resolves.toBeUndefined();
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
      humanServices: true, setup: { hostUid: 10003, hostGid: 10003, detachedDescendantsRetired: true, timeoutRetired: true } });
  });

  it("rejects the attester's actual closed failure without legacy inventory diagnostics", async () => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    tree.write(`${tree.root}.incomplete`, "", 0o600);
    const result = tree.execute(), record = vi.fn();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, failedChecks: ["file_inventory"] });
    returnOutput({ ...result, code: result.exitCode });
    const error = await attestImage(material(), profile, record).catch((failure: unknown) => failure);
    const attester = { stage: "verify_tree", failedChecks: ["file_inventory"] };
    expect(error).toMatchObject({ code: "image_contract_invalid", diagnostic: { attester } });
    expect(JSON.stringify(error)).not.toContain(tree.root);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({ execution: false, report: false });
    const diagnostic = { version: 1, phase: "image_preflight", checks: record.mock.calls[0][0], attester };
    expect(parseSetupDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it.each(["missing manifest", "engine spawn EAGAIN", "setup spawn EAGAIN"])(
    "keeps %s retryable through attestation, setup and the Boat executor", async fault => {
      // Resolve the unchanged installed witness before the transient fault.
      const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
      if (fault === "missing manifest") unlinkSync(tree.physical(`${tree.root}/manifest.json`));
      else tree.setSpawn((_file, args) => args[0]?.endsWith(fault === "engine spawn EAGAIN"
        ? "cloud-engine-launcher.mjs" : "cloud-setup-process.mjs")
        ? { status: null, signal: null, error: { code: "EAGAIN" }, stdout: "", stderr: "" } : undefined);
      const result = tree.execute();
      expect(result.exitCode).toBe(1);
      const closed = JSON.parse(result.stdout);
      expect(closed.failedChecks).toEqual([fault === "missing manifest" ? "root_ownership"
        : fault === "engine spawn EAGAIN" ? "engine_lifecycle" : "setup_exit"]);
      returnOutput({ ...result, code: result.exitCode });
      const error = await attestImage(material(), profile, vi.fn()).catch((failure: any) => failure);
      const attester = { stage: closed.stage, failedChecks: closed.failedChecks };
      expect(error).toMatchObject({ code: "image_contract_invalid", diagnostic: { attester } });

      // Retry the identical inventory/probe after removing only the fault.
      // No attestation check, installed pin or qualification result is relaxed.
      if (fault === "missing manifest") tree.write(`${tree.root}/manifest.json`, tree.manifest);
      else tree.setSpawn(() => undefined);
      returnOutput(attesterOutput());
      await expect(attestImage(material(), profile, vi.fn())).resolves.toBeUndefined();
      const diagnostic = { version: 1, phase: "image_preflight", ...error.diagnostic };
      await expect(classifyBoatFailure(diagnostic)).resolves.toMatchObject({
        code: "setup_image_contract_invalid", retryable: true, diagnostic,
      });
    });

  it.each([
    ["root_ownership", (value: typeof tree) => { value.owners.set(`${value.root}/worker/package.json`, 10003); }, true],
    ["seccomp", (value: typeof tree) => { value.qualification.identity.seccompMode = 0; }, false],
    ["uid_map", (value: typeof tree) => { value.qualification.identity.hostUid = 0; }, false],
    ["engine_lifecycle", (value: typeof tree) => { value.qualification.execution.vmWorkloadDrain = false; }, true],
  ] as const)("keeps a real %s refusal closed while classifying retry evidence", async (check, change, retryable) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    change(tree);
    const result = tree.execute();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).failedChecks).toEqual([check]);
    returnOutput({ ...result, code: result.exitCode });
    const error = await attestImage(material(), profile, vi.fn()).catch((failure: any) => failure);
    const diagnostic = { version: 1, phase: "image_preflight", ...error.diagnostic };
    await expect(classifyBoatFailure(diagnostic)).resolves.toMatchObject({
      code: "setup_image_contract_invalid", retryable, diagnostic,
    });
  });

  it.each([
    ["extra field", (value: Record<string, unknown>) => JSON.stringify({ ...value, message: "private-canary" })],
    ["unknown stage", (value: Record<string, unknown>) => JSON.stringify({ ...value, stage: "private-canary" })],
    ["unknown check", (value: Record<string, unknown>) => JSON.stringify({ ...value, failedChecks: ["private-canary"] })],
    ["duplicate check", (value: Record<string, unknown>) => JSON.stringify({ ...value, failedChecks: ["file_inventory", "file_inventory"] })],
    ["duplicate key", (value: Record<string, unknown>) => JSON.stringify(value).replace('"ok":false', '"ok":true,"ok":false')],
    ["wrong component", (value: Record<string, unknown>) => JSON.stringify({ ...value, component: "installer" })],
    ["extra output", (value: Record<string, unknown>) => `private-canary\n${JSON.stringify(value)}`],
    ["wrong exit", (value: Record<string, unknown>) => JSON.stringify({ ...value, exitCode: 0 })],
  ])("does not retain malformed failed attester output: %s", async (_name, corrupt) => {
    const { attestImage } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
    tree.write(`${tree.root}.incomplete`, "", 0o600);
    const result = tree.execute(), record = vi.fn();
    returnOutput({ ...result, code: result.exitCode, stdout: corrupt(JSON.parse(result.stdout)) + "\n" });
    const error = await attestImage(material(), profile, record).catch((failure: any) => failure);
    expect(error.code).toBe("image_contract_invalid");
    expect(error.diagnostic.attester).toBeUndefined();
    expect(JSON.stringify([error, record.mock.calls])).not.toContain("private-canary");
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
    ["report", (report: Record<string, any>) => { report.version = 1; }],
    ["profile", (report: Record<string, any>) => { report.profile = "zeros-cloud-worker-v3"; }],
    ["qualified", (report: Record<string, any>) => { report.qualified = false; }],
    ["helpers", (report: Record<string, any>) => { report.helpers.deploymentTrusted.setupHelper = false; }],
    ["helpers", (report: Record<string, any>) => { report.helpers.deploymentTrusted.hostProcessSupervisor = false; }],
    ["resources", (report: Record<string, any>) => { report.resources.finite = false; }],
    ["resources", (report: Record<string, any>) => { report.resources.allocation.cpuMillicores = 1000; }],
    ["runtime", (report: Record<string, any>) => { report.qualification.execution.ownedProcessGroups = false; }],
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

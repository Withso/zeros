import { describe, expect, it, vi } from "vitest";
import * as attester from "../cloud-workspace-validation/sandbox/attest-cloud-worker.mjs";
import * as consumer from "../cloud-workspace-validation/sandbox/consume-cloud-admission.mjs";
import { bootFixture, hash } from "./cloud-boot-admission-fixture";

function attest(f: ReturnType<typeof bootFixture>, options: object = {}) {
  expect(attester.attestSelectedCloudWorker, "dormant selected attestation entry").toBeTypeOf("function");
  return attester.attestSelectedCloudWorker({ ...f.options, ...options }, f.ports);
}
function consume(f: ReturnType<typeof bootFixture>, options: object = {}) {
  expect(consumer.consumeSelectedCloudAdmission, "independently fenced v3 consumer").toBeTypeOf("function");
  return consumer.consumeSelectedCloudAdmission({ ...f.options, ...options }, f.ports);
}

describe("dormant build admission", () => {
  it.each([undefined, { mode: "full" }])("supported old runtime keeps original full path and shape: %j", async selection => {
    const f = bootFixture();
    await expect(attest(f, { selection })).resolves.toEqual({ version: 2 });
    expect(f.ports.fullAttest).toHaveBeenCalledOnce(); expect(f.verifyBuildQualification).not.toHaveBeenCalled();
    await expect(consume(f, { selection })).resolves.toEqual({ version: 2 });
    expect(f.ports.fullConsume).toHaveBeenCalledOnce(); expect(f.verifyBuildQualification).not.toHaveBeenCalled();
  });
  it.each([null, {}, { mode: "future" }, { mode: "full", fallback: true }, { mode: "build" }])(
    "selected_build_missing_or_malformed_never_falls_back: %j", async selection => {
      const f = bootFixture(); await expect(attest(f, { selection })).rejects.toThrow();
      expect(f.ports.fullAttest).not.toHaveBeenCalled(); expect(f.store.publish).not.toHaveBeenCalled();
    });
  it("has no passing production verifier or current-attempt default", async () => {
    for (const missing of ["verifyBuildQualification", "readAttempt"]) {
      const f = bootFixture(); await expect(attest(f, { [missing]: undefined })).rejects.toThrow();
      expect(f.ports.runProbe).not.toHaveBeenCalled(); expect(f.store.publish).not.toHaveBeenCalled();
    }
  });
  it.each(["ENOENT", "unsupported_base", "changed_kernel", "missing_integrity"])("refuses base failure %s without downgrade", async code => {
    const f = bootFixture(); f.verifyBuildQualification.mockRejectedValue(Object.assign(new Error("fixture refusal"), { code }));
    await expect(attest(f)).rejects.toThrow(); expect(f.ports.fullAttest).not.toHaveBeenCalled();
    expect(f.ports.runProbe).not.toHaveBeenCalled(); expect(f.store.publish).not.toHaveBeenCalled();
  });
  it("separates historical qualification from fresh checks and pins both verifier calls", async () => {
    const f = bootFixture(); const report = await attest(f);
    expect(report).toMatchObject({ version: 3, qualified: true, reusedBuild: { qualificationId: f.selection.qualificationId,
      evidenceSha256: f.selection.evidenceSha256, reportSha256: f.selection.evidence.reportSha256,
      qualifiedAtMs: Date.parse(f.selection.evidence.qualifiedAt) }, bootCheck: { schema: "zeros.cloud-boot-check/v1",
      runtime: f.runtime, attempt: f.attempt, probe: f.probe } });
    expect(report).not.toHaveProperty("qualification.actorTools");
    expect(f.proof).toMatchObject({ version: 3, reportSha256: f.selection.evidence.reportSha256,
      qualifiedAtMs: Date.parse(f.selection.evidence.qualifiedAt), checkedAtMs: f.ports.now(),
      selectionSha256: hash(f.selection), kernelSha256: hash(f.selection.evidence.kernel), bootCheckSha256: hash(report.bootCheck) });
    expect(f.verifyBuildQualification).toHaveBeenCalledTimes(2);
    for (const [value] of f.verifyBuildQualification.mock.calls) expect(value).toEqual({ selection: f.selection, runtime: f.runtime });
    expect(f.store.clear).toHaveBeenCalledOnce(); expect(f.ports.fullAttest).not.toHaveBeenCalled();
  });
  it.each(["runtimeId", "manifestSha256", "installerReceiptSha256", "baseCompatibilityId", "bootId", "supervisorSessionId", "cgroupRoot"])(
    "post_io_runtime_receipt_boot_or_supervisor_change_refuses: %s", async field => {
      const f = bootFixture(); f.ports.runProbe.mockImplementation(async () => { f.installation[field] = "changed"; return f.probe; });
      await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
    });
  it.each(["qualificationId", "evidenceSha256", "bootIntegritySha256", "kernelSha256", "runtime", "extra"])(
    "wrong_build_org_snapshot_or_verifier_identity_refuses: %s", async field => {
      const f = bootFixture(); const good = await f.verifyBuildQualification();
      f.verifyBuildQualification.mockResolvedValue({ ...good, [field]: field === "runtime" ? { ...f.runtime, bootId: f.selection.evidence.builder.bootId } : "wrong" });
      await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
    });
  it("rejects a different organization even with internally consistent build digests", async () => {
    const f = bootFixture(); f.selection.evidence.scope.organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    f.selection.evidenceSha256 = hash(f.selection.evidence);
    await expect(attest(f)).rejects.toThrow(); expect(f.ports.runProbe).not.toHaveBeenCalled();
  });
  it("freezes the selection and attempt before the first asynchronous verifier", async () => {
    const f = bootFixture(); const expected = structuredClone(f.selection), attempt = structuredClone(f.attempt);
    const verifier = f.verifyBuildQualification.getMockImplementation()!;
    f.verifyBuildQualification.mockImplementation(async (input) => {
      expect(Object.isFrozen(input.selection.evidence.scope)).toBe(true); expect(input.selection).toEqual(expected);
      f.selection.snapshot.snapshotId = "replacement"; f.attempt.nonce = "b".repeat(64);
      return verifier();
    });
    await attest(f);
    expect(f.proof?.selectionSha256).toBe(hash(expected)); expect(f.proof?.attempt).toEqual(attempt);
  });
  it("copies caller authority before the dynamic import or lock acquisition can yield", async () => {
    const f = bootFixture(), selection = structuredClone(f.selection), attempt = structuredClone(f.attempt);
    const running = attest(f);
    f.selection.snapshot.snapshotId = "replacement"; f.attempt.nonce = "b".repeat(64);
    await running;
    expect(f.proof?.selectionSha256).toBe(hash(selection)); expect(f.proof?.attempt).toEqual(attempt);
  });
  it.each(["before_verifier", "during_probe", "after_verifier"])("original deadline is never renewed: %s", async point => {
    const f = bootFixture();
    if (point === "before_verifier") f.advance(5001);
    if (point === "during_probe") f.ports.runProbe.mockImplementation(async () => { f.advance(5001); return f.probe; });
    if (point === "after_verifier") {
      const original = f.verifyBuildQualification.getMockImplementation()!; let calls = 0;
      f.verifyBuildQualification.mockImplementation(async () => { if (++calls === 2) f.advance(5001); return original(); });
    }
    await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
  });
  it("late probe cannot publish for a replacement attempt", async () => {
    const f = bootFixture(); f.ports.runProbe.mockImplementation(async () => { f.current({ ...f.attempt, nonce: "b".repeat(64) }); return f.probe; });
    await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
  });
  it("rechecks the live allocation after the final asynchronous verifier", async () => {
    const f = bootFixture(), original = f.verifyBuildQualification.getMockImplementation()!;
    let checks = 0, currentResources = true;
    f.verifyBuildQualification.mockImplementation(async () => {
      if (++checks === 2) currentResources = false;
      return original();
    });
    f.ports.checkResources.mockImplementation(() => {
      if (!currentResources) throw new Error("current allocation changed");
      return { admitted: true };
    });
    await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
  });
  it.each(["retirement", "outputJoined", "census", "credentials", "storage", "mounts"])("unknown %s never publishes", async field => {
    const f = bootFixture(); Object.assign(f.probe, { [field]: false });
    await expect(attest(f)).rejects.toThrow(); expect(f.store.publish).not.toHaveBeenCalled();
  });
});

describe("fresh v3 is single-use and bound after preparation", () => {
  it("allows one of two consumers and spends every replay", async () => {
    const f = bootFixture(); await attest(f);
    const outcomes = await Promise.allSettled([consume(f), consume(f)]);
    expect(outcomes.map(v => v.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(consume(f)).rejects.toThrow();
  });
  it.each(["version", "phase", "nonce", "executionFence", "setupRunId", "generation", "namespace", "init", "snapshot",
    "reportSha256", "qualifiedAtMs", "stale", "future", "current_attempt", "missing_fence"])("spends refused %s proof", async fault => {
    const f = bootFixture(); f.options.deadlineMs += 600000; await attest(f);
    const proof = f.proof!;
    if (fault === "version") proof.version = 2;
    if (fault === "phase") proof.attempt.phase = "preflight";
    if (fault === "nonce") proof.attempt.nonce = "b".repeat(64);
    if (fault === "executionFence") proof.attempt.execution.executionFence++;
    if (fault === "setupRunId") proof.attempt.execution.setupRunId = f.attempt.execution.workspaceId;
    if (fault === "generation") proof.attempt.execution.generation++;
    if (fault === "namespace") f.binding.namespaces.mnt = "mnt:[999]";
    if (fault === "init") f.binding.containerInitStartTicks = "9999";
    if (fault === "snapshot") f.selection.snapshot.snapshotId = "new-snapshot";
    if (fault === "reportSha256") proof.reportSha256 = "f".repeat(64);
    if (fault === "qualifiedAtMs") proof.qualifiedAtMs = f.ports.now();
    if (fault === "stale") f.advance(300001);
    if (fault === "future") proof.checkedAtMs += 5001;
    if (fault === "current_attempt") f.current({ ...f.attempt, nonce: "f".repeat(64) });
    await expect(consume(f, fault === "missing_fence" ? { readAttempt: undefined } : {})).rejects.toThrow();
    expect(f.proof).toBeUndefined();
  });
  it.each([300000, -5000])("uses only checkedAtMs for the inclusive fresh age bound: %i", async elapsed => {
    const f = bootFixture(); f.options.deadlineMs += 600000; await attest(f);
    f.advance(elapsed);
    await expect(consume(f)).resolves.toMatchObject({ qualifiedAtMs: Date.parse(f.selection.evidence.qualifiedAt) });
  });
  it("requires a new nonce and phase after preparation", async () => {
    const f = bootFixture(); f.attempt.phase = "preflight"; f.current(structuredClone(f.attempt));
    await attest(f); f.attempt.phase = "launch"; f.attempt.nonce = "c".repeat(64); f.current(structuredClone(f.attempt));
    await expect(consume(f)).rejects.toThrow();
    await attest(f); await expect(consume(f)).resolves.toMatchObject({ version: 3 });
  });
  it("rechecks the current attempt after verifier I/O at consumption", async () => {
    const f = bootFixture(); await attest(f);
    const original = f.verifyBuildQualification.getMockImplementation()!;
    f.verifyBuildQualification.mockImplementation(async () => { f.current({ ...f.attempt, nonce: "c".repeat(64) }); return original(); });
    await expect(consume(f)).rejects.toThrow(); expect(f.proof).toBeUndefined();
  });
  it.each([null, { mode: "future" }, { mode: "full", fallback: true }, { mode: "build" }])(
    "spends a claimed proof for malformed selected authority without legacy fallback: %j", async selection => {
      const f = bootFixture(); await attest(f);
      await expect(consume(f, { selection })).rejects.toThrow();
      expect(f.proof).toBeUndefined(); expect(f.ports.fullConsume).not.toHaveBeenCalled();
    });
});

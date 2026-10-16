import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RunStore } from "../zeros-dev/receipts";
import { exportCleanupRecovery, importCleanupInput, importCleanupRecovery } from "../zeros-dev/cleanup-recovery";
import { exportHourlyArtifact, importHourlyArtifact, verifyPublicHourlyArtifact } from "../zeros-dev/hourly-artifact";
import { cleanupOutcome } from "../zeros-dev/cleanup-state";
import { ZerosDevError } from "../zeros-dev/errors";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { cleanupRecoveryFixture } from "./zeros-dev-cleanup-recovery-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-recovery-")); roots.push(root);
  return cleanupRecoveryFixture(root);
}
async function restored(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new RunStore(path.join(f.root, `actions-${randomUUID()}`), f.fixture, f.credential);
  const input = await importHourlyArtifact(f.artifact, store, f.credential, f.execution, { includeSourceDigest: true });
  return { store, input };
}

describe("signed cleanup-only recovery envelope", () => {
  it("verifies the failed source and current successor, then emits only custody without modifying the source", async () => {
    const f = await fixture(), before = await readFile(path.join(f.source.directory, `${f.runId}.json`));
    const result = await exportCleanupRecovery(f.options), encoded = await readFile(f.file, "utf8"), raw = Buffer.from(encoded, "base64").toString("utf8");
    expect(result).toEqual({ state: "ready", sha256: createHash("sha256").update(raw).digest("hex"), runCount: 1 });
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(f.api.readRetirement).toHaveBeenCalledOnce();
    expect(JSON.parse(raw).payload).toMatchObject({ scope: "cleanup-only", sourceArtifactSha256: f.sourceArtifactSha256,
      runId: f.runId, approvalId: f.approvalId, handoff: f.handoff });
    for (const forbidden of [f.credential.privateKey, f.fixture.email, "retirement", "prompts", "evidence", "terminal_run"]) expect(raw).not.toContain(forbidden);
    expect(await readFile(f.artifact)).toEqual(f.sourceBytes);
    expect(await readFile(path.join(f.source.directory, `${f.runId}.json`))).toEqual(before);
  });

  it("appends to the exact restored predecessor and retains both its failure and consumed local handoff", async () => {
    const f = await fixture(); await exportCleanupRecovery(f.options);
    const { store, input } = await restored(f);
    const result = await importCleanupInput(await readFile(f.file, "utf8"), store, f.credential, input);
    expect(result.handoff).toEqual(f.handoff);
    const run = await store.read(f.runId), { cleanupRecovery: recovery, ...original } = run;
    expect(original).toEqual(f.original); expect(recovery).toEqual(result.cleanupRecovery);
    expect(run.retirement).toBeUndefined(); expect(cleanupOutcome(run)).toBe("unconfirmed");
    expect(run.lifecycle.at(-1)?.confirmed).toBe(false);
    expect(f.api.readRetirement).toHaveBeenCalledOnce(); // producer only; import grants no product access
  });

  it.each(["signature", "bytes", "fixture", "device", "digest", "handoff", "different-source-run", "missing-source"])("refuses %s without changing any existing run", async condition => {
    const f = await fixture(); await exportCleanupRecovery(f.options);
    const next = await restored(f); let encoded = await readFile(f.file, "utf8"), credential = f.credential;
    let store = next.store;
    const input = { ...next.input };
    if (condition === "signature" || condition === "bytes") {
      const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (condition === "signature") raw.signature = "A".repeat(86); else raw.payload.approvalId = randomUUID();
      encoded = Buffer.from(JSON.stringify(raw)).toString("base64");
    }
    if (condition === "fixture") store = new RunStore(path.join(f.root, "foreign"), { ...f.fixture, organizationId: randomUUID() }, credential);
    if (condition === "device") credential = { ...createCloudReplicaDeviceCredential(f.fixture.accountId), deviceId: randomUUID() };
    if (condition === "digest") input.sourceArtifactSha256 = "0".repeat(64);
    if (condition === "handoff") input.handoff = { ...f.handoff, sha256: "0".repeat(64) };
    if (condition === "different-source-run") await store.withRun(f.runId, null, async h => { h.run.evidence.push({ phase: "cleanup", outcome: "failed", code: "cleanup_pending", durationMs: 1 }); await h.save(); });
    if (condition === "missing-source") store = new RunStore(path.join(f.root, "empty"), f.fixture, credential);
    const before = await next.store.read(f.runId);
    await expect(importCleanupInput(encoded, store, credential, input)).rejects.toBeInstanceOf(ZerosDevError);
    expect(await next.store.read(f.runId)).toEqual(before);
  });

  it.each(["generation", "owner", "repository", "key", "authority", "stale", "missing", "cancelled"])("does not export a %s retirement observation", async condition => {
    const f = await fixture(), original = f.api.readRetirement.getMockImplementation()!;
    f.api.readRetirement.mockImplementation(async run => {
      const proof: any = await original(run);
      if (condition === "generation") proof.currentGeneration++;
      if (condition === "owner") proof.createdBy = randomUUID();
      if (condition === "repository") proof.workspaceId = randomUUID();
      if (condition === "key") proof.deleteIdempotencyKey = f.original.lifecycle.at(-1)!.key;
      if (condition === "authority") proof.accessRetired = false;
      if (condition === "stale") {
        proof.observedAt = proof.requestedAt = new Date(Date.now() - 600_000).toISOString();
        for (const row of proof.generations) {
          row.requestedAt = proof.requestedAt;
          row.expectedBy = new Date(Date.parse(proof.observedAt) + 6 * 3_600_000).toISOString();
        }
      }
      if (condition === "missing") throw new ZerosDevError("cleanup_pending");
      if (condition === "cancelled") throw new ZerosDevError("deadline");
      return proof;
    });
    await expect(exportCleanupRecovery(f.options)).rejects.toBeInstanceOf(ZerosDevError);
    await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies a signed envelope with inconsistent run bindings as artifact_invalid", async () => {
    const f = await fixture(); await exportCleanupRecovery(f.options);
    const raw = JSON.parse(Buffer.from(await readFile(f.file, "utf8"), "base64").toString("utf8"));
    raw.payload.failedDeleteKey = randomUUID();
    const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: f.credential.publicKey, d: f.credential.privateKey } });
    raw.signature = sign(null, Buffer.from(JSON.stringify(raw.payload)), key).toString("base64url");
    const next = await restored(f), before = await next.store.read(f.runId);
    await expect(importCleanupInput(Buffer.from(JSON.stringify(raw)).toString("base64"), next.store, f.credential, next.input))
      .rejects.toMatchObject({ code: "artifact_invalid" });
    expect(await next.store.read(f.runId)).toEqual(before);
  });

  it.each(["success", "already-confirmed", "foreign-repository", "source-execution", "wrong-run"])("refuses %s source selection before the product read", async condition => {
    const f = await fixture(), raw = JSON.parse(f.sourceBytes.toString("utf8"));
    if (condition === "success") { raw.payload.result.success = true; raw.payload.result.code = null; }
    if (condition === "already-confirmed") raw.payload.runs[0].deletionConfirmed = true;
    if (condition === "foreign-repository") raw.payload.runs[0].create.body.repository.name = "foreign";
    const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: f.credential.publicKey, d: f.credential.privateKey } });
    raw.signature = sign(null, Buffer.from(JSON.stringify(raw.payload)), key).toString("base64url");
    await writeFile(f.artifact, JSON.stringify(raw), { mode: 0o600 });
    await expect(exportCleanupRecovery({ ...f.options,
      ...(condition === "source-execution" ? { execution: { ...f.execution, attempt: 2 } } : {}),
      ...(condition === "wrong-run" ? { runId: randomUUID() } : {}) })).rejects.toBeInstanceOf(ZerosDevError);
    expect(f.api.readRetirement).not.toHaveBeenCalled();
  });

  it("replays exact consumption after physical completion without resurrecting the old source", async () => {
    const f = await fixture(); await exportCleanupRecovery(f.options);
    const { store, input } = await restored(f), encoded = await readFile(f.file, "utf8");
    const consumed = await importCleanupInput(encoded, store, f.credential, input);
    await expect(importCleanupInput(encoded, store, f.credential, input)).resolves.toEqual(consumed); // interrupted checkpoint
    await store.withRun(f.runId, null, async h => {
      const proof = await f.api.readRetirement(h.run);
      h.run.retirement = { ...proof, status: "physically_deleted", deletionConfirmed: true,
        reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 },
        generations: proof.generations.map(g => ({ ...g, status: "physically_deleted", storageStage: "completed", expectedBy: null,
          reserved: { cpuMillicores: 0, memoryMiB: 0, storageMiB: 0 } })) };
      h.run.deletionConfirmed = true; await h.save();
    });
    const execution = { workflowRunId: "18", attempt: 1, sourceSha: "b".repeat(40) }, current = randomUUID(), artifact = path.join(f.root, "next.json");
    await exportHourlyArtifact(artifact, store, f.credential, execution, { runId: current, success: false, code: "command_uncertain" },
      { profile: "infrastructure", ...consumed });
    const next = new RunStore(path.join(f.root, "third"), f.fixture, f.credential);
    const restoredInput = await importHourlyArtifact(artifact, next, f.credential, execution, { includeSourceDigest: true });
    expect(await next.list()).toEqual([]);
    await expect(importCleanupInput(encoded, next, f.credential, restoredInput)).resolves.toEqual(consumed);
    expect(await next.list()).toEqual([]);
    expect(await readFile(f.artifact)).toEqual(f.sourceBytes);
    const raw = JSON.parse(await readFile(artifact, "utf8"));
    expect(verifyPublicHourlyArtifact(raw, { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey }, execution).result.success).toBe(false);
  });

  it("refuses replacing a consumed recovery or dropping its artifact custody", async () => {
    const f = await fixture(); await exportCleanupRecovery(f.options);
    const { store, input } = await restored(f), encoded = await readFile(f.file, "utf8"), consumed = await importCleanupInput(encoded, store, f.credential, input);
    await expect(importCleanupRecovery(encoded, store, f.credential, { ...input, consumed: { ...consumed.cleanupRecovery!, approvalId: randomUUID() } })).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(exportHourlyArtifact(path.join(f.root, "lost.json"), store, f.credential,
      { workflowRunId: "18", attempt: 1, sourceSha: "b".repeat(40) }, { runId: randomUUID(), success: false, code: "command_uncertain" },
      { profile: "infrastructure", handoff: f.handoff })).rejects.toThrow("zeros_dev_artifact_invalid");
  });

  it("refuses aliases, overwrite and credential/source file confusion", async () => {
    const f = await fixture();
    await expect(exportCleanupRecovery({ ...f.options, credentialFile: f.artifact })).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(f.api.readRetirement).not.toHaveBeenCalled();
    await symlink(f.artifact, f.file);
    await expect(exportCleanupRecovery(f.options)).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(f.artifact)).toEqual(f.sourceBytes);
    const file = path.join(f.root, "fresh.b64"); await exportCleanupRecovery({ ...f.options, file });
    const before = await readFile(file);
    await expect(exportCleanupRecovery({ ...f.options, file })).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(file)).toEqual(before);
    await chmod(f.artifact, 0o644);
    await expect(exportCleanupRecovery({ ...f.options, file: path.join(f.root, "public-input.b64") })).rejects.toThrow("zeros_dev_artifact_invalid");
  });
});

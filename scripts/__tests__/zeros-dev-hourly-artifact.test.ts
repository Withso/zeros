import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunStore } from "../zeros-dev/receipts";
import { exportHourlyArtifact, importHourlyArtifact, verifyPublicHourlyArtifact, verifyRetiredReceipt } from "../zeros-dev/hourly-artifact";
import { CHAIN_RESTART } from "../zeros-dev/chain-restart.mjs";
import type { Fixture } from "../zeros-dev/config";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";
import { PRESTART_RECOVERY } from "../zeros-dev/prestart-recovery.mjs";
import { initialInfrastructure } from "../zeros-dev/infrastructure-contract";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(deviceId: string = randomUUID()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-artifact-")); roots.push(root);
  const accountId = randomUUID(), fixture: Fixture = { subject: "user_fixture", accountId, email: "fixture@example.test", organizationId: randomUUID(),
    repository: { id: "123", owner: "fixture", name: "fixture", installationId: randomUUID() } };
  const credential = { ...createCloudReplicaDeviceCredential(accountId), deviceId };
  const store = new RunStore(path.join(root, "runs"), fixture, credential), runId = randomUUID();
  const execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
  await store.withRun(runId, { revision: execution.sourceSha, dirty: false }, async h => {
    h.run.hourly = { version: 1, ...execution, credentials: [], histories: [], activeWindows: [], complete: false }; await h.save();
  });
  const output = path.join(root, "output"); await mkdir(output, { mode: 0o700 });
  return { root, fixture, credential, store, runId, execution, file: path.join(output, "receipt.json") };
}

describe("cross-run signed Actions receipts", () => {
  it("signs the first native predicate alongside a later cleanup failure and rejects edited diagnostics", async () => {
    const f = await fixture();
    await f.store.withRun(f.runId, null, async h => {
      h.run.hourly!.infrastructure = initialInfrastructure();
      h.run.evidence.push({ phase: "detached_native_proof", outcome: "failed", durationMs: 1324,
        code: "detached_proof_incomplete", nativeProof: { predicate: "pty_create_unavailable" } });
      h.run.evidence.push({ phase: "cleanup", outcome: "failed", durationMs: 110_000, code: "cleanup_pending" });
      await h.save();
    });
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution,
      { code: "detached_proof_incomplete", success: false, runId: f.runId, nativeProof: { predicate: "pty_create_unavailable" } }, { profile: "infrastructure" });
    const raw = JSON.parse(await readFile(f.file, "utf8")), trust = { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey };
    const verified = verifyPublicHourlyArtifact(raw, trust, f.execution);
    expect(verified.runs[0]!.evidence).toEqual((await f.store.read(f.runId)).evidence);
    expect(verified.runs[0]!.evidence[0]).toMatchObject({ nativeProof: { predicate: "pty_create_unavailable" } });
    expect(verified.result).toMatchObject({ success: false, code: "detached_proof_incomplete", nativeProof: { predicate: "pty_create_unavailable" } });
    const next = new RunStore(path.join(f.root, "diagnostic-import"), f.fixture, f.credential);
    await importHourlyArtifact(f.file, next, f.credential, f.execution);
    expect((await next.read(f.runId)).evidence).toEqual(verified.runs[0]!.evidence);
    raw.payload.runs[0].evidence[0].nativeProof.predicate = "heartbeat_gap";
    expect(() => verifyPublicHourlyArtifact(raw, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
  });
  it("signs and preserves the exact reviewed prestart incident without pretending it produced an artifact", async () => {
    const f = await fixture(), result = { code: "command_uncertain" as const, success: false, runId: f.runId };
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { prestartRecovery: PRESTART_RECOVERY });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    expect(raw.payload.prestartRecovery).toEqual(PRESTART_RECOVERY); expect(raw.payload.result.success).toBe(false);
    const next = new RunStore(path.join(f.root, "next"), f.fixture, f.credential);
    expect(await importHourlyArtifact(f.file, next, f.credential, f.execution)).toEqual({ prestartRecovery: PRESTART_RECOVERY });
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { replace: true })).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(exportHourlyArtifact(path.join(f.root, "other.json"), f.store, f.credential, f.execution, result,
      { prestartRecovery: { ...PRESTART_RECOVERY, attempt: 2 } } as never)).rejects.toThrow("zeros_dev_artifact_invalid");
    raw.payload.prestartRecovery.jobId = "17";
    expect(() => verifyPublicHourlyArtifact(raw, { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey }, f.execution)).toThrow("zeros_dev_artifact_invalid");
  });
  it("signs the exact reviewed chain restart for its successor without letting it be inherited", async () => {
    const f = await fixture(), result = { code: "command_uncertain" as const, success: false, runId: f.runId };
    const trust = { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey };
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { chainRestart: CHAIN_RESTART });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    expect(raw.payload.chainRestart).toEqual(CHAIN_RESTART);
    expect(verifyPublicHourlyArtifact(raw, trust, f.execution)).toMatchObject({ chainRestart: CHAIN_RESTART });
    const next = new RunStore(path.join(f.root, "next"), f.fixture, f.credential);
    expect(await importHourlyArtifact(f.file, next, f.credential, f.execution)).toEqual({});
    expect((await next.read(f.runId)).runId).toBe(f.runId);
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { replace: true }))
      .rejects.toThrow("zeros_dev_artifact_invalid");
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(raw);
    for (const [index, changed] of [{ ...CHAIN_RESTART, attempt: 2 }, { ...CHAIN_RESTART, receiptSha256: "0".repeat(64) },
      { ...CHAIN_RESTART, approvedBy: "synthetic" }, { ...CHAIN_RESTART, reason: undefined }].entries())
      await expect(exportHourlyArtifact(path.join(f.root, "output", `changed-${index}.json`), f.store, f.credential, f.execution, result,
        { chainRestart: changed } as never)).rejects.toThrow("zeros_dev_artifact_invalid");
    const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: f.credential.publicKey, d: f.credential.privateKey } });
    const edits: ((record: Record<string, unknown>) => void)[] = [record => { record.retiredDeviceId = randomUUID(); },
      record => { record.artifactDigest = `sha256:${"0".repeat(64)}`; }, record => { record.extra = true; }, record => { delete record.approvedOn; }];
    for (const edit of edits) {
      // Re-sign each edit so only the strict record contract can reject it.
      const copy = structuredClone(raw); edit(copy.payload.chainRestart);
      copy.signature = sign(null, Buffer.from(JSON.stringify(copy.payload)), key).toString("base64url");
      expect(() => verifyPublicHourlyArtifact(copy, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
    }
  });
  it("refuses a chain restart signed by the retired device it replaces", async () => {
    const f = await fixture(CHAIN_RESTART.retiredDeviceId), result = { code: "command_uncertain" as const, success: false, runId: f.runId };
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { chainRestart: CHAIN_RESTART }))
      .rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result);
  });
  it("checks the retired receipt only by its pinned bytes and never follows an alias", async () => {
    const f = await fixture(), file = path.join(f.root, "retired.json"), link = path.join(f.root, "retired-link.json");
    await writeFile(file, "{}\n", { mode: 0o600 }); await symlink(file, link);
    await expect(verifyRetiredReceipt(file, CHAIN_RESTART)).rejects.toThrow("zeros_dev_chain_restart_mismatch");
    await expect(verifyRetiredReceipt(link, CHAIN_RESTART)).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(verifyRetiredReceipt(path.join(f.root, "missing.json"), CHAIN_RESTART)).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(verifyRetiredReceipt(file, { ...CHAIN_RESTART, receiptSha256: "0".repeat(64) } as never)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it("uses a separate infrastructure signature domain even for its initial uncertain checkpoint", async () => {
    const f = await fixture();
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution,
      { code: "command_uncertain", success: false, runId: randomUUID() }, { profile: "infrastructure" });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    expect(raw.payload.schema).toBe("zeros.dev-infrastructure/v1");
    expect(raw.payload.coverage).toEqual({ agents: "not_covered_owner_section7", accountModels: "not_covered_owner_section7",
      agentHistory: "not_covered_owner_section7", detachedAgent: "not_covered_owner_section7" });
    const trust = { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey };
    expect(verifyPublicHourlyArtifact(raw, trust, f.execution).schema).toBe("zeros.dev-infrastructure/v1");
    raw.payload.schema = "zeros.dev-hourly/v2";
    expect(() => verifyPublicHourlyArtifact(raw, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
  });
  it.each(["physical", "storage-pending"])("reads a correctly signed legacy %s receipt with its original erasure requirement", async condition => {
    const f = await fixture();
    await f.store.withRun(f.runId, null, async h => {
      h.run.create = { key: randomUUID(), body: { name: `zd-${f.runId}`, repository: { forge: "github.com", owner: "fixture", name: "fixture",
        revision: "main", githubInstallationId: f.fixture.repository.installationId } },
      result: { id: randomUUID(), createdBy: f.fixture.accountId, createdAt: new Date().toISOString(), generation: 1 } };
      retireFixtureCompute(h); h.run.hourly!.complete = true;
      if (condition === "physical") { h.run.deletionConfirmed = true; delete h.run.retirement; h.run.lifecycle.at(-1)!.confirmed = true; }
      await h.save();
    });
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: null, success: true, runId: f.runId });
    const envelope = JSON.parse(await readFile(f.file, "utf8"));
    envelope.payload.schema = "zeros.dev-hourly/v1"; delete envelope.payload.cleanup;
    const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: f.credential.publicKey, d: f.credential.privateKey } });
    envelope.signature = sign(null, Buffer.from(JSON.stringify(envelope.payload)), key).toString("base64url");
    const trust = { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey };
    if (condition === "physical") {
      expect(verifyPublicHourlyArtifact(envelope, trust, f.execution).schema).toBe("zeros.dev-hourly/v1");
      await writeFile(f.file, JSON.stringify(envelope));
      const next = new RunStore(path.join(f.root, "legacy"), f.fixture, f.credential);
      await expect(importHourlyArtifact(f.file, next, f.credential, f.execution)).resolves.toEqual({});
      expect((await next.read(f.runId)).deletionConfirmed).toBe(true);
    } else {
      expect(() => verifyPublicHourlyArtifact(envelope, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
      delete envelope.payload.runs[0].retirement;
      envelope.signature = sign(null, Buffer.from(JSON.stringify(envelope.payload)), key).toString("base64url");
      expect(() => verifyPublicHourlyArtifact(envelope, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
    }
  });

  it("exports a successful storage-pending result without claiming physical deletion", async () => {
    const f = await fixture();
    await f.store.withRun(f.runId, null, async h => {
      h.run.create = { key: randomUUID(), body: { name: `zd-${f.runId}`, repository: { forge: "github.com", owner: "fixture", name: "fixture",
        revision: "main", githubInstallationId: f.fixture.repository.installationId } },
      result: { id: randomUUID(), createdBy: f.fixture.accountId, createdAt: new Date().toISOString(), generation: 1 } };
      retireFixtureCompute(h, new Date().toISOString());
      h.run.hourly!.complete = true; await h.save();
    });
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: null, success: true, runId: f.runId });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    expect(raw.payload.schema).toBe("zeros.dev-hourly/v2");
    const verified = verifyPublicHourlyArtifact(raw, { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey }, f.execution);
    expect(verified.runs[0]).toMatchObject({ deletionConfirmed: false, retirement: { status: "compute_retired_storage_pending" } });
    expect(verified.result.success).toBe(true);
  });

  it("retains eight unresolved resources and a failed current attempt without truncating the signed chain", async () => {
    const f = await fixture();
    for (let i = 0; i < 8; i++) {
      const id = randomUUID();
      await f.store.withRun(id, { revision: f.execution.sourceSha, dirty: false }, async h => {
        h.run.hourly = { version: 1, ...f.execution, credentials: [], histories: [], activeWindows: [], complete: false };
        h.run.create = { key: randomUUID(), body: { name: `zd-${id}`, repository: { forge: "github.com", owner: "fixture", name: "fixture",
          revision: "main", githubInstallationId: f.fixture.repository.installationId } } };
        await h.save();
      });
    }
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: "cleanup_pending", success: false, runId: f.runId });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    expect(raw.payload.runs).toHaveLength(9);
    expect(raw.payload.runs.filter((run: any) => run.create)).toHaveLength(8);
  });

  it("verifies public receipts with a pinned public key and exact producer, without private credentials", async () => {
    const f = await fixture(); await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: "cleanup_pending", success: false, runId: f.runId });
    const raw = JSON.parse(await readFile(f.file, "utf8"));
    const trust = { deviceId: f.credential.deviceId, publicKey: f.credential.publicKey };
    expect(verifyPublicHourlyArtifact(raw, trust, f.execution).result).toMatchObject({ success: false, code: "cleanup_pending" });
    for (const untrusted of [{ ...trust, publicKey: createCloudReplicaDeviceCredential(f.fixture.accountId).publicKey }, { ...trust, deviceId: randomUUID() }])
      expect(() => verifyPublicHourlyArtifact(raw, untrusted, f.execution)).toThrow("zeros_dev_artifact_invalid");
    expect(() => verifyPublicHourlyArtifact(raw, trust, { ...f.execution, attempt: 2 })).toThrow("zeros_dev_artifact_invalid");
    raw.payload.result.code = "internal";
    expect(() => verifyPublicHourlyArtifact(raw, trust, f.execution)).toThrow("zeros_dev_artifact_invalid");
  });
  it.each(["legacy", "runtime", "setup"] as const)("round-trips a %s failure without changing its signed diagnostic", async kind => {
    const f = await fixture();
    const diagnostic = kind === "runtime" ? { runtime: { phase: "admission" as const, class: "admission_unavailable" as const, status: 500 } }
      : kind === "setup" ? { setup: { attempt: 5, claimCount: 2, state: "queued" as const, errorCode: "setup_provider_bootstrap_cleanup_unconfirmed" as const } } : {};
    await f.store.withRun(f.runId, null, async h => {
      h.run.evidence.push({ phase: "runtime_connect", outcome: "failed", durationMs: 2300, code: "runtime_unavailable", ...diagnostic }); await h.save();
    });
    const result = { code: "runtime_unavailable" as const, success: false, runId: f.runId, ...diagnostic };
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result);
    expect(JSON.parse(await readFile(f.file, "utf8")).payload.result).toEqual(result);
    const next = new RunStore(path.join(f.root, "next"), f.fixture, f.credential);
    await importHourlyArtifact(f.file, next, f.credential, f.execution);
    expect((await next.read(f.runId)).evidence).toEqual((await f.store.read(f.runId)).evidence);
  });

  it("refuses unreviewed diagnostic fields in the public artifact", async () => {
    const f = await fixture();
    const runtime = { phase: "admission" as const, class: "admission_unavailable" as const, status: 500, message: "synthetic-private-body" };
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution,
      { code: "runtime_unavailable", success: false, runId: f.runId, runtime })).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(readFile(f.file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically checkpoints the same execution before mutation so a killed runner can recover its exact intent", async () => {
    const f = await fixture(), result = { code: "command_uncertain" as const, success: false, runId: f.runId };
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result);
    const key = randomUUID();
    await f.store.withRun(f.runId, null, async h => {
      h.run.create = { key, body: { name: `zd-${f.runId}`, repository: { forge: "github.com", owner: "fixture", name: "fixture", revision: "main", githubInstallationId: f.fixture.repository.installationId } } };
      await h.save();
      await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { replace: true });
      // No response from create and no end-of-process export is available.
    });
    const next = new RunStore(path.join(f.root, "resumed"), f.fixture, f.credential);
    await importHourlyArtifact(f.file, next, f.credential, f.execution);
    expect((await next.read(f.runId)).create).toMatchObject({ key });
    expect((await next.read(f.runId)).create?.result).toBeUndefined();
  });

  it("refuses checkpoint replacement of a foreign execution, corrupt artifact or alias", async () => {
    const f = await fixture(), result = { code: "command_uncertain" as const, success: false, runId: f.runId };
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result);
    const original = await readFile(f.file, "utf8");
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, { ...f.execution, attempt: 2 }, result, { replace: true })).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(f.file, "utf8")).toBe(original);
    const link = path.join(f.root, "alias.json"); await symlink(f.file, link);
    await expect(exportHourlyArtifact(link, f.store, f.credential, f.execution, result, { replace: true })).rejects.toThrow("zeros_dev_artifact_invalid");
    await writeFile(f.file, "{}");
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution, result, { replace: true })).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(f.file, "utf8")).toBe("{}");
  });

  it("restores a prior signed exact-workflow receipt with no private material", async () => {
    const f = await fixture();
    await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: "cleanup_pending", success: false, runId: f.runId });
    const bytes = await readFile(f.file, "utf8"); expect(bytes).not.toContain(f.credential.privateKey); expect(bytes).not.toContain(f.fixture.email);
    // Actions artifacts restore ordinary files. Signature verification happens
    // before private local copies are written into the canonical receipt store.
    await chmod(f.file, 0o644);
    const next = new RunStore(path.join(f.root, "next"), f.fixture, f.credential);
    await importHourlyArtifact(f.file, next, f.credential, f.execution);
    expect(await next.read(f.runId)).toEqual(await f.store.read(f.runId));
  });
  it("refuses tampering, a foreign device or an artifact from another attempt", async () => {
    const f = await fixture(); await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { code: "cleanup_pending", success: false, runId: f.runId });
    const next = new RunStore(path.join(f.root, "next"), f.fixture, f.credential);
    await expect(importHourlyArtifact(f.file, next, f.credential, { ...f.execution, attempt: 2 })).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(importHourlyArtifact(f.file, next, { ...createCloudReplicaDeviceCredential(f.fixture.accountId), deviceId: f.credential.deviceId }, f.execution)).rejects.toThrow("zeros_dev_artifact_invalid");
    const value = JSON.parse(await readFile(f.file, "utf8")); value.payload.result.success = true;
    await writeFile(f.file, JSON.stringify(value));
    await expect(importHourlyArtifact(f.file, next, f.credential, f.execution)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it("does not follow receipt aliases or overwrite an output", async () => {
    const f = await fixture(); await exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { success: false, code: "cleanup_pending", runId: f.runId });
    await expect(exportHourlyArtifact(f.file, f.store, f.credential, f.execution, { success: false, code: "cleanup_pending", runId: f.runId })).rejects.toThrow("zeros_dev_artifact_invalid");
    const link = path.join(f.root, "link.json"); await symlink(f.file, link);
    await expect(importHourlyArtifact(link, f.store, f.credential, f.execution)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
});

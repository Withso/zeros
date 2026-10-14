import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunStore } from "../zeros-dev/receipts";
import { exportHourlyArtifact, importHourlyArtifact } from "../zeros-dev/hourly-artifact";
import type { Fixture } from "../zeros-dev/config";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-artifact-")); roots.push(root);
  const accountId = randomUUID(), fixture: Fixture = { subject: "user_fixture", accountId, email: "fixture@example.test", organizationId: randomUUID(),
    repository: { id: "123", owner: "fixture", name: "fixture", installationId: randomUUID() } };
  const credential = { ...createCloudReplicaDeviceCredential(accountId), deviceId: randomUUID() };
  const store = new RunStore(path.join(root, "runs"), fixture, credential), runId = randomUUID();
  const execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
  await store.withRun(runId, { revision: execution.sourceSha, dirty: false }, async h => {
    h.run.hourly = { version: 1, ...execution, credentials: [], histories: [], activeWindows: [], complete: false }; await h.save();
  });
  const output = path.join(root, "output"); await mkdir(output, { mode: 0o700 });
  return { root, fixture, credential, store, runId, execution, file: path.join(output, "receipt.json") };
}

describe("cross-run signed Actions receipts", () => {
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

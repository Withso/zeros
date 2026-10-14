import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { exportCleanupHandoff, importCleanupHandoff } from "../zeros-dev/cleanup-handoff";
import { exportHourlyArtifact, importHourlyArtifact } from "../zeros-dev/hourly-artifact";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import { ZerosDevRuntime } from "../zeros-dev/runtime";
import { RunStore } from "../zeros-dev/receipts";
import type { Fixture } from "../zeros-dev/config";
import { retireFixtureCompute } from "./zeros-dev-cleanup-fixture";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "zd-handoff-")); roots.push(root);
  const accountId = randomUUID(), fixture: Fixture = { subject: "user_fixture", accountId, email: "fixture@example.test", organizationId: randomUUID(),
    repository: { id: "123", owner: "fixture", name: "repository", installationId: randomUUID() } };
  const credential = { ...createCloudReplicaDeviceCredential(accountId), deviceId: randomUUID() };
  const store = new RunStore(path.join(root, "local"), fixture, credential), runId = randomUUID(), createdAt = new Date().toISOString();
  await store.withRun(runId, { revision: "a".repeat(40), dirty: true }, async handle => {
    handle.run.create = { key: randomUUID(), body: { name: `zd-${runId}`, repository: { forge: "github.com", owner: "fixture", name: "repository",
      revision: "main", githubInstallationId: fixture.repository.installationId } }, result: { id: randomUUID(), createdBy: accountId, createdAt, generation: 1 } };
    const proof = retireFixtureCompute(handle, createdAt); proof.organizationId = fixture.organizationId;
    handle.run.evidence.push({ phase: "terminal_run", outcome: "ok", durationMs: 7 }); await handle.save();
  });
  const api = { readRetirement: vi.fn(async run => structuredClone(run.retirement!)) };
  const file = path.join(root, "handoff.b64"), signal = new AbortController().signal;
  return { root, fixture, credential, store, runId, file, api, options: { file, runIds: [runId], store, credential, api, signal } };
}

describe("exact local-to-Actions cleanup handoff", () => {
  it.each(["owner", "name", "installation"])("refuses a signed local receipt with the wrong repository %s", async field => {
    const f = await fixture();
    await f.store.withRun(f.runId, null, async handle => {
      const repo = handle.run.create!.body.repository;
      if (field === "installation") repo.githubInstallationId = randomUUID();
      else repo[field as "owner" | "name"] = "another-fixture";
      await handle.save();
    });
    await expect(exportCleanupHandoff(f.options)).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(f.api.readRetirement).not.toHaveBeenCalled();
  });
  it("authenticates local receipts, reads proof and writes a private cleanup-only manifest with no credentials or transcript", async () => {
    const f = await fixture(), source = await readFile(path.join(f.store.directory, `${f.runId}.json`), "utf8");
    const result = await exportCleanupHandoff(f.options);
    expect(result).toMatchObject({ state: "ready", runCount: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const input = await open(f.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let encoded: string;
    try { expect((await input.stat()).mode & 0o777).toBe(0o600); encoded = await input.readFile("utf8"); }
    finally { await input.close(); }
    const text = Buffer.from(encoded, "base64").toString("utf8"), manifest = JSON.parse(text);
    expect([f.credential.privateKey, f.fixture.email, "terminal_run", "AGENT_RUNTIME"].some(value => text.includes(value))).toBe(false);
    expect(manifest.payload).toMatchObject({ schema: "zeros.dev-cleanup-handoff/v1", scope: "cleanup-only" });
    expect(manifest.payload.runs[0].run).toMatchObject({ evidence: [], prompts: [], deletionConfirmed: false });
    expect(f.api.readRetirement).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.store.directory, `${f.runId}.json`), "utf8")).toBe(source);
    const next = new RunStore(path.join(f.root, "actions"), f.fixture, f.credential);
    const reference = await importCleanupHandoff(encoded, next, f.credential);
    expect(reference.sha256).toBe(result.sha256);
    expect(await next.read(f.runId)).toMatchObject({ cleanupOnly: { handoffSha256: result.sha256 }, deletionConfirmed: false });
  });

  it.each(["tamper", "foreign-fixture", "foreign-device", "signature", "oversized", "invalid-base64"])("refuses %s before importing any authority", async condition => {
    const f = await fixture(); await exportCleanupHandoff(f.options);
    let encoded = await readFile(f.file, "utf8"), target = f.fixture, credential = f.credential;
    if (condition === "foreign-fixture") target = { ...target, organizationId: randomUUID() };
    if (condition === "foreign-device") credential = { ...createCloudReplicaDeviceCredential(target.accountId), deviceId: randomUUID() };
    if (condition === "tamper" || condition === "signature") {
      const raw = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      if (condition === "tamper") raw.payload.runs[0].run.create.result.generation++;
      else raw.signature = "A".repeat(86);
      encoded = Buffer.from(JSON.stringify(raw)).toString("base64");
    }
    if (condition === "oversized") encoded = "A".repeat(48 * 1024 + 1);
    if (condition === "invalid-base64") encoded += "\n";
    const next = new RunStore(path.join(f.root, "actions"), target, credential);
    await expect(importCleanupHandoff(encoded, next, credential)).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await next.list()).toEqual([]);
  });

  it("carries consumption after physical completion so an unchanged variable cannot resurrect a local run", async () => {
    const f = await fixture(); await exportCleanupHandoff(f.options);
    const encoded = await readFile(f.file, "utf8"), next = new RunStore(path.join(f.root, "actions"), f.fixture, f.credential);
    const reference = await importCleanupHandoff(encoded, next, f.credential);
    await next.withRun(f.runId, null, async handle => {
      handle.run.deletionConfirmed = true;
      handle.run.retirement!.status = "physically_deleted"; handle.run.retirement!.deletionConfirmed = true;
      handle.run.retirement!.reserved.storageMiB = 0;
      for (const row of handle.run.retirement!.generations) { row.status = "physically_deleted"; row.storageStage = "completed"; row.expectedBy = null; row.reserved.storageMiB = 0; }
      await handle.save();
    });
    const execution = { workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40) }, current = randomUUID();
    await next.withRun(current, { revision: execution.sourceSha, dirty: false }, async handle => {
      handle.run.hourly = { version: 1, ...execution, credentials: [], histories: [], activeWindows: [], complete: false }; await handle.save();
    });
    const artifact = path.join(f.root, "receipt.json");
    await exportHourlyArtifact(artifact, next, f.credential, execution, { runId: current, success: false, code: "deadline" }, { handoff: reference });
    const after = new RunStore(path.join(f.root, "next-actions"), f.fixture, f.credential);
    const restored = await importHourlyArtifact(artifact, after, f.credential, execution);
    expect(restored.handoff).toEqual(reference);
    await importCleanupHandoff(encoded, after, f.credential, restored.handoff);
    expect(await after.list()).toEqual([current]);
  });

  it("cannot overwrite an existing run or silently replace a consumed manifest", async () => {
    const f = await fixture(); await exportCleanupHandoff(f.options);
    const encoded = await readFile(f.file, "utf8"), next = new RunStore(path.join(f.root, "actions"), f.fixture, f.credential);
    const reference = await importCleanupHandoff(encoded, next, f.credential);
    await expect(importCleanupHandoff(encoded, next, f.credential)).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(importCleanupHandoff(encoded, next, f.credential, { ...reference, sha256: "f".repeat(64) })).rejects.toThrow("zeros_dev_artifact_invalid");
    await expect(importCleanupHandoff(encoded, next, f.credential, reference)).resolves.toEqual(reference);
  });

  it("rejects corrupt original signatures and unbounded selections before provider reads", async () => {
    const f = await fixture();
    await expect(exportCleanupHandoff({ ...f.options, runIds: Array.from({ length: 5 }, () => randomUUID()) })).rejects.toThrow("zeros_dev_invalid_request");
    const source = path.join(f.store.directory, `${f.runId}.json`), value = JSON.parse(await readFile(source, "utf8"));
    value.run.create.result.id = randomUUID(); await writeFile(source, JSON.stringify(value), { mode: 0o600 });
    await expect(exportCleanupHandoff(f.options)).rejects.toThrow("zeros_dev_receipt_invalid");
    expect(f.api.readRetirement).not.toHaveBeenCalled();
  });

  it("never follows an output alias or overwrites an earlier export", async () => {
    const f = await fixture(), target = path.join(f.root, "owned"); await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, f.file);
    await expect(exportCleanupHandoff(f.options)).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(target, "utf8")).toBe("untouched");
    const normal = path.join(f.root, "normal.b64"); await exportCleanupHandoff({ ...f.options, file: normal });
    const before = await readFile(normal, "utf8");
    await expect(exportCleanupHandoff({ ...f.options, file: normal })).rejects.toThrow("zeros_dev_artifact_invalid");
    expect(await readFile(normal, "utf8")).toBe(before);
  });

  it("never lets an imported cleanup scope allocate, build, wake, stop, admit agents or connect a runtime", async () => {
    const f = await fixture(); await exportCleanupHandoff(f.options);
    const next = new RunStore(path.join(f.root, "actions"), f.fixture, f.credential);
    await importCleanupHandoff(await readFile(f.file, "utf8"), next, f.credential);
    const fetcher = vi.fn(async () => { throw new Error("no product call authorized"); });
    const session = { fixture: async () => f.fixture, whoami: vi.fn(), accessToken: vi.fn() }, api = new ProductApi(session, new AlphaTransport(fetcher));
    await next.withRun(f.runId, null, async handle => {
      for (const operation of [() => api.createWorkspace(handle), () => api.buildComputer(handle), () => api.lifecycle(handle, "wake"),
        () => api.lifecycle(handle, "stop"), () => api.grant(handle.run, "claude", "fixture"),
        () => ZerosDevRuntime.connect(session as never, api, handle.run)])
        await expect(operation()).rejects.toMatchObject({ code: "forbidden" });
    });
    expect(fetcher).not.toHaveBeenCalled(); expect(session.whoami).not.toHaveBeenCalled();
  });
});

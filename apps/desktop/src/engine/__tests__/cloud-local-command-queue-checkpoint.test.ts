import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { verifyCloudLocalCommandCheckpoint, restoreCloudLocalCommandCheckpointLedger } from "../cloud-local-command-queue-checkpoint";
import { openSqlite } from "../db/sqlite";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(acknowledge = true) {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-sealed-checkpoint-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(), bootId: randomUUID(),
    writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const registry = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => registry.dispose());
  const normal = openSqlite(path.join(directory, "normal.sqlite")); cleanup.push(() => normal.close());
  normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
  normal.exec("CREATE TABLE sync_meta(id INTEGER PRIMARY KEY,next_rev INTEGER NOT NULL); INSERT INTO sync_meta VALUES(0,8)");
  const file = path.join(directory, "queue.sqlite"), queue = new CloudLocalCommandQueue({ file, scope, actors: registry,
    engineLive: () => true, ready: () => true, history: () => ({ recordSequence: 7, eventSequence: 0 }) }); cleanup.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true }); cleanup.push(() => events.close());
  const lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb: () => normal, assertQuiescent: () => {},
    heads: (source = normal) => ({ recordSequence: (source.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev, eventSequence: events.head }) });
  cleanup.push(() => lifecycle.close());
  if (acknowledge) await lifecycle.drainAndSeal({ mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {},
    freezeNormal: () => normal.close(), request: async seal => { const { scope: _scope, ...body } = seal; return { ...body, writerEpoch: scope.writerEpoch }; } });
  return { directory, scope, queue, normal, lifecycle, root: path.join(directory, "checkpoint") };
}
describe("sealed FULL/NORMAL checkpoint custody", () => {
  it("captures and verifies the acknowledged immutable file pair without a runnable old writer", async () => {
    const f = await fixture(), manifest = await f.lifecycle.captureCheckpoint(f.root);
    expect(manifest.seal).toEqual(f.lifecycle.seal); expect(manifest.files.map(file => file.kind)).toEqual(["ledger", "normal"]);
    const verified = await verifyCloudLocalCommandCheckpoint({ root: f.root, scope: f.scope });
    expect(verified.manifest).toEqual(manifest);
    const ledger = openSqlite(verified.ledgerFile, { readonly: true }), normal = openSqlite(verified.normalFile, { readonly: true });
    try {
      expect((ledger.prepare("SELECT value FROM local_command_metadata WHERE key='sealedWriter'").get() as { value: string }).value).toBe(f.scope.writerEpoch);
      expect((normal.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev).toBe(7);
    } finally { ledger.close(); normal.close(); }
  });
  it("refuses capture until the exact seal ACK and freeze proof exist", async () => {
    const f = await fixture(false);
    await expect(f.lifecycle.captureCheckpoint(f.root)).rejects.toThrow("command_conflict");
    f.lifecycle.begin(); f.lifecycle.createSeal();
    await expect(f.lifecycle.captureCheckpoint(f.root)).rejects.toThrow("command_conflict");
  });
  it.each(["missing", "mutated", "mixed"])("refuses a %s checkpoint part before boot exposure", async problem => {
    const f = await fixture(), manifest = await f.lifecycle.captureCheckpoint(f.root);
    const part = path.join(f.root, manifest.files[0]!.parts[0]!.path);
    if (problem === "missing") await unlink(part);
    else if (problem === "mutated") await writeFile(part, Buffer.from("corrupt fixture"));
    else await writeFile(part, await readFile(path.join(f.root, manifest.files[1]!.parts[0]!.path)));
    await expect(verifyCloudLocalCommandCheckpoint({ root: f.root, scope: f.scope })).rejects.toThrow();
  });
  it("refuses a foreign workspace and preserves the original immutable descriptor", async () => {
    const f = await fixture(), manifest = await f.lifecycle.captureCheckpoint(f.root);
    await expect(verifyCloudLocalCommandCheckpoint({ root: f.root, scope: { ...f.scope, workspaceId: randomUUID() } })).rejects.toThrow();
    expect(f.lifecycle.seal).toEqual(manifest.seal);
  });
  it("installs only a verified original sealed ledger before a fresh writer can be constructed", async () => {
    const f = await fixture(); await f.lifecycle.captureCheckpoint(f.root);
    const file = path.join(f.directory, "restored", "local.sqlite");
    const restored = await restoreCloudLocalCommandCheckpointLedger({ root: f.root, file, scope: f.scope });
    cleanup.push(restored.cleanup);
    const original = openSqlite(file, { readonly: true });
    try { expect((original.prepare("SELECT value FROM local_command_metadata WHERE key='sealedWriter'").get() as { value: string }).value).toBe(f.scope.writerEpoch); }
    finally { original.close(); }
    expect(restored.manifest.seal).toEqual(f.lifecycle.seal);
  });
  it("refuses to roll an existing newer or unsealed local writer back to an older artifact", async () => {
    const f = await fixture(); await f.lifecycle.captureCheckpoint(f.root);
    const newer = openSqlite(path.join(f.directory, "newer.sqlite"));
    try { newer.exec("CREATE TABLE local_command_metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO local_command_metadata VALUES('writer','{}')"); }
    finally { newer.close(); }
    await expect(restoreCloudLocalCommandCheckpointLedger({ root: f.root, file: path.join(f.directory, "newer.sqlite"), scope: f.scope })).rejects.toThrow();
  });
  it("binds durable mutation retry identity in the private sealed inventory", async () => {
    const f = await fixture();
    const ledger = openSqlite(path.join(f.directory, "queue.sqlite"));
    try { ledger.prepare("INSERT INTO local_command_history_mutations VALUES(?,?,?,?,?)").run(randomUUID(), f.scope.writerEpoch,
      "chat", "f".repeat(64), "{}"); }
    finally { ledger.close(); }
    await expect(f.lifecycle.captureCheckpoint(f.root)).rejects.toThrow();
  });
  it("refuses an older sealed artifact on an empty replacement when authenticated predecessor differs", async () => {
    const f = await fixture(); await f.lifecycle.captureCheckpoint(f.root);
    const input = { root: f.root, scope: f.scope, expectedWriterEpoch: randomUUID() };
    await expect(verifyCloudLocalCommandCheckpoint(input)).rejects.toThrow();
    await expect(restoreCloudLocalCommandCheckpointLedger({ ...input, file: path.join(f.directory, "empty-replacement", "queue.sqlite") })).rejects.toThrow();
  });
});

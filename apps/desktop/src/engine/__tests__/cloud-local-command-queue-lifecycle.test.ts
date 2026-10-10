import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { CloudCommandRuntimeError } from "../cloud-command-client";
import { openSqlite } from "../db/sqlite";
import { createMessage } from "@zeros/protocol/messages";
import { canonicalCloudLocalCommandHistoryJson, canonicalCloudLocalCommandWriterSealDescriptor } from "@zeros/protocol/cloud-local-mirror";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-writer-seal-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1, engineInstanceId: randomUUID(),
    bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actorSessionId = randomUUID(), actor = { userId: scope.fundingOwnerUserId, deviceId: randomUUID(),
    deviceKeyVersion: 1, role: "owner" as const, fingerprint: "a".repeat(64) };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => actors.dispose());
  actors.confirm({ scope, actorSessionId, actor, authorityEpoch: 1, confirmedUntilMs: Date.now() + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" } });
  const normal = openSqlite(path.join(directory, "normal.sqlite")); cleanup.push(() => normal.close());
  normal.pragma("journal_mode = WAL"); normal.pragma("synchronous = NORMAL");
  normal.exec("CREATE TABLE source_head(value INTEGER NOT NULL); INSERT INTO source_head VALUES(7)");
  const file = path.join(directory, "queue.sqlite"), options = { file, scope, actors, engineLive: () => true,
    ready: () => true, history: (): { recordSequence: number; eventSequence: number } => ({ recordSequence: 7, eventSequence: events.head }) };
  const queue = new CloudLocalCommandQueue(options); cleanup.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true }); cleanup.push(() => events.close());
  const quiescent = vi.fn();
  const lifecycleOptions = { file, queue, normalDb: () => normal, assertQuiescent: quiescent,
    heads: (source = normal) => ({ recordSequence: (source.prepare("SELECT value FROM source_head").get() as { value: number }).value, eventSequence: events.head }) };
  const lifecycle = new CloudLocalCommandWriterLifecycle(lifecycleOptions); cleanup.push(() => lifecycle.close());
  const enqueue = () => queue.handle({ kind: "mutate", mutation: { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", model: "model", modeRevision: 0,
      userMessageId: randomUUID(), prompt: [{ type: "text", text: "Synthetic" }] } } }, admissionError: null },
    { writerEpoch: scope.writerEpoch, actorSessionId });
  const drain = () => { for (;;) { const batch = queue.peekMirrorBatch(); if (!batch) break;
    queue.acknowledgeMirror({ version: 1, writerEpoch: scope.writerEpoch, batchId: batch.batchId, through: batch.through }); } };
  const acknowledgement = (seal = lifecycle.seal!) => { const { scope: _scope, ...body } = seal; return { ...body, writerEpoch: scope.writerEpoch }; };
  return { file, scope, queue, options, events, normal, lifecycle, lifecycleOptions, quiescent, enqueue, drain, acknowledgement };
}
describe("FULL writer drain and immutable seal", () => {
  it("does not acknowledge an old seal when NORMAL freeze failed and its head advanced", async () => {
    const f = fixture(), request = vi.fn(async (seal: NonNullable<typeof f.lifecycle.seal>) => f.acknowledgement(seal));
    const ports = { mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {}, request };
    await expect(f.lifecycle.drainAndSeal({ ...ports, freezeNormal: () => { throw new Error("controlled_freeze_failure"); } }))
      .rejects.toThrow("controlled_freeze_failure");
    const seal = f.lifecycle.seal;
    expect(seal?.recordSequence).toBe(7); expect(request).not.toHaveBeenCalled();
    f.normal.prepare("UPDATE source_head SET value=8").run();
    const freezeNormal = vi.fn();
    await expect(f.lifecycle.drainAndSeal({ ...ports, freezeNormal })).rejects.toThrow("command_conflict");
    expect(f.lifecycle.seal).toEqual(seal); expect(request).not.toHaveBeenCalled();
    expect(f.lifecycle.acknowledged).toBe(false);
  });
  it("retries the immutable unknown-ACK seal only with matching frozen NORMAL proof", async () => {
    const f = fixture(), freezeNormal = vi.fn(); let attempts = 0;
    const ports = { mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {}, freezeNormal,
      request: async (seal: NonNullable<typeof f.lifecycle.seal>) => {
        if (++attempts === 1) throw new Error("controlled_ack_loss");
        return f.acknowledgement(seal);
      } };
    await expect(f.lifecycle.drainAndSeal(ports)).rejects.toThrow("controlled_ack_loss");
    const seal = f.lifecycle.seal;
    await f.lifecycle.drainAndSeal(ports);
    expect(f.lifecycle.seal).toEqual(seal); expect(f.lifecycle.acknowledged).toBe(true);
  });
  it("reconciles a lost ACK without reopening the sealed NORMAL writer", async () => {
    const f = fixture(); let frozen = false, attempts = 0;
    const normalDb = vi.fn(() => { if (frozen) throw new Error("NORMAL writer sealed"); return f.normal; });
    f.lifecycleOptions.normalDb = normalDb;
    const freezeNormal = vi.fn(() => { if (!frozen) { f.normal.close(); frozen = true; } });
    const ports = { mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {}, freezeNormal,
      request: async (seal: NonNullable<typeof f.lifecycle.seal>) => {
        if (++attempts === 1) throw new Error("controlled_ack_loss");
        return f.acknowledgement(seal);
      } };
    await expect(f.lifecycle.drainAndSeal(ports)).rejects.toThrow("controlled_ack_loss");
    const opens = normalDb.mock.calls.length, seal = f.lifecycle.seal;
    await f.lifecycle.drainAndSeal(ports);
    expect(normalDb).toHaveBeenCalledTimes(opens); expect(freezeNormal).toHaveBeenCalledTimes(2);
    expect(f.lifecycle.seal).toEqual(seal); expect(f.lifecycle.acknowledged).toBe(true);
  });
  it.each(["retry", "ack"])("refuses changed NORMAL proof at the %s boundary", async boundary => {
    const f = fixture(); let attempts = 0;
    const ports = { mirror: { flush: async () => {} }, retireNative: async () => {}, waitForWork: async () => {}, freezeNormal: vi.fn(),
      request: async (seal: NonNullable<typeof f.lifecycle.seal>) => {
        attempts++;
        if (boundary === "retry") throw new Error("controlled_ack_loss");
        f.normal.prepare("UPDATE source_head SET value=8").run();
        return f.acknowledgement(seal);
      } };
    if (boundary === "retry") {
      await expect(f.lifecycle.drainAndSeal(ports)).rejects.toThrow("controlled_ack_loss");
      f.normal.prepare("UPDATE source_head SET value=8").run();
    }
    await expect(f.lifecycle.drainAndSeal(ports)).rejects.toThrow("command_conflict");
    expect(attempts).toBe(1); expect(f.lifecycle.acknowledged).toBe(false);
    expect(f.lifecycle.seal?.recordSequence).toBe(7);
  });
  it("waits for native/work retirement and exact mirror drain before freezing and sending", async () => {
    const f = fixture(); f.enqueue(); const order: string[] = [];
    const driver = { flush: async () => { order.push("mirror"); f.drain(); } };
    await f.lifecycle.drainAndSeal({ mirror: driver, retireNative: async () => { order.push("native"); },
      waitForWork: async () => { order.push("work"); }, freezeNormal: () => { order.push("freeze"); },
      request: async seal => { order.push("request"); expect(f.lifecycle.seal).toEqual(seal); expect(f.queue.accepting).toBe(false);
        return f.acknowledgement(seal); } });
    expect(order).toEqual(["native", "work", "mirror", "freeze", "request"]); expect(f.lifecycle.acknowledged).toBe(true);
  });
  it("does not send or acknowledge a clean seal when retirement or mirror drain fails", async () => {
    const f = fixture(), request = vi.fn();
    await expect(f.lifecycle.drainAndSeal({ mirror: { flush: async () => {} }, retireNative: async () => { throw new Error("positive proof failed"); },
      waitForWork: async () => {}, freezeNormal: vi.fn(), request })).rejects.toThrow("positive proof failed");
    expect(request).not.toHaveBeenCalled(); expect(f.lifecycle.seal).toBeNull(); expect(f.queue.accepting).toBe(false);
  });
  it("durably fences acceptance before the mirror drain and never invents an empty flight", () => {
    const f = fixture(); f.enqueue(); f.lifecycle.begin();
    expect(() => f.enqueue()).toThrow("cloud_command_writer_retired");
    expect(() => f.lifecycle.createSeal()).toThrow("command_conflict");
    f.drain(); const seal = f.lifecycle.createSeal();
    expect(seal).toMatchObject({ scope: f.scope, recordSequence: 7, eventSequence: 0 });
    expect(f.queue.peekMirrorBatch()).toBeNull(); expect(f.queue.mirrorDrained()).toBe(true);
    expect(f.lifecycle.createSeal()).toEqual(seal); expect(f.lifecycle.acknowledged).toBe(false);
  });
  it("retains the exact descriptor after unknown ACK and refuses a changed ACK", () => {
    const f = fixture(); f.lifecycle.begin(); const seal = f.lifecycle.createSeal();
    expect(() => f.lifecycle.acknowledge({ ...f.acknowledgement(), sha256: "f".repeat(64) })).toThrow("command_response_invalid");
    expect(f.lifecycle.seal).toEqual(seal); expect(f.lifecycle.acknowledged).toBe(false);
    f.lifecycle.acknowledge(f.acknowledgement()); f.lifecycle.acknowledge(f.acknowledgement());
    expect(f.lifecycle.acknowledged).toBe(true);
  });
  it("blocks new event writes after the seal while retaining read-only replay", () => {
    const f = fixture(); f.events.append({ ...createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["messages"] }),
      cloudStream: { streamId: f.scope.engineInstanceId, sequence: 1 } });
    f.lifecycle.begin(); f.lifecycle.createSeal();
    expect(() => f.events.append({ ...createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["messages"] }),
      cloudStream: { streamId: f.scope.engineInstanceId, sequence: 2 } }))
      .toThrow("cloud_command_writer_retired");
    expect(f.events.head).toBe(1);
  });
  it("refuses seal before positive native quiescence and allows the exact retry", () => {
    const f = fixture(); f.lifecycle.begin(); f.quiescent.mockImplementationOnce(() => { throw new Error("Native scope still owns work"); });
    expect(() => f.lifecycle.createSeal()).toThrow("Native scope still owns work"); expect(f.lifecycle.seal).toBeNull();
    expect(f.lifecycle.createSeal().sequence).toBe(0);
  });
  it("refuses NORMAL transaction/no-WAL and restores the existing busy timeout", () => {
    const f = fixture(); f.lifecycle.begin();
    const timeout = f.normal.prepare("PRAGMA busy_timeout").get();
    f.normal.exec("BEGIN IMMEDIATE");
    expect(() => f.lifecycle.createSeal()).toThrow("command_storage_unavailable"); f.normal.exec("ROLLBACK");
    expect(f.normal.prepare("PRAGMA busy_timeout").get()).toEqual(timeout);
    f.normal.pragma("journal_mode = DELETE"); expect(() => f.lifecycle.createSeal()).toThrow("command_storage_unavailable");
    expect(f.lifecycle.seal).toBeNull();
  });
  it("does not reopen a sealed writer as a fresh runnable process", () => {
    const f = fixture(); f.lifecycle.begin(); f.lifecycle.createSeal(); f.lifecycle.acknowledge(f.acknowledgement());
    f.lifecycle.close(); f.events.close(); f.queue.close();
    expect(() => new CloudLocalCommandQueue(f.options)).toThrow("cloud_command_writer_retired");
  });
  it("binds the seal to the actual event cursor and immutable current-head inventory", () => {
    const f = fixture(); f.lifecycle.begin(); f.drain();
    const original = f.lifecycleOptions.heads;
    f.lifecycleOptions.heads = () => ({ recordSequence: 7, eventSequence: 9 });
    expect(() => f.lifecycle.createSeal()).toThrow("command_conflict");
    f.lifecycleOptions.heads = original; const seal = f.lifecycle.createSeal();
    expect(seal.inventorySha256).toMatch(/^[a-f0-9]{64}$/); expect(seal.sha256).not.toBe(seal.inventorySha256);
  });
});

describe("passive acknowledged seal read", () => {
  const freeze = async (f: ReturnType<typeof fixture>) => {
    await f.lifecycle.drainAndSeal({ mirror: { flush: async () => f.drain() }, retireNative: async () => {},
      waitForWork: async () => {}, freezeNormal: () => f.normal.close(), request: async seal => f.acknowledgement(seal) });
    return f.lifecycle.seal!;
  };
  const ledger = (f: ReturnType<typeof fixture>) => {
    const db = openSqlite(f.file, { fileMustExist: true }); cleanup.push(() => db.close()); return db;
  };

  it("returns null before a seal and before its ACK without establishing a NORMAL proof", () => {
    const f = fixture(), normalDb = vi.spyOn(f.lifecycleOptions, "normalDb");
    expect(f.lifecycle.readAcknowledgedSeal()).toBeNull(); expect(normalDb).not.toHaveBeenCalled();
    f.lifecycle.begin(); f.lifecycle.createSeal(); normalDb.mockClear(); f.quiescent.mockClear();
    expect(f.lifecycle.readAcknowledgedSeal()).toBeNull(); expect(normalDb).not.toHaveBeenCalled();
    expect(f.quiescent).not.toHaveBeenCalled(); expect(f.lifecycle.acknowledged).toBe(false);
  });
  it("refuses a directly stored ACK that never completed the original NORMAL freeze", () => {
    const f = fixture(); f.lifecycle.begin(); f.lifecycle.createSeal(); f.lifecycle.acknowledge(f.acknowledgement());
    expect(f.lifecycle.acknowledged).toBe(true);
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow("command_conflict");
  });
  it("returns the exact current seal using read-only NORMAL with no capture, checkpoint or ledger writes", async () => {
    const f = fixture(), seal = await freeze(f), normalDb = vi.spyOn(f.lifecycleOptions, "normalDb");
    const heads = vi.spyOn(f.lifecycleOptions, "heads"), capture = vi.spyOn(f.lifecycle, "captureCheckpoint");
    const changes = () => f.lifecycle["db"].prepare("SELECT total_changes() AS count").get();
    const before = changes(), pragma = vi.spyOn(f.lifecycle["db"], "pragma"), exec = vi.spyOn(f.lifecycle["db"], "exec");
    expect(f.lifecycle.readAcknowledgedSeal()).toEqual(seal);
    expect(f.lifecycle.readAcknowledgedSeal()).toEqual(seal);
    expect(heads).toHaveBeenCalledTimes(2); expect(heads.mock.calls.every(([source]) => source?.readonly === true)).toBe(true);
    expect(normalDb).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
    expect(pragma).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(changes()).toEqual(before);
    expect(f.queue.mirrorDrained()).toBe(true); expect(f.queue.accepting).toBe(false);
  });
  it("refuses a NORMAL head changed after an earlier positive passive read", async () => {
    const f = fixture(), seal = await freeze(f);
    expect(f.lifecycle.readAcknowledgedSeal()).toEqual(seal);
    const normal = openSqlite(path.join(path.dirname(f.file), "normal.sqlite"), { fileMustExist: true });
    cleanup.push(() => normal.close()); normal.prepare("UPDATE source_head SET value=8").run();
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow("command_conflict");
    expect(f.lifecycle.seal).toEqual(seal);
  });
  it.each(["json", "mismatched-ack", "changed-pair", "rehashed-pair", "oversized-ack"])("refuses %s stored proof", async kind => {
    const f = fixture(), seal = await freeze(f), db = ledger(f);
    if (kind === "json") db.prepare("UPDATE local_command_writer_seals SET document=?").run("{");
    else if (kind === "mismatched-ack") db.prepare("UPDATE local_command_writer_seals SET ack=?")
      .run(canonicalCloudLocalCommandHistoryJson({ ...f.acknowledgement(seal), sealId: randomUUID() }));
    else if (kind === "oversized-ack") db.prepare("UPDATE local_command_writer_seals SET ack=?").run(" ".repeat(16 * 1024 + 1));
    else {
      const changed = { ...seal, sealId: randomUUID() };
      if (kind === "rehashed-pair") changed.sha256 = createHash("sha256").update(canonicalCloudLocalCommandWriterSealDescriptor(changed)).digest("hex");
      db.prepare("UPDATE local_command_writer_seals SET document=?,ack=?")
        .run(canonicalCloudLocalCommandHistoryJson(changed), canonicalCloudLocalCommandHistoryJson(f.acknowledgement(changed)));
    }
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow(kind === "rehashed-pair" ? "command_conflict" : "command_response_invalid");
  });
  it("refuses changed FULL inventory despite unchanged seal, ACK and watermarks", async () => {
    const f = fixture(); f.enqueue(); const seal = await freeze(f);
    ledger(f).prepare("UPDATE local_commands SET result_code='command_context_changed'").run();
    expect(f.queue.mirrorDrained()).toBe(true); expect(f.lifecycle.seal).toEqual(seal);
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow("command_conflict");
  });
  it.each(["dirty", "flight", "journal", "mirror", "sealed-writer"])("refuses current %s ledger drift", async kind => {
    const f = fixture(); if (kind === "dirty") f.enqueue();
    const seal = await freeze(f), db = ledger(f);
    if (kind === "dirty") db.prepare("UPDATE local_commands SET mirror_dirty=1").run();
    else if (kind === "flight") db.prepare("INSERT INTO local_command_mirror_batches VALUES(?,?,?,?,?)")
      .run(f.scope.writerEpoch, randomUUID(), seal.sequence, seal.sequence + 1, "{}");
    else if (kind === "sealed-writer") db.prepare("DELETE FROM local_command_metadata WHERE key='sealedWriter'").run();
    else db.prepare("INSERT OR REPLACE INTO local_command_metadata VALUES(?,?)").run(kind === "journal" ? "journalHead" : "mirrorHead", String(seal.sequence + 1));
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow("command_conflict");
  });
  it.each(["journalHead", "mirrorHead"])("refuses a BLOB %s instead of normalizing it into a valid cursor", async key => {
    const f = fixture(), seal = await freeze(f);
    ledger(f).prepare("INSERT OR REPLACE INTO local_command_metadata VALUES(?,?)").run(key, Buffer.from(String(seal.sequence)));
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow("command_storage_unavailable");
  });
  it.each(["authority", "closed", "quiescence"])("refuses lost %s at read time", async kind => {
    const f = fixture(); await freeze(f);
    if (kind === "authority") f.options.engineLive = () => false;
    else if (kind === "closed") f.lifecycle.close();
    else f.quiescent.mockImplementation(() => { throw new CloudCommandRuntimeError("command_conflict"); });
    expect(() => f.lifecycle.readAcknowledgedSeal()).toThrow(kind === "quiescence" ? "command_conflict" : "engine_authority_rejected");
  });
});

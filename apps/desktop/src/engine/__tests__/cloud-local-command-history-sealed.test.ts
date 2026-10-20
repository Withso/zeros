import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessage } from "@zeros/protocol/messages";
import { CloudBootCommandClaimSchema } from "@zeros/protocol/cloud-commands";
import { CloudActorAuthorityRegistry } from "../agents/cloud-actor-authority";
import { CloudLocalCommandQueue } from "../cloud-local-command-queue";
import { CloudLocalCommandEventStore } from "../cloud-local-command-queue-events";
import { CloudLocalCommandWriterLifecycle } from "../cloud-local-command-queue-lifecycle";
import { restoreCloudLocalCommandCheckpointLedger, verifiedCloudLocalCommandPredecessor } from "../cloud-local-command-queue-checkpoint";
import { captureCloudLocalCommandHistory } from "../cloud-local-command-queue-history";
import { rebuildCloudLocalCommandHistory } from "../cloud-local-command-queue-history-rebuild";
import { runMigrations } from "../db/migrations";
import { openSqlite } from "../db/sqlite";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const rows = (db: Sqlite.Database) => db.prepare("SELECT msg_id,ord,payload FROM chat_messages WHERE chat_id='chat' ORDER BY ord").all();
function normal(file: string) {
  const db = openSqlite(file); cleanup.push(() => { if (db.open) db.close(); });
  runMigrations(db); db.pragma("journal_mode=WAL"); db.pragma("synchronous=NORMAL"); return db;
}
function drain(queue: CloudLocalCommandQueue) {
  const changes = [];
  for (let flight = 0; flight < 2048; flight++) {
    const batch = queue.peekMirrorBatch();
    if (!batch) { expect(queue.mirrorDrained()).toBe(true); return changes; }
    changes.push(...batch.changes);
    queue.acknowledgeMirror({ version: 1, writerEpoch: queue.scope.writerEpoch, batchId: batch.batchId, through: batch.through });
  }
  throw new Error("Synthetic mirror failed to drain");
}
async function fixture(operation: "edit" | "prune" | "delete" | "none", beforeSeal?: (db: Sqlite.Database) => void,
  duringInstall?: "replace-normal" | "change-normal", options?: {
    beforeCapture?: (db: Sqlite.Database) => void; sibling?: boolean; events?: number; terminal?: "succeeded" | "cancelled";
  }) {
  const root = mkdtempSync(join(tmpdir(), "zeros-sealed-transcript-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const repositoryRoot = join(root, "repository"), file = join(root, "queue.sqlite"), checkpointRoot = join(root, "checkpoint");
  const db = normal(join(root, "normal.sqlite")), now = 1_000_000;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1 };
  const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true, time: { wall: () => now, monotonic: () => 0 } });
  cleanup.push(() => actors.dispose());
  const actorSessionId = randomUUID();
  actors.confirm({ scope, actorSessionId, authorityEpoch: 1, confirmedUntilMs: now + 9_000,
    fundingConsentVersion: 1, fundingGrant: { kind: "owner" }, actor: { userId: scope.fundingOwnerUserId,
      deviceId: randomUUID(), deviceKeyVersion: 1, fingerprint: "a".repeat(64), role: "owner" } });
  const recordSequence = (source = db) => (source.prepare("SELECT next_rev-1 AS rev FROM sync_meta WHERE id=0").get() as { rev: number }).rev;
  const queue = new CloudLocalCommandQueue({ file, scope, actors, engineLive: () => true, ready: () => true, now: () => now,
    history: () => ({ recordSequence: recordSequence(), eventSequence: events.head }),
    captureHistory: input => captureCloudLocalCommandHistory({ ...input, db, repositoryRoot,
      redactDocument: value => value, controls: [] }) });
  cleanup.push(() => queue.close());
  const events = new CloudLocalCommandEventStore({ file, queue, engineLive: () => true }); cleanup.push(() => events.close());
  for (let index = 0; index < (options?.events ?? 0); index++) events.append(createMessage({ type: "DB_CHANGED", source: "engine", kinds: ["messages"],
    cloudStream: { streamId: events.streamId, sequence: events.head + 1 } }));
  db.prepare("INSERT INTO chats(id,folder,agent_id,title,session_id,created_at,updated_at,rev) VALUES('chat',?,'claude','Original title','old-native',1,2,1)").run(repositoryRoot);
  const insert = db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat',?,?, 'text',?,?,?)");
  for (let index = 0; index < 17; index++) insert.run(index === 0 ? "turn" : `message-${index}`, index,
    JSON.stringify({ role: index === 0 ? "user" : "assistant", text: `Synthetic transcript ${index}` }), index + 1, index + 2);
  db.prepare("INSERT INTO turns(chat_id,turn_id,folder,agent_id,ord,started_at,ended_at,status,rev) VALUES('chat','turn',?,'claude',0,1,18,'completed',19)").run(repositoryRoot);
  db.prepare("UPDATE sync_meta SET next_rev=20 WHERE id=0").run();
  options?.beforeCapture?.(db);
  if (options?.sibling) {
    db.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES('sibling',?,'Sibling',1,1,1)").run(repositoryRoot);
    db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('sibling','sibling-message',0,'text','{}',1,1)").run();
  }
  queue.handle({ kind: "mutate", admissionError: null, mutation: { conversationId: "chat", operationId: randomUUID(), expectedRevision: 0,
    action: { kind: "enqueue", commandId: randomUUID(), payload: { agentId: "claude", userMessageId: "turn", model: "fixture-model",
      modeRevision: 0, prompt: [{ type: "text", text: "Synthetic transcript fixture" }] } } } }, { actorSessionId, writerEpoch: scope.writerEpoch });
  const claim = CloudBootCommandClaimSchema.parse(queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
    { writerEpoch: scope.writerEpoch }));
  queue.handle({ kind: "settle", result: { commandId: claim.commandId, claimId: claim.claimId, state: options?.terminal ?? "succeeded",
    resultCode: null, result: { version: 1 } } }, { writerEpoch: scope.writerEpoch });
  expect(queue.currentHistoryHead("chat")!.history).toHaveProperty(options?.beforeCapture ? "incompleteReason" : "manifestSha256");
  const before = rows(db);
  // These are the real NORMAL effects of metadata update, truncate and delete.
  // The same FULL mutation API publishes the newer accepted fence afterwards.
  if (operation === "edit") db.prepare("UPDATE chats SET title='Updated title',updated_at=20,rev=20 WHERE id='chat'").run();
  if (operation === "prune") db.prepare("DELETE FROM chat_messages WHERE chat_id='chat' AND ord>=8").run();
  if (operation === "delete") {
    // deleteChat removes the chat and records its tombstone. Orphaned message
    // and turn storage is not permission to resurrect that deleted chat.
    db.prepare("DELETE FROM chats WHERE id='chat'").run();
    db.prepare("INSERT INTO sync_tombstones(kind,id,rev) VALUES('chat','chat',20)").run();
  }
  db.prepare("UPDATE sync_meta SET next_rev=21 WHERE id=0").run();
  const latest = operation === "none" ? queue.currentHistoryHead("chat")! : queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation,
    deleted: operation === "delete", recordSequence: recordSequence(), eventSequence: events.head });
  if (options?.sibling) queue.publishHistoryMutation({ conversationId: "sibling", mutationId: randomUUID(), operation: "edit",
    deleted: false, recordSequence: recordSequence(), eventSequence: 0 });
  beforeSeal?.(db);
  const expected = operation === "delete" ? [] : rows(db), lifecycle = new CloudLocalCommandWriterLifecycle({ file, queue, normalDb: () => db,
    heads: source => ({ recordSequence: recordSequence(source), eventSequence: events.head }), assertQuiescent: () => {} });
  cleanup.push(() => lifecycle.close());
  const mirror = { flush: async () => { drain(queue); } };
  await lifecycle.drainAndSeal({ mirror, retireNative: async () => {}, waitForWork: async () => {}, freezeNormal: () => db.close(),
    request: async seal => { const { scope: _scope, ...ack } = seal; return { ...ack, writerEpoch: scope.writerEpoch }; } });
  await lifecycle.captureCheckpoint(checkpointRoot);
  lifecycle.close(); events.close(); queue.close();
  if (duringInstall) {
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (from,to) => {
      await rename(from,to);
      if (String(to) !== file) return;
      const candidate = readdirSync(checkpointRoot).find(name => name.startsWith(".verified-"));
      expect(candidate).toBeDefined();
      const normalFile = join(checkpointRoot,candidate!,"normal.sqlite");
      if (duringInstall === "replace-normal") {
        const replacement = join(root,"replacement.sqlite"); copyFileSync(normalFile,replacement); renameSync(replacement,normalFile);
      } else {
        const writer = openSqlite(normalFile);
        try { writer.prepare("UPDATE chat_messages SET payload='{}' WHERE msg_id='turn'").run(); }
        finally { writer.close(); }
      }
    });
    cleanup.push(() => { vi.mocked(fs.rename).mockImplementation(rename); });
  }
  const verified = await restoreCloudLocalCommandCheckpointLedger({ root: checkpointRoot, file, scope, expectedWriterEpoch: scope.writerEpoch });
  cleanup.push(verified.cleanup);
  const ledger = openSqlite(verified.ledgerFile, { readonly: true, fileMustExist: true }); cleanup.push(() => { if (ledger.open) ledger.close(); });
  const target = normal(join(root, "restored-normal.sqlite"));
  const input = { db: target, ledger, scope, sourceSeal: verified.manifest.seal, repositoryRoot, conversationId: "chat", sealedCheckpoint: verified };
  return { before, expected, latest, target, input, verified, scope, root, file, checkpointRoot, recordSequence };
}

describe("sealed NORMAL transcript survives a newer incomplete FULL mutation", () => {
  it.each(["replace-normal", "change-normal"] as const)("refuses %s between verification and capability mint", async mutation => {
    await expect(fixture("edit",undefined,mutation)).rejects.toThrow("checkpoint_restore_identity");
  });
  it.each(["edit", "prune", "delete"] as const)("restores the exact sealed %s state without borrowing an older complete snapshot", async operation => {
    const f = await fixture(operation);
    expect(f.before).toHaveLength(17);
    expect(f.latest.history).toHaveProperty("incompleteReason", "capture_unavailable");
    f.target.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES('chat',?,'Stale target',1,1,1)").run(f.input.repositoryRoot);
    f.target.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat','stale-target',0,'text','{}',1,1)").run();
    rebuildCloudLocalCommandHistory(f.input);
    expect(rows(f.target)).toEqual(f.expected);
    if (operation === "edit") {
      expect(f.target.prepare("SELECT title,session_id,provider_binding,provider_metadata FROM chats WHERE id='chat'").get())
        .toEqual({ title: "Updated title", session_id: null, provider_binding: null, provider_metadata: null });
      expect(f.target.prepare("SELECT turn_id FROM turns WHERE chat_id='chat'").all()).toEqual([{ turn_id: "turn" }]);
    }
    if (operation === "delete") expect(f.target.prepare("SELECT id FROM chats WHERE id='chat'").all()).toEqual([]);
    expect(JSON.parse((f.target.prepare("SELECT value FROM settings WHERE key LIKE 'cloud-canonical-history-rebuild-v1:%'").get() as { value: string }).value).historyHead)
      .toEqual(f.latest);
  });
  it("does not parse or restore native/provider bindings from the sealed transcript source", async () => {
    const f = await fixture("edit",db => db.prepare("UPDATE chats SET provider_binding='invalid-native-binding',provider_metadata='invalid-native-metadata' WHERE id='chat'").run());
    rebuildCloudLocalCommandHistory(f.input);
    expect(rows(f.target)).toEqual(f.expected);
    expect(f.target.prepare("SELECT session_id,provider_binding,provider_metadata FROM chats WHERE id='chat'").get())
      .toEqual({ session_id: null, provider_binding: null, provider_metadata: null });
  });
  it.each(["messages", "turns", "metadata"] as const)(
    "preserves oversized sealed %s locally with unknown completeness", async oversized => {
      const f = await fixture("edit",db => {
        if (oversized === "messages") db.prepare("UPDATE chat_messages SET payload=? WHERE msg_id='turn'").run(JSON.stringify({ text: "x".repeat(16 * 1024 * 1024) }));
        if (oversized === "turns") db.prepare("UPDATE turns SET summary=? WHERE turn_id='turn'").run("x".repeat(16 * 1024 * 1024));
        if (oversized === "metadata") db.prepare("UPDATE chats SET title=? WHERE id='chat'").run("x".repeat(16 * 1024 * 1024));
      });
      expect(rebuildCloudLocalCommandHistory(f.input)).toMatchObject({ restored: true, historyHead: f.latest });
      expect(rows(f.target)).toEqual(f.expected);
      if (oversized === "turns") expect(f.target.prepare("SELECT length(summary) AS n FROM turns WHERE turn_id='turn'").get()).toEqual({ n: 16 * 1024 * 1024 });
      if (oversized === "metadata") expect(f.target.prepare("SELECT length(title) AS n FROM chats WHERE id='chat'").get()).toEqual({ n: 16 * 1024 * 1024 });
      const changes = f.target.prepare("SELECT total_changes() AS n").get();
      rebuildCloudLocalCommandHistory(f.input);
      expect(f.target.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    });
  it.each([20_000,100_000])("restores %i rows after capture history_limit without blocking a sibling or changing the incomplete head", async count => {
    const f = await fixture("none",undefined,undefined,{ sibling: true, beforeCapture: db => db.transaction(() => {
      const insert = db.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat',?,?,'text',?,1,1)");
      const payload = JSON.stringify({ role: "assistant", text: "Synthetic long history ".repeat(count === 20_000 ? 48 : 9) });
      for (let index = 17; index < count; index++) insert.run(`long-${String(index).padStart(6,"0")}`,index,payload);
    })() });
    expect(f.latest.history).toHaveProperty("incompleteReason","history_limit");
    for (const conversationId of ["chat","sibling"]) {
      expect(rebuildCloudLocalCommandHistory({ ...f.input,conversationId })).toHaveProperty("restored",true);
    }
    expect(rows(f.target)).toEqual(f.expected);
    expect(f.target.prepare("SELECT count(*) AS n FROM chat_messages WHERE chat_id='chat'").get()).toEqual({ n: count });
    expect(f.target.prepare("SELECT msg_id FROM chat_messages WHERE chat_id='sibling'").all()).toEqual([{ msg_id: "sibling-message" }]);
    const fence = JSON.parse((f.target.prepare("SELECT value FROM settings WHERE key LIKE 'cloud-canonical-history-rebuild-v1:%' AND value LIKE '%history_limit%'").get() as { value: string }).value);
    expect(fence.historyHead).toEqual(f.latest);
    f.input.ledger.close();
    const proof = openSqlite(f.file,{ readonly: true });
    expect(verifiedCloudLocalCommandPredecessor(f.verified.predecessor,f.file,proof)).toEqual(f.scope); proof.close();
    const scope = { ...f.scope, generation: f.scope.generation + (count === 100_000 ? 1 : 0),
      writerEpoch: randomUUID(), engineInstanceId: randomUUID(), bootId: randomUUID() };
    const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => actors.dispose());
    const queue = new CloudLocalCommandQueue({ file: f.file, scope, actors, engineLive: () => true, ready: () => true,
      history: () => ({ recordSequence: f.recordSequence(f.target), eventSequence: 0 }) }); cleanup.push(() => queue.close());
    const changes = drain(queue);
    expect(changes.filter(change => change.conversationId === "chat" && change.historyHead).at(-1)?.historyHead).toEqual(f.latest);
    expect(changes.some(change => change.conversationId === "sibling" && change.historyHead)).toBe(true);
    expect(changes.some(change => change.historyPart || change.event)).toBe(false);
    expect(queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
      { writerEpoch: scope.writerEpoch })).toBeNull();
  },30_000);
  it("rolls back every copied row when the sealed source changes during the final turn copy", async () => {
    const f = await fixture("edit");
    f.target.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES('chat',?,'Retained',1,1,1)").run(f.input.repositoryRoot);
    f.target.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat','retained',0,'text','{}',1,1)").run();
    const before = rows(f.target), prepare = f.target.prepare.bind(f.target);
    let replaced = false;
    const intercept = vi.spyOn(f.target,"prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (sql.startsWith("INSERT INTO turns(")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement,"run").mockImplementation((...parameters: unknown[]) => {
          const result = run(...parameters);
          const replacement = join(f.root,"late-replacement.sqlite");
          copyFileSync(f.verified.normalFile,replacement); renameSync(replacement,f.verified.normalFile); replaced = true;
          return result;
        });
      }
      return statement;
    });
    try { expect(() => rebuildCloudLocalCommandHistory(f.input)).toThrow("cloud_history_rebuild_refused"); }
    finally { intercept.mockRestore(); }
    expect(replaced).toBe(true);
    expect(rows(f.target)).toEqual(before);
    expect(f.target.prepare("SELECT title FROM chats WHERE id='chat'").get()).toEqual({ title: "Retained" });
    expect(f.target.prepare("SELECT * FROM settings WHERE key LIKE 'cloud-canonical-history-rebuild-v1:%'").all()).toEqual([]);
  });
  it.each(["future-revision", "foreign-turn-root"] as const)(
    "refuses sealed %s before modifying the destination", async mismatch => {
      const f = await fixture("edit",db => {
        if (mismatch === "future-revision") db.prepare("UPDATE chat_messages SET rev=100 WHERE msg_id='turn'").run();
        if (mismatch === "foreign-turn-root") db.prepare("UPDATE turns SET folder='/foreign-root' WHERE turn_id='turn'").run();
      });
      f.target.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES('chat',?,'Retained',1,1,1)").run(f.input.repositoryRoot);
      f.target.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat','retained',0,'text','{}',1,1)").run();
      const before = rows(f.target);
      expect(() => rebuildCloudLocalCommandHistory(f.input)).toThrow("cloud_history_rebuild_refused");
      expect(rows(f.target)).toEqual(before);
    });
  it.each(["same-generation", "replacement"] as const)("preserves and republishes history through six sealed %s handoffs without inherited dispatch", async kind => {
    const f = await fixture("none");
    let source = f.verified, ledger = f.input.ledger, target = f.target, lastHead = f.latest;
    for (let cycle = 1; cycle <= 6; cycle++) {
      rebuildCloudLocalCommandHistory({ ...f.input, db: target, ledger, scope: source.manifest.seal.scope,
        sourceSeal: source.manifest.seal, sealedCheckpoint: source });
      expect(rows(target)).toEqual(f.expected);
      expect(target.prepare("SELECT session_id,provider_binding,provider_metadata FROM chats WHERE id='chat'").get())
        .toEqual({ session_id: null, provider_binding: null, provider_metadata: null });
      ledger.close();
      const prior = source.manifest.seal.scope, scope = { ...prior, generation: prior.generation + (kind === "replacement" ? 1 : 0),
        writerEpoch: randomUUID(), engineInstanceId: randomUUID(), bootId: randomUUID() };
      const proof = openSqlite(f.file,{ readonly: true });
      expect(verifiedCloudLocalCommandPredecessor(source.predecessor,f.file,proof)).toEqual(prior); proof.close();
      const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => actors.dispose());
      const queue = new CloudLocalCommandQueue({ file: f.file, scope, actors, engineLive: () => true, ready: () => true,
        history: () => ({ recordSequence: f.recordSequence(target), eventSequence: 0 }) }); cleanup.push(() => queue.close());
      const changes = drain(queue);
      expect(changes.filter(change => change.historyHead).at(-1)?.historyHead).toEqual(lastHead);
      expect(changes.some(change => change.historyPart || change.event)).toBe(false);
      expect(changes.filter(change => change.entry)).toHaveLength(1);
      expect(changes.find(change => change.entry)?.entry?.state).toBe("succeeded");
      expect(queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
        { writerEpoch: scope.writerEpoch })).toBeNull();
      const events = new CloudLocalCommandEventStore({ file: f.file, queue, engineLive: () => true }); cleanup.push(() => events.close());
      const rev = f.recordSequence(target) + 1;
      target.prepare("UPDATE chats SET title=?,rev=? WHERE id='chat'").run(`Synthetic title ${cycle}`,rev);
      target.prepare("UPDATE sync_meta SET next_rev=? WHERE id=0").run(rev + 1);
      lastHead = queue.publishHistoryMutation({ conversationId: "chat", mutationId: randomUUID(), operation: "edit", deleted: false,
        recordSequence: rev, eventSequence: 0 });
      const db = target, lifecycle = new CloudLocalCommandWriterLifecycle({ file: f.file, queue, normalDb: () => db,
        heads: (normal = db) => ({ recordSequence: f.recordSequence(normal), eventSequence: events.head }), assertQuiescent: () => {} });
      cleanup.push(() => lifecycle.close());
      await lifecycle.drainAndSeal({ mirror: { flush: async () => { drain(queue); } }, retireNative: async () => {}, waitForWork: async () => {},
        freezeNormal: () => db.close(), request: async seal => { const { scope: _scope, ...ack } = seal; return { ...ack, writerEpoch: scope.writerEpoch }; } });
      await lifecycle.captureCheckpoint(f.checkpointRoot);
      lifecycle.close(); events.close(); queue.close();
      source = await restoreCloudLocalCommandCheckpointLedger({ root: f.checkpointRoot, file: f.file, scope,
        expectedWriterEpoch: scope.writerEpoch }); cleanup.push(source.cleanup);
      ledger = openSqlite(source.ledgerFile,{ readonly: true }); const current = ledger; cleanup.push(() => { if (current.open) current.close(); });
      target = normal(join(f.root,`restored-${cycle}.sqlite`));
    }
    rebuildCloudLocalCommandHistory({ ...f.input, db: target, ledger, scope: source.manifest.seal.scope,
      sourceSeal: source.manifest.seal, sealedCheckpoint: source });
    expect(rows(target)).toEqual(f.expected);
    expect(target.prepare("SELECT title FROM chats WHERE id='chat'").get()).toEqual({ title: "Synthetic title 6" });
  });
  it.each([
    { kind: "same-generation", terminal: "succeeded", source: "command" }, { kind: "same-generation", terminal: "cancelled", source: "command" },
    { kind: "replacement", terminal: "succeeded", source: "command" }, { kind: "replacement", terminal: "cancelled", source: "command" },
    { kind: "same-generation", terminal: "succeeded", source: "mutation" }, { kind: "replacement", terminal: "succeeded", source: "mutation" },
  ] as const)("restores retained $terminal $source history after an idle $kind writer seals a lower event cursor", async ({ kind, terminal, source: sourceKind }) => {
    const f = await fixture(sourceKind === "command" ? "none" : "edit", undefined, undefined, { events: 8, terminal });
    expect(f.latest.history.eventSequence).toBe(8);
    expect(f.latest.source.kind).toBe(sourceKind);
    let source = f.verified, ledger = f.input.ledger, target = f.target;
    for (let cycle = 0; cycle < 3; cycle++) {
      // Rebuild the unchanged historical head on each wake. The intervening
      // idle stop creates an acknowledged seal for its own empty event stream.
      expect(rebuildCloudLocalCommandHistory({ ...f.input, db: target, ledger, scope: source.manifest.seal.scope,
        sourceSeal: source.manifest.seal, sealedCheckpoint: source })).toMatchObject({ historyHead: f.latest, restored: true });
      expect(rows(target)).toEqual(f.expected);
      expect(target.prepare("SELECT session_id,provider_binding,provider_metadata FROM chats WHERE id='chat'").get())
        .toEqual({ session_id: null, provider_binding: null, provider_metadata: null });
      ledger.close();
      if (cycle === 2) break;
      const prior = source.manifest.seal.scope, scope = { ...prior, generation: prior.generation + (kind === "replacement" ? 1 : 0),
        writerEpoch: randomUUID(), engineInstanceId: randomUUID(), bootId: randomUUID() };
      const proof = openSqlite(f.file, { readonly: true });
      try { expect(verifiedCloudLocalCommandPredecessor(source.predecessor, f.file, proof)).toEqual(prior); }
      finally { proof.close(); }
      const actors = new CloudActorAuthorityRegistry({ scope, engineLive: () => true }); cleanup.push(() => actors.dispose());
      const queue = new CloudLocalCommandQueue({ file: f.file, scope, actors, engineLive: () => true, ready: () => true,
        history: () => ({ recordSequence: f.recordSequence(target), eventSequence: 0 }) }); cleanup.push(() => queue.close());
      const changes = drain(queue);
      expect(changes.filter(change => change.historyHead).at(-1)?.historyHead).toEqual(f.latest);
      expect(changes.some(change => change.historyPart || change.event)).toBe(false);
      expect(queue.handle({ kind: "claim", conversationId: "chat", claimId: randomUUID(), executionId: randomUUID() },
        { writerEpoch: scope.writerEpoch })).toBeNull();
      const events = new CloudLocalCommandEventStore({ file: f.file, queue, engineLive: () => true }); cleanup.push(() => events.close());
      expect(events.head).toBe(0);
      const db = target, lifecycle = new CloudLocalCommandWriterLifecycle({ file: f.file, queue, normalDb: () => db,
        heads: (normal = db) => ({ recordSequence: f.recordSequence(normal), eventSequence: events.head }), assertQuiescent: () => {} });
      cleanup.push(() => lifecycle.close());
      await lifecycle.drainAndSeal({ mirror: { flush: async () => { drain(queue); } }, retireNative: async () => {}, waitForWork: async () => {},
        freezeNormal: () => db.close(), request: async seal => {
          expect(seal.eventSequence).toBe(0);
          const { scope: _scope, ...ack } = seal; return { ...ack, writerEpoch: scope.writerEpoch };
        } });
      await lifecycle.captureCheckpoint(f.checkpointRoot);
      lifecycle.close(); events.close(); queue.close();
      source = await restoreCloudLocalCommandCheckpointLedger({ root: f.checkpointRoot, file: f.file, scope, expectedWriterEpoch: scope.writerEpoch });
      cleanup.push(source.cleanup);
      ledger = openSqlite(source.ledgerFile, { readonly: true }); const current = ledger; cleanup.push(() => { if (current.open) current.close(); });
      target = normal(join(f.root, `idle-restored-${cycle}.sqlite`));
    }
  });
  it.each(["copied-receipt", "missing-receipt", "replaced-normal", "changed-normal", "normal-wal", "foreign-ledger", "foreign-root", "unsealed-recovery"] as const)(
    "refuses %s before changing the destination transcript", async mismatch => {
      const f = await fixture("edit");
      f.target.prepare("INSERT INTO chats(id,folder,title,created_at,updated_at,rev) VALUES('chat',?,'Retained',1,1,1)").run(f.input.repositoryRoot);
      f.target.prepare("INSERT INTO chat_messages(chat_id,msg_id,ord,kind,payload,created_at,rev) VALUES('chat','retained',0,'text','{}',1,1)").run();
      const before = rows(f.target);
      if (mismatch === "copied-receipt") f.input.sealedCheckpoint = { ...f.verified, predecessor: { scope: { ...f.scope } } };
      if (mismatch === "missing-receipt") f.input.sealedCheckpoint = { ...f.verified, predecessor: null };
      if (mismatch === "replaced-normal") {
        const copy = join(f.root, "substitute.sqlite"); copyFileSync(f.verified.normalFile,copy); renameSync(copy,f.verified.normalFile);
      }
      if (mismatch === "changed-normal" || mismatch === "normal-wal") {
        const writer = openSqlite(f.verified.normalFile); cleanup.push(() => { if (writer.open) writer.close(); });
        writer.prepare("UPDATE chat_messages SET payload='{}' WHERE msg_id='turn'").run();
        if (mismatch === "changed-normal") writer.close();
      }
      if (mismatch === "foreign-ledger") {
        const file = join(f.root,"foreign.sqlite"); copyFileSync(f.verified.ledgerFile,file);
        f.input.ledger = openSqlite(file,{ readonly: true }); const ledger = f.input.ledger; cleanup.push(() => { ledger.close(); });
      }
      if (mismatch === "foreign-root") f.input.repositoryRoot = join(f.root,"other-repository");
      const { sourceSeal: _sourceSeal, ...recovery } = f.input;
      const input = mismatch === "unsealed-recovery" ? { ...recovery, sourceRecovery: f.verified.predecessor! } : f.input;
      expect(() => rebuildCloudLocalCommandHistory(input)).toThrow("cloud_history_rebuild_refused");
      expect(rows(f.target)).toEqual(before);
      expect(f.target.prepare("SELECT * FROM settings WHERE key LIKE 'cloud-canonical-history-rebuild-v1:%'").all()).toEqual([]);
    });
});

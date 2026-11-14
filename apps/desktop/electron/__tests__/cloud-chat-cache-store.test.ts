import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CloudChatCacheStore } from "../cloud-chat-cache/store";
import type { CloudCacheKey, CloudCacheRange, CloudCacheRow } from "../../shared/cloud-chat-cache";
import type { CloudV2PromptStatus } from "@zeros/protocol/cloud-v2-prompts";

const directories: string[] = [];
const stores: CloudChatCacheStore[] = [];
const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const key: CloudCacheKey = {
  owner, organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222", chatId: "conversation",
};
function row(index: number, text = `message ${index}`): CloudCacheRow {
  return { index, msgId: `m-${index}`, kind: "text", createdAt: index + 1,
    payload: JSON.stringify({ id: `m-${index}`, kind: "text", role: index % 4 === 0 ? "user" : "agent", text, createdAt: index + 1 }) };
}
function range(fromIndex = 0, toIndex = 4, revision = 1, messageCount = toIndex): CloudCacheRange {
  return { revision, messageCount, fromIndex, toIndex,
    rows: Array.from({ length: toIndex - fromIndex }, (_, i) => row(fromIndex + i)) };
}
function pending(): CloudV2PromptStatus {
  return { receipt: { workspaceId: key.workspaceId, chatId: key.chatId, userMessageId: "pending", sequence: "1", epoch: "3",
    acceptedAt: "2026-11-12T12:00:00.000Z", workspaceState: "stopped" }, state: "queued", cancelRequested: false,
    payload: { chatId: key.chatId, userMessageId: "pending", agentId: "codex", prompt: [{ type: "text", text: "Saved prompt" }], startedAt: 1 } };
}
function directory(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-cache-"));
  directories.push(value);
  return value;
}
function open(root = directory(), options: ConstructorParameters<typeof CloudChatCacheStore>[1] = {}): CloudChatCacheStore {
  const store = new CloudChatCacheStore(root, options);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("main-owned cloud chat SQLite cache", () => {
  it("reopens native rows and transcript cut lineage without a server", () => {
    const root = directory();
    const store = open(root);
    const page = { ...range(5, 9, 42, 9), historyState: { revision: 2, beforeEpoch: "7" }, turnOpening: row(4) };
    expect(store.putRange(key, page)).toBe(true);
    store.close();
    expect(open(root).readTail(key, 200)).toEqual(page);
    const db = new Database(path.join(root, "cloud-cache.db"), { readonly: true });
    try { expect(db.pragma("journal_mode", { simple: true })).toBe("wal"); }
    finally { db.close(); }
  });

  it("isolates backend, viewing account, organization, workspace and chat", () => {
    const store = open();
    const keys = [key,
      { ...key, owner: JSON.stringify(["https://other.example.test", "viewer-a"]) },
      { ...key, owner: JSON.stringify(["https://api.example.test", "viewer-b"]) },
      { ...key, organizationId: "33333333-3333-4333-8333-333333333333" },
      { ...key, workspaceId: "44444444-4444-4444-8444-444444444444" },
      { ...key, chatId: "other-conversation" },
    ];
    for (const [i, target] of keys.entries()) store.putRange(target, { ...range(0, 1), rows: [row(0, `private-${i}`)] });
    for (const [i, target] of keys.entries()) expect(store.readTail(target)?.rows).toEqual([row(0, `private-${i}`)]);
    store.retireOwner(owner);
    for (const target of keys.filter(k => k.owner === owner)) expect(store.readTail(target)).toBeNull();
    expect(store.readTail(keys[1])?.rows).toEqual([row(0, "private-1")]);
    expect(store.readTail(keys[2])?.rows).toEqual([row(0, "private-2")]);
  });

  it("retains a restarted account session but drops rows from an earlier sign-in", () => {
    const root = directory(), first = open(root);
    const other = { ...key, owner: JSON.stringify(["https://api.example.test", "viewer-b"]) };
    first.bindAccount(owner, "session-a");
    first.bindAccount(other.owner, "session-b");
    first.putRange(key, range()); first.putRange(other, range()); first.close();
    const next = open(root);
    next.bindAccount(owner, "session-a");
    expect(next.readTail(key)?.rows).toEqual(range().rows);
    next.bindAccount(owner, "session-a-new");
    expect(next.readTail(key)).toBeNull();
    next.bindAccount(other.owner, "session-b");
    expect(next.readTail(other)?.rows).toEqual(range().rows);
  });

  it("combines only contiguous ranges from the exact revision", () => {
    const store = open();
    store.putRange(key, range(0, 3, 1, 10));
    store.putRange(key, range(6, 10, 1, 10));
    expect(store.readRange(key, 0, 10)).toBeNull();
    expect(store.readTail(key)?.rows.map(r => r.index)).toEqual([6, 7, 8, 9]);
    store.putRange(key, range(3, 6, 1, 10));
    expect(store.readRange(key, 0, 10)?.rows.map(r => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    store.putRange(key, range(8, 10, 2, 10));
    expect(store.readRange(key, 0, 10)).toBeNull();
    expect(store.putRange(key, range(0, 10, 1, 10))).toBe(false);
    expect(store.readTail(key)?.revision).toBe(2);
  });

  it("applies all changed rows atomically only to their exact base revision", () => {
    const store = open();
    store.putRange(key, range());
    const delta = { resync: false as const, fromRevision: 1, revision: 3, messageCount: 5, rows: [row(1, "edited"), row(4)] };
    expect(store.applyDelta(key, delta)).toBe(true);
    expect(store.readTail(key)?.rows).toEqual([row(0), row(1, "edited"), row(2), row(3), row(4)]);
    expect(store.applyDelta(key, { ...delta, fromRevision: 1, revision: 4, rows: [row(1, "stale")] })).toBe(false);
    expect(store.readTail(key)?.revision).toBe(3);
    expect(store.applyDelta(key, { ...delta, fromRevision: 3, revision: 3, rows: [] })).toBe(true);
    expect(store.readTail(key)?.rows[1]).toEqual(row(1, "edited"));
  });

  it("updates cached rows and a contiguous tail without filling an unrequested hole", () => {
    const store = open();
    store.putRange(key, range(0, 2, 1, 8)); store.putRange(key, range(6, 8, 1, 8));
    expect(store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 9,
      rows: [row(3, "outside requested ranges"), row(6, "edited"), row(8)] })).toBe(true);
    expect(store.readRange(key, 3, 4)).toBeNull();
    expect(store.readRange(key, 6, 9)?.rows).toEqual([row(6, "edited"), row(7), row(8)]);
  });

  it("does not cache new appends across a gap after the saved segment", () => {
    const store = open(); store.putRange(key, range(0, 2, 1, 8));
    expect(store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 10, rows: [row(8), row(9)] })).toBe(true);
    expect(store.readRange(key, 8, 10)).toBeNull();
    expect(store.readTail(key)?.rows).toEqual([row(0), row(1)]);
  });

  it("clears an absent historyState on a successful delta instead of retaining a different snapshot", () => {
    const store = open();
    store.putRange(key, { ...range(), historyState: { revision: 2, beforeEpoch: "9" } });
    store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 4, rows: [row(1, "edited")] });
    expect(store.readTail(key)?.historyState).toBeUndefined();
  });

  it("rejects a delta that omits appended rows, instead of publishing a partial revision", () => {
    const store = open();
    store.putRange(key, range());
    expect(() => store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 7, rows: [row(6)] })).toThrow();
    expect(store.readTail(key)?.revision).toBe(1);
  });

  it("never merges conflicting rows under one revision", () => {
    const store = open();
    store.putRange(key, range());
    expect(() => store.putRange(key, { ...range(), rows: [row(0, "changed without revision"), row(1), row(2), row(3)] })).toThrow();
    expect(store.readTail(key)?.rows).toEqual(range().rows);
  });

  it("refuses incompatible cut metadata across pages of one cache revision", () => {
    const store = open();
    store.putRange(key, { ...range(0, 2, 5, 4), historyState: { revision: 2, beforeEpoch: "9" } });
    expect(() => store.putRange(key, range(2, 4, 5, 4))).toThrow();
    expect(store.readTail(key)?.historyState).toEqual({ revision: 2, beforeEpoch: "9" });
  });

  it("does not paint a preceding turn opening when the cached range starts at a user prompt", () => {
    const store = open();
    store.putRange(key, { ...range(3, 9), turnOpening: row(0) });
    expect(store.readTail(key, 1)?.rows).toEqual([row(8)]);
    expect(store.readTail(key, 1)?.turnOpening).toBeUndefined();
  });

  it("rejects incomplete ranges and malformed deltas without changing the saved transcript", () => {
    const store = open();
    store.putRange(key, range());
    const before = store.readTail(key);
    for (const bad of [
      { ...range(), rows: [row(0), row(2), row(3)] },
      { ...range(), rows: [row(0), row(0), row(2), row(3)] },
      { ...range(), messageCount: 2 },
      { ...range(), revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => store.putRange(key, bad)).toThrow();
    expect(() => store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 3, rows: [] })).toThrow();
    expect(store.readTail(key)).toEqual(before);
  });

  it("drops the previous lineage before accepting a replacement, including an empty cut", () => {
    const store = open();
    store.putRange(key, range());
    expect(store.applyDelta(key, { resync: true, revision: 2, messageCount: 0 }, 1)).toBe(true);
    expect(store.readTail(key)).toBeNull();
    const empty = { ...range(0, 0, 2, 0), historyState: { revision: 1, beforeEpoch: "5" } };
    store.putRange(key, empty);
    expect(store.readTail(key)).toEqual(empty);
  });

  it("repairs an unknown future revision only if the cache still has that exact base", () => {
    const store = open(); store.putRange(key, range(0, 1, 999));
    expect(store.applyDelta(key, { resync: true, revision: 7, messageCount: 0 }, 999)).toBe(true);
    expect(store.readTail(key)).toBeNull();
    store.putRange(key, range(0, 1, 8));
    expect(store.applyDelta(key, { resync: true, revision: 9, messageCount: 0 }, 7)).toBe(false);
    expect(store.readTail(key)?.revision).toBe(8);
  });

  it("evicts whole chats by last read while protecting all open windows", () => {
    let now = 0;
    const store = open(undefined, { now: () => ++now, limits: { channelBytes: 2_000 } });
    const a = { ...key, chatId: "a" }, b = { ...key, chatId: "b" }, c = { ...key, chatId: "c" };
    const page = (text: string) => ({ ...range(0, 1), rows: [row(0, text.repeat(500))] });
    store.putRange(a, page("a")); store.putRange(b, page("b"));
    store.protect("window-1", a);
    store.readTail(b);
    store.putRange(c, page("c"));
    expect(store.readTail(a)).not.toBeNull();
    expect(store.readTail(b)).toBeNull();
    expect(store.readTail(c)).not.toBeNull();
    expect(store.bytes()).toBeLessThanOrEqual(2_000);
  });

  it("counts UTF-8 bytes and bounds each chat by dropping its oldest cached rows", () => {
    const store = open(undefined, { limits: { chatRows: 3, chatBytes: 1_200 } });
    const page = range(0, 5);
    page.rows = page.rows.map(r => row(r.index, "é".repeat(100)));
    store.putRange(key, page);
    const cached = store.readTail(key)!;
    expect(cached.rows.length).toBeGreaterThan(0);
    expect(cached.rows.length).toBeLessThanOrEqual(3);
    expect(cached.rows.at(-1)?.index).toBe(4);
    expect(store.bytes()).toBeLessThanOrEqual(1_200);
    expect(store.readRange(key, 0, 5)).toBeNull();
  });

  it("reclaims closed chats when SQLite reaches its physical page bound", () => {
    let now = 0;
    const root = directory(), channelBytes = 256 * 1024;
    const store = open(root, { now: () => ++now, limits: { channelBytes, chatBytes: 64 * 1024 } });
    const page = { ...range(0, 1), rows: [row(0, "x".repeat(24 * 1024))] };
    store.putRange(key, page); store.protect("window", key);
    for (let index = 0; index < 20; index++) {
      const next = { ...key, chatId: `other-${index}` };
      expect(store.putRange(next, page), `new chat ${index}`).toBe(true);
      expect(store.readTail(next)?.rows).toEqual(page.rows);
    }
    expect(store.readTail(key)?.rows).toEqual(page.rows);
    expect(store.readTail({ ...key, chatId: "other-0" })).toBeNull();
    expect(fs.statSync(path.join(root, "cloud-cache.db")).size).toBeLessThanOrEqual(channelBytes);
  });

  it("never replaces an open chat with an update that exceeds its allowance", () => {
    const store = open(undefined, { limits: { channelBytes: 2_000, chatBytes: 1_000 } });
    store.putRange(key, range(0, 1));
    store.protect("window-1", key);
    expect(store.putRange(key, { ...range(0, 1, 2), rows: [row(0, "x".repeat(2_001))] })).toBe(false);
    expect(store.readTail(key)?.revision).toBe(1);
  });

  it("keeps cached receipts separate from native messages and removes them with the account", () => {
    const store = open();
    store.putRange(key, range(0, 1));
    const snapshot = { queueRevision: 4, epoch: "3", items: [pending()] };
    expect(store.putPending(key, snapshot)).toBe(true);
    expect(store.readPending(key)).toEqual(snapshot);
    expect(store.readTail(key)?.rows).toEqual([row(0)]);
    expect(store.putPending(key, { queueRevision: 3, epoch: "3", items: [] })).toBe(false);
    store.retireOwner(owner);
    expect(store.readPending(key)).toBeNull();
  });

  it("refuses conflicting queue state under an unchanged queue revision", () => {
    const store = open();
    store.putRange(key, range());
    const snapshot = { queueRevision: 4, epoch: "3", items: [pending()] };
    store.putPending(key, snapshot);
    expect(store.putPending(key, snapshot)).toBe(true);
    expect(() => store.putPending(key, { ...snapshot, items: [] })).toThrow();
    expect(() => store.putPending(key, { ...snapshot, epoch: "4" })).toThrow();
    expect(store.readPending(key)).toEqual(snapshot);
  });

  it("forgets only the selected chat or workspace and leaves other scopes intact", () => {
    const store = open();
    const otherChat = { ...key, chatId: "other" };
    const otherWorkspace = { ...key, workspaceId: "33333333-3333-4333-8333-333333333333" };
    for (const target of [key, otherChat, otherWorkspace]) store.putRange(target, range());
    store.forget(key);
    expect(store.readTail(key)).toBeNull();
    expect(store.readTail(otherChat)).not.toBeNull();
    store.forgetWorkspace(owner, key.organizationId, key.workspaceId);
    expect(store.readTail(otherChat)).toBeNull();
    expect(store.readTail(otherWorkspace)).not.toBeNull();
  });

  it.each(["corrupt", "incompatible", "unversioned", "invalid-schema"])("rebuilds a %s disposable cache", kind => {
    const root = directory(), file = path.join(root, "cloud-cache.db");
    if (kind === "corrupt") fs.writeFileSync(file, "not a database");
    else if (kind === "invalid-schema") {
      const first = open(root); first.putRange(key, range()); first.close();
      const db = new Database(file); db.exec("ALTER TABLE messages RENAME COLUMN idx TO invalid_idx"); db.close();
    }
    else {
      const db = new Database(file);
      db.exec(kind === "unversioned" ? "CREATE TABLE chats (value TEXT)" : "CREATE TABLE old_cache (value TEXT); PRAGMA user_version=999;"); db.close();
    }
    const store = open(root);
    expect(store.readTail(key)).toBeNull();
    expect(store.putRange(key, range())).toBe(true);
    store.close();
    expect(open(root).readTail(key)?.rows).toEqual(range().rows);
  });

  it.each(["cloud-cache.db", "cloud-cache.db-wal", "cloud-cache.db-shm"])("refuses a symlinked %s without changing its target", name => {
    const root = directory(), outside = path.join(directory(), "outside");
    fs.writeFileSync(outside, "foreign bytes"); fs.symlinkSync(outside, path.join(root, name));
    expect(() => open(root).putRange(key, range())).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("foreign bytes");
    expect(fs.lstatSync(path.join(root, name)).isSymbolicLink()).toBe(true);
  });

  it("treats malformed saved metadata as a cache miss and forgets that chat", () => {
    const root = directory(), store = open(root);
    store.putRange(key, range()); store.close();
    const db = new Database(path.join(root, "cloud-cache.db"));
    try { db.prepare("UPDATE chats SET history_state=?").run("{"); }
    finally { db.close(); }
    const restored = open(root);
    expect(restored.readTail(key)).toBeNull();
    expect(restored.metadata(key)).toBeNull();
  });

  it.each(["malformed", "foreign"])("treats %s saved receipts as a cache miss", kind => {
    const root = directory(), store = open(root);
    store.putRange(key, range()); store.putPending(key, { queueRevision: 1, epoch: "3", items: [pending()] }); store.close();
    const db = new Database(path.join(root, "cloud-cache.db"));
    try { db.prepare("UPDATE pending SET status=?").run(kind === "malformed" ? "{" :
      JSON.stringify({ ...pending(), receipt: { ...pending().receipt, chatId: "foreign" } })); }
    finally { db.close(); }
    const restored = open(root);
    expect(restored.readPending(key)).toBeNull();
    expect(restored.metadata(key)).toBeNull();
  });

  it("lists every disk chat in bounded own-account pages for pruning without a memory entry", () => {
    const store = open(), other = { ...key, owner: "other-viewer" };
    for (const chatId of ["a", "b", "c"]) store.putRange({ ...key, chatId }, range(0, 1));
    store.putRange(other, range(0, 1));
    const first = store.list(owner, null, 2);
    expect(first.items.map(item => item.chatId)).toEqual(["a", "b"]);
    expect(first.nextAfter).not.toBeNull();
    const last = store.list(owner, first.nextAfter, 2);
    expect(last.items.map(item => item.chatId)).toEqual(["c"]);
    expect(last.nextAfter).toBeNull();
    expect([...first.items, ...last.items].every(item => !("owner" in item))).toBe(true);
  });

  it("closing a store never releases a live peer connection's lock on the same file (second-process exclusion)", async () => {
    const root = directory(), file = path.join(root, "cloud-cache.db"), first = open(root);
    first.putRange(key, range());
    // A second store on the same file closes while the first stays open and in use.
    const second = open(root);
    expect(second.metadata(key)?.revision).toBe(1);
    second.close();
    expect(first.metadata(key)?.revision).toBe(1);
    // Leaving WAL needs exclusive access to the main file; a live connection in this process must still block it.
    const child = await promisify(execFile)(process.execPath, ["-e", `
      const Database=require('better-sqlite3');const db=new Database(process.argv[1],{timeout:0});
      try{const mode=db.pragma('journal_mode=DELETE',{simple:true});process.stdout.write(String(mode));}
      catch(error){process.stdout.write(error.code==='SQLITE_BUSY'?'blocked':'unexpected');}
      finally{db.close();}
    `, file], { cwd: process.cwd() });
    expect(["wal", "blocked"]).toContain(child.stdout);
    expect(first.metadata(key)?.revision).toBe(1);
  });

  it("a cached read takes no write lock: it returns the confirmed snapshot while a peer holds the writer", () => {
    const root = directory(), file = path.join(root, "cloud-cache.db"), store = open(root);
    store.putRange(key, range());
    const writer = new Database(file);
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(store.readTail(key, 200)?.rows).toEqual(range().rows);
      expect(store.readRange(key, 0, 4)?.revision).toBe(1);
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  });

  it("eviction still honours read recency kept in memory between mutations", () => {
    const root = directory(), file = path.join(root, "cloud-cache.db");
    const probe = open(root); probe.putRange(key, range());
    const raw = new Database(file, { readonly: true });
    const one = (raw.prepare("SELECT bytes FROM chats").get() as { bytes: number }).bytes; raw.close(); probe.close();
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
    let now = 1;
    const store = open(root, { now: () => now, limits: { channelBytes: Math.floor(one * 2.5) } });
    const a = { ...key, chatId: "a" }, b = { ...key, chatId: "b" }, c = { ...key, chatId: "c" };
    store.putRange(a, range()); now = 2; store.putRange(b, range());
    now = 3; expect(store.readTail(a, 200)).not.toBeNull();
    now = 4; store.putRange(c, range());
    // b is the least recently read: it goes; a, read at 3, stays.
    expect(store.metadata(b)).toBeNull();
    expect(store.metadata(a)?.revision).toBe(1);
  });

  it("binds SQLite to the held original: a pathname swapped only during the native open is refused", () => {
    const root = directory(), file = path.join(root, "cloud-cache.db"), first = open(root);
    first.putRange(key, range()); first.close();
    const substitute = path.join(root, "substitute.db"), parked = path.join(root, "parked.db");
    new Database(substitute).close();
    let swapped = false;
    const store = open(root, { openNative: filename => {
      // The replacement window is open exactly during the native open, then the original is restored.
      fs.renameSync(file, parked); fs.renameSync(substitute, file); swapped = true;
      try { return new Database(filename, { timeout: 500 }); }
      finally { fs.renameSync(file, substitute); fs.renameSync(parked, file); }
    } });
    expect(() => store.metadata(key)).toThrow();
    expect(swapped).toBe(true);
    // An honest reopen still reads the original.
    expect(open(root).metadata(key)?.revision).toBe(1);
  });

  it("keeps the custody descriptor open while SQLite owns a process lock", async () => {
    const root = directory(), file = path.join(root, "cloud-cache.db"), first = open(root);
    first.putRange(key, range()); first.close();
    const writer = new Database(file);
    writer.exec("BEGIN IMMEDIATE");
    try {
      const reader = open(root);
      expect(reader.metadata(key)?.revision).toBe(1);
      const child = await promisify(execFile)(process.execPath, ["-e", `
        const Database=require('better-sqlite3');const db=new Database(process.argv[1],{timeout:0});
        try{db.exec('BEGIN IMMEDIATE');process.stdout.write('entered');db.exec('ROLLBACK');}
        catch(error){process.stdout.write(error.code==='SQLITE_BUSY'?'blocked':'unexpected');}
        finally{db.close();}
      `, file], { cwd: process.cwd() });
      expect(child.stdout).toBe("blocked");
    } finally { writer.exec("ROLLBACK"); writer.close(); }
  });
});

describe("senders travel with their cached rows (Team sharing)", () => {
  const alice = { userId: "44444444-4444-4444-8444-444444444444" }, bob = { userId: "55555555-5555-4555-8555-555555555555" };
  it("keeps each delivered sender, serves it on read, and never erases a known one", () => {
    const store = open();
    // m-0 is a user row; m-1 is an agent row whose (ignored) entry must not be stored; m-9 is not in the page.
    expect(store.putRange(key, { ...range(0, 4), senders: { "m-0": alice, "m-1": bob, "m-9": bob, bad: { userId: "x" } } })).toBe(true);
    expect(store.readRange(key, 0, 4)?.senders).toEqual({ "m-0": alice });
    // A later page of the same revision without senders (N-1 server) keeps what is known.
    expect(store.putRange(key, range(0, 4))).toBe(true);
    expect(store.readTail(key, 200)?.senders).toEqual({ "m-0": alice });
    // A since delta brings the new user row's sender; a known-unknown legacy attribution is kept as null.
    expect(store.applyDelta(key, { resync: false, fromRevision: 1, revision: 2, messageCount: 5, rows: [row(4)], senders: { "m-4": null } })).toBe(true);
    expect(store.readTail(key, 200)?.senders).toEqual({ "m-0": alice, "m-4": null });
  });
  it("keeps the sender of a page's turn opening, which is not one of its rows", () => {
    const store = open();
    // Rows 1..3 are agent rows; the turn opened at user row 0, delivered as turnOpening.
    expect(store.putRange(key, { ...range(1, 4, 1, 4), turnOpening: row(0), senders: { "m-0": alice } })).toBe(true);
    expect(store.readRange(key, 1, 4)).toMatchObject({ turnOpening: { msgId: "m-0" }, senders: { "m-0": alice } });
  });
  it("a chat without senders reads exactly as before", () => {
    const store = open();
    store.putRange(key, range(0, 4));
    expect(store.readRange(key, 0, 4)).not.toHaveProperty("senders");
  });
});

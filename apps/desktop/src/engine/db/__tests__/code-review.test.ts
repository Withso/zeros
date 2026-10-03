import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeReviewStore } from "../code-review";
import { MIGRATIONS, runMigrations } from "../migrations";
import { mergeCodeReviewThreads, type CodeReviewActor } from "@zeros/protocol/code-review";

const human: CodeReviewActor = { id: "human:one", name: "Reviewer", kind: "human" };
const agent: CodeReviewActor = { id: "agent:codex:conversation", name: "Codex", kind: "agent", provider: "codex" };
const create = { workspaceId: "A", anchor: { path: "src/example.ts", side: "new" as const, startLine: 2, endLine: 4, revision: "sha256:original", context: "example" }, body: "Please review" };

describe("durable workspace code review store", () => {
  let db: Database.Database;
  let store: CodeReviewStore;
  beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); runMigrations(db); store = new CodeReviewStore(() => db); });
  afterEach(() => db.close());

  it("isolates lists and every thread mutation by exact workspace", () => {
    const thread = store.create(create, human);
    expect(store.list({ workspaceId: "B" }).threads).toEqual([]);
    expect(store.list({ workspaceId: "A", path: "other.ts" }).threads).toEqual([]);
    expect(() => store.get("B", thread.id)).toThrow(/not found/i);
    expect(() => store.reply({ workspaceId: "B", threadId: thread.id, body: "Reply" }, agent)).toThrow(/not found/i);
    expect(() => store.setResolved({ workspaceId: "B", threadId: thread.id, resolved: true, expectedVersion: 1 }, agent)).toThrow(/not found/i);
    expect(store.get("A", thread.id)).toEqual(thread);
  });

  it("pages large threads and collections within a JSON byte budget without losing comments", () => {
    const thread = store.create(create, human);
    const body = "\u0001".repeat(19_999) + "x";
    const insert = db.prepare("INSERT INTO code_review_comments (id, thread_id, seq, author_json, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let seq = 2; seq <= 160; seq++) insert.run(`large-${seq}`, thread.id, seq, JSON.stringify(agent), body, thread.createdAt);
      db.prepare("UPDATE code_review_threads SET version = 160 WHERE id = ?").run(thread.id);
    })();
    for (let index = 0; index < 105; index++) store.create({ ...create, body: `Thread ${index}` }, human);
    const all = new Map<string, Set<string>>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = store.list({ workspaceId: "A", cursor, limit: 10 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512 * 1024);
      expect(page.partial).toBe(!!page.nextCursor);
      for (const entry of page.threads) {
        let ids = all.get(entry.id);
        if (!ids) all.set(entry.id, ids = new Set());
        for (const comment of entry.comments) { expect(ids.has(comment.id)).toBe(false); ids.add(comment.id); }
      }
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(100);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(all.size).toBe(106);
    expect(all.get(thread.id)?.size).toBe(160);
    const reply = store.reply({ workspaceId: "A", threadId: thread.id, body: "Latest reply" }, agent);
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(512 * 1024);
    expect(reply.comments[0]!.id).toBe(thread.comments[0]!.id);
    expect(reply.comments.at(-1)?.body).toBe("Latest reply");
    expect(reply).toMatchObject({ commentCount: 161, commentsComplete: false });
    expect(reply.commentsCursor).toBeTypeOf("string");
    const continuation = store.list({ workspaceId: "A", threadId: thread.id, cursor: reply.commentsCursor });
    expect(continuation.threads.map((entry) => entry.id)).toEqual([thread.id]);
  });

  it("binds continuation to the exact workspace and filters and validates cursor/limit inputs", () => {
    for (let index = 0; index < 3; index++) store.create(create, human);
    const first = store.list({ workspaceId: "A", limit: 1 });
    expect(first.nextCursor).toBeTypeOf("string");
    for (const input of [
      { workspaceId: "B", cursor: first.nextCursor },
      { workspaceId: "A", cursor: first.nextCursor, path: "other.ts" },
      { workspaceId: "A", cursor: first.nextCursor, includeResolved: false },
      { workspaceId: "A", cursor: "malformed" },
      { workspaceId: "A", limit: 0 }, { workspaceId: "A", limit: 101 },
    ]) expect(() => store.list(input)).toThrow(/invalid/i);
  });

  it("loads all 200 replies through the merged preview's advancing thread-history cursor", () => {
    const thread = store.create(create, human);
    const insert = db.prepare("INSERT INTO code_review_comments (id, thread_id, seq, author_json, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    db.transaction(() => {
      for (let seq = 2; seq <= 200; seq++) insert.run(`ordered-${seq}`, thread.id, seq, JSON.stringify(agent), `Reply ${seq}`, thread.createdAt);
      db.prepare("UPDATE code_review_threads SET version = 200 WHERE id = ?").run(thread.id);
    })();
    let merged = [store.get("A", thread.id)];
    expect(merged[0]).toMatchObject({ commentCount: 200, commentsComplete: false, commentsCursorAfter: 64 });
    expect(merged[0]!.comments.at(-1)!.sequence).toBe(200);
    const cursorPositions: number[] = [];
    while (merged[0]!.commentsCursor) {
      cursorPositions.push(merged[0]!.commentsCursorAfter!);
      expect(cursorPositions.length).toBeLessThan(5);
      const page = store.list({ workspaceId: "A", threadId: thread.id, cursor: merged[0]!.commentsCursor });
      merged = mergeCodeReviewThreads(merged, page.threads);
    }
    expect(cursorPositions).toEqual([64, 128, 192]);
    expect(merged[0]!.comments.map((comment) => comment.sequence)).toEqual(Array.from({ length: 200 }, (_, index) => index + 1));
    expect(merged[0]!.commentsComplete).toBe(true);
  });

  it("appends concurrent human, agent and integration replies without lost rows", async () => {
    const thread = store.create(create, human);
    const actors: CodeReviewActor[] = [human, agent, { id: "integration:check", name: "Check", kind: "integration" }];
    await Promise.all(Array.from({ length: 30 }, (_, index) => Promise.resolve().then(() =>
      store.reply({ workspaceId: "A", threadId: thread.id, body: `Reply ${index}`, requestId: `reply-${index}` }, actors[index % actors.length]!))));
    const result = store.get("A", thread.id);
    expect(result.comments).toHaveLength(31);
    expect(new Set(result.comments.map((comment) => comment.id)).size).toBe(31);
    expect(result.comments.slice(1).map((comment) => comment.body)).toEqual(Array.from({ length: 30 }, (_, index) => `Reply ${index}`));
    expect(result.version).toBe(31);
    expect(result.anchor).toEqual(thread.anchor);
    expect(result.comments[0]).toEqual(thread.comments[0]);
  });

  it("rejects stale resolve/reopen decisions after replies or other decisions", () => {
    const thread = store.create(create, human);
    const reply = store.reply({ workspaceId: "A", threadId: thread.id, body: "Working on it" }, agent);
    expect(() => store.setResolved({ workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: thread.version }, human)).toThrow(/changed/i);
    const resolved = store.setResolved({ workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: reply.version }, human);
    expect(resolved).toMatchObject({ resolved: true, version: 3, resolvedBy: human });
    expect(store.list({ workspaceId: "A", includeResolved: false }).threads).toEqual([]);
    const laterReply = store.reply({ workspaceId: "A", threadId: thread.id, body: "Follow-up" }, agent);
    expect(laterReply.resolved).toBe(true);
    expect(() => store.setResolved({ workspaceId: "A", threadId: thread.id, resolved: false, expectedVersion: resolved.version }, human)).toThrow(/changed/i);
    const reopened = store.setResolved({ workspaceId: "A", threadId: thread.id, resolved: false, expectedVersion: laterReply.version }, agent);
    expect(reopened).toMatchObject({ resolved: false, version: 5 });
    expect(reopened.resolvedBy).toBeUndefined();
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.anchor).toEqual(thread.anchor);
    expect(reopened.comments.map((comment) => comment.author)).toEqual([human, agent, agent]);
  });

  it("makes lost-response retries idempotent, even after newer replies", () => {
    const input = { ...create, requestId: "create-request" };
    const thread = store.create(input, human);
    expect(store.create(input, human)).toEqual(thread);
    const reply = { workspaceId: "A", threadId: thread.id, body: "Agent reply", requestId: "reply-request" };
    store.reply(reply, agent);
    const resolution = { workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: 2, requestId: "resolve-request" };
    store.setResolved(resolution, human);
    const current = store.reply({ workspaceId: "A", threadId: thread.id, body: "Newer reply" }, agent);
    expect(store.create(input, human)).toEqual(current);
    expect(store.reply(reply, agent)).toEqual(current);
    expect(store.setResolved(resolution, human)).toEqual(current);
    expect(store.get("A", thread.id).comments).toHaveLength(3);
    expect(() => store.reply({ ...reply, body: "Different input" }, agent)).toThrow(/different input/i);
    expect(() => store.setResolved({ ...resolution, resolved: false }, human)).toThrow(/different input/i);
  });

  it("scopes idempotency to both actor and workspace", () => {
    const input = { ...create, requestId: "same-request" };
    const first = store.create(input, human);
    expect(store.create(input, agent).id).not.toBe(first.id);
    expect(store.create({ ...input, workspaceId: "B" }, human).workspaceId).toBe("B");
    expect(store.list({ workspaceId: "A" }).threads).toHaveLength(2);
  });

  it("keeps retry signatures portable across owner remapping and reads legacy receipts", () => {
    const input = { ...create, requestId: "portable-request" };
    const thread = store.create(input, human);
    store.create({ ...input, workspaceId: "B" }, human);
    const signatures = db.prepare("SELECT signature FROM code_review_requests ORDER BY workspace_id").all() as { signature: string }[];
    expect(signatures[0]!.signature).toBe(signatures[1]!.signature);
    const { requestId: _requestId, ...payload } = input;
    const legacy = createHash("sha256").update(JSON.stringify(["create", payload])).digest("hex");
    db.prepare("UPDATE code_review_requests SET signature = ? WHERE workspace_id = 'A'").run(legacy);
    expect(store.create(input, human).id).toBe(thread.id);
    expect(() => store.create({ ...input, body: "Changed retry" }, human)).toThrow(/different input/i);
  });

  it("validates inputs before persisting and does not expose bodies in errors", () => {
    expect(() => store.create({ ...create, anchor: { ...create.anchor, path: "../outside" } }, human)).toThrow(/invalid/i);
    expect(() => store.create({ ...create, body: " " }, human)).toThrow(/invalid/i);
    expect(() => store.create({ ...create, anchor: { ...create.anchor, endLine: 1 } }, human)).toThrow(/invalid/i);
    expect(() => store.create({ ...create, author: agent } as typeof create, human)).toThrow(/invalid/i);
    expect(store.list({ workspaceId: "A" }).threads).toEqual([]);
  });

  it("enforces immutable anchors and comment authors at the database layer", () => {
    const thread = store.create(create, human);
    expect(() => db.prepare("UPDATE code_review_threads SET workspace_id = ? WHERE id = ?").run("B", thread.id)).toThrow(/immutable/i);
    expect(() => db.prepare("UPDATE code_review_comments SET author_json = ? WHERE id = ?").run(JSON.stringify(agent), thread.comments[0]!.id)).toThrow(/immutable/i);
    expect(store.get("A", thread.id)).toEqual(thread);
  });

  it("upgrades the previous schema without changing legacy diff comments", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
      for (const migration of MIGRATIONS.filter((entry) => entry.version < 40)) {
        if (migration.version !== 22) legacy.exec(migration.up);
        legacy.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(migration.version, migration.name);
      }
      legacy.prepare("INSERT INTO diff_comments (id, workspace_id, body, author) VALUES (?, ?, ?, ?)").run("legacy", "A", "Original comment", "Original author");
      runMigrations(legacy);
      expect(legacy.prepare("SELECT body, author FROM diff_comments WHERE id = 'legacy'").get()).toEqual({ body: "Original comment", author: "Original author" });
      const upgraded = new CodeReviewStore(() => legacy);
      expect(upgraded.create(create, human).comments[0]!.author).toEqual(human);
      runMigrations(legacy);
      expect(upgraded.list({ workspaceId: "A" }).threads).toHaveLength(1);
    } finally { legacy.close(); }
  });

  it("retains IDs, original anchor, replies, resolution and retry receipts across DB reopen", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-review-durability-"));
    let durable = new Database(path.join(directory, "zeros.db"));
    try {
      runMigrations(durable);
      const persistent = new CodeReviewStore(() => durable);
      const input = { ...create, requestId: "durable-create" };
      const thread = persistent.create(input, human);
      persistent.reply({ workspaceId: "A", threadId: thread.id, body: "Durable reply" }, agent);
      const resolved = persistent.setResolved({ workspaceId: "A", threadId: thread.id, resolved: true, expectedVersion: 2 }, human);
      durable.close();
      durable = new Database(path.join(directory, "zeros.db"));
      runMigrations(durable);
      expect(persistent.get("A", thread.id)).toEqual(resolved);
      expect(persistent.create(input, human)).toEqual(resolved);
      const reopened = persistent.setResolved({ workspaceId: "A", threadId: thread.id, resolved: false, expectedVersion: resolved.version }, agent);
      expect(reopened.comments).toEqual(resolved.comments);
      expect(reopened.anchor).toEqual(create.anchor);
    } finally { durable.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

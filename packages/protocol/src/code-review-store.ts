import { z } from "zod";
import {
  codeReviewActorSchema, codeReviewAnchorSchema, codeReviewCreateInputSchema,
  codeReviewListInputSchema, codeReviewReplyInputSchema, codeReviewSetResolvedInputSchema,
  CODE_REVIEW_PAGE_BYTE_LIMIT,
  type CodeReviewActor, type CodeReviewComment, type CodeReviewThread,
  type CodeReviewListInput, type CodeReviewListResult, type CodeReviewCreateInput,
  type CodeReviewReplyInput, type CodeReviewSetResolvedInput,
} from "./code-review-contract";
import { CodeReviewError, parseCodeReviewInput } from "./code-review-errors";

export interface CodeReviewDatabase {
  prepare(sql: string): {
    get(...values: Array<string | number | null>): unknown;
    all(...values: Array<string | number | null>): unknown[];
    run(...values: Array<string | number | null>): { changes: number | bigint };
  };
  transaction<T>(operation: () => T): (() => T) & { immediate(): T };
}
export interface CodeReviewStoreRuntime {
  hash(value: string): string;
  uuid(): string;
  encode(value: string): string;
  decode(value: string): string;
  beforeWrite?(db: CodeReviewDatabase, operation: "create" | "reply" | "setResolved", input: CodeReviewCreateInput | CodeReviewReplyInput | CodeReviewSetResolvedInput): void;
}

interface ThreadRow {
  id: string; workspace_id: string; anchor_json: string;
  resolved: number; resolved_by: string | null; resolved_at: number | null;
  version: number; created_at: number; updated_at: number;
}
interface CommentRow {
  id: string; thread_id: string; seq: number; author_json: string; body: string; created_at: number;
}
const COMMENT_ROW_LIMIT = 64;
const THREAD_BYTE_LIMIT = 256 * 1_024;
const cursorSchema = z.object({
  version: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().safe().nonnegative(), threadId: z.string().min(1).max(512),
  after: z.number().int().safe().nonnegative(),
}).strict();
type ReviewCursor = z.infer<typeof cursorSchema>;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const scopeFor = (input: CodeReviewListInput, runtime: CodeReviewStoreRuntime) => runtime.hash(JSON.stringify([
  input.workspaceId, input.path ?? null, input.includeResolved !== false, input.threadId ?? null,
]));
const cursorFor = (input: CodeReviewListInput, row: ThreadRow, after: number, runtime: CodeReviewStoreRuntime) => runtime.encode(JSON.stringify({
  version: 1, scope: scopeFor(input, runtime), createdAt: row.created_at, threadId: row.id, after,
} satisfies ReviewCursor));
function readCursor(input: CodeReviewListInput, runtime: CodeReviewStoreRuntime): ReviewCursor | undefined {
  if (!input.cursor) return undefined;
  try {
    const cursor = cursorSchema.parse(JSON.parse(runtime.decode(input.cursor)));
    if (cursor.scope !== scopeFor(input, runtime)) throw new Error();
    return cursor;
  } catch { throw new CodeReviewError("CODE_REVIEW_INVALID", "Invalid code review continuation. Restart the same workspace read."); }
}

/** The engine's SQLite writer owns review state. Replies are individual rows;
 * no client ever replaces a thread's comment collection. Transactions contain
 * no async work and advance the version with the append/state decision. */
export class CodeReviewStoreCore {
  constructor(private readonly database: () => CodeReviewDatabase, private readonly runtime: CodeReviewStoreRuntime) {}

  private row(db: CodeReviewDatabase, workspaceId: string, threadId: string): ThreadRow {
    const row = db.prepare("SELECT * FROM code_review_threads WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, threadId) as ThreadRow | undefined;
    if (!row) throw new CodeReviewError("CODE_REVIEW_NOT_FOUND", "Review thread was not found in this workspace.");
    return row;
  }

  private count(db: CodeReviewDatabase, threadId: string): number {
    return (db.prepare("SELECT MAX(seq) AS count FROM code_review_comments WHERE thread_id = ?").get(threadId) as { count: number }).count;
  }

  private comment(row: CommentRow): CodeReviewComment {
    return {
      id: row.id, author: parseCodeReviewInput(codeReviewActorSchema, JSON.parse(row.author_json)),
      body: row.body, createdAt: row.created_at, sequence: row.seq,
    };
  }

  private snapshot(row: ThreadRow, comments: CodeReviewComment[], commentCount: number): CodeReviewThread {
    const last = comments.at(-1)?.sequence ?? 0;
    return {
      id: row.id, workspaceId: row.workspace_id,
      anchor: parseCodeReviewInput(codeReviewAnchorSchema, JSON.parse(row.anchor_json)),
      comments, commentCount, commentsComplete: comments.length === commentCount,
      resolved: row.resolved === 1, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.resolved_by !== null ? { resolvedBy: parseCodeReviewInput(codeReviewActorSchema, JSON.parse(row.resolved_by)) } : {}),
      ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
      ...(last < commentCount ? { commentsCursor: cursorFor({ workspaceId: row.workspace_id, threadId: row.id }, row, last, this.runtime), commentsCursorAfter: last } : {}),
    };
  }

  private chunk(db: CodeReviewDatabase, row: ThreadRow, after: number, byteLimit: number): CodeReviewThread | undefined {
    const commentCount = this.count(db, row.id);
    const rows = db.prepare("SELECT * FROM code_review_comments WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(row.id, after, COMMENT_ROW_LIMIT) as CommentRow[];
    let result: CodeReviewThread | undefined;
    for (const entry of rows) {
      const candidate = this.snapshot(row, [...(result?.comments ?? []), this.comment(entry)], commentCount);
      if (bytes(candidate) > byteLimit) break;
      result = candidate;
    }
    return result;
  }

  private thread(db: CodeReviewDatabase, workspaceId: string, threadId: string): CodeReviewThread {
    const row = this.row(db, workspaceId, threadId);
    const result = this.chunk(db, row, 0, THREAD_BYTE_LIMIT);
    if (!result) throw new CodeReviewError("CODE_REVIEW_INVALID", "Review history could not be read.");
    if (!result.commentsComplete) {
      // A bounded mutation preview retains the original author and newest reply.
      // Its cursor still starts after the contiguous original chunk, so the gap
      // can be read without retaining/replacing all replies in one bridge frame.
      const latest = db.prepare("SELECT * FROM code_review_comments WHERE thread_id = ? ORDER BY seq DESC LIMIT 1").get(threadId) as CommentRow;
      result.comments.push(this.comment(latest));
      if (result.comments.length === result.commentCount) { result.commentsComplete = true; delete result.commentsCursor; delete result.commentsCursorAfter; }
    }
    return result;
  }

  get(workspaceId: string, threadId: string): CodeReviewThread {
    const input = parseCodeReviewInput(codeReviewReplyInputSchema.omit({ body: true, requestId: true }), { workspaceId, threadId });
    const db = this.database();
    return db.transaction(() => this.thread(db, input.workspaceId, input.threadId))();
  }

  list(raw: CodeReviewListInput): CodeReviewListResult {
    const input = parseCodeReviewInput(codeReviewListInputSchema, raw);
    const cursor = readCursor(input, this.runtime);
    const db = this.database();
    return db.transaction(() => {
      const limit = input.limit ?? 50;
      const filter = "workspace_id = ? AND (? IS NULL OR file_path = ?) AND (? = 1 OR resolved = 0) AND (? IS NULL OR id = ?)";
      const rows = db.prepare(`SELECT * FROM code_review_threads WHERE ${filter}
        AND (created_at > ? OR (created_at = ? AND id >= ?)) ORDER BY created_at, id LIMIT ?`)
        .all(input.workspaceId, input.path ?? null, input.path ?? null, input.includeResolved === false ? 0 : 1,
          input.threadId ?? null, input.threadId ?? null, cursor?.createdAt ?? 0, cursor?.createdAt ?? 0,
          cursor?.threadId ?? "", limit + 2) as ThreadRow[];
      const threads: CodeReviewThread[] = [];
      let remaining = CODE_REVIEW_PAGE_BYTE_LIMIT - bytes({ workspaceId: input.workspaceId, threads: [], partial: true }) - 4_096;
      let last: { row: ThreadRow; seq: number } | undefined;
      let nextCursor: string | undefined;
      for (const row of rows) {
        const after = cursor?.threadId === row.id ? cursor.after : 0;
        if (after >= this.count(db, row.id)) continue;
        if (threads.length === limit) { nextCursor = last && cursorFor(input, last.row, last.seq, this.runtime); break; }
        const chunk = this.chunk(db, row, after, Math.min(remaining, THREAD_BYTE_LIMIT));
        if (!chunk) {
          if (!last) throw new CodeReviewError("CODE_REVIEW_INVALID", "Review history could not be read.");
          nextCursor = cursorFor(input, last.row, last.seq, this.runtime); break;
        }
        threads.push(chunk);
        remaining -= bytes(chunk) + 1;
        last = { row, seq: chunk.comments.at(-1)!.sequence! };
        if (last.seq < chunk.commentCount!) { nextCursor = cursorFor(input, row, last.seq, this.runtime); break; }
      }
      return { workspaceId: input.workspaceId, threads, partial: !!nextCursor, ...(nextCursor ? { nextCursor } : {}) };
    })();
  }

  private mutate(
    operation: "create" | "reply" | "setResolved",
    input: CodeReviewCreateInput | CodeReviewReplyInput | CodeReviewSetResolvedInput,
    actor: CodeReviewActor,
    write: (db: CodeReviewDatabase, actor: CodeReviewActor) => CodeReviewThread,
  ): CodeReviewThread {
    const author = parseCodeReviewInput(codeReviewActorSchema, actor);
    const db = this.database();
    const actorKey = JSON.stringify([author.kind, author.id]);
    const { requestId, ...payload } = input;
    // The receipt key already scopes workspace and actor. Keep the fingerprint
    // portable when cloud restore maps the canonical owner to a new route key.
    const { workspaceId: _workspaceId, ...scopedPayload } = payload;
    const signature = this.runtime.hash(JSON.stringify([operation, scopedPayload]));
    const legacySignature = this.runtime.hash(JSON.stringify([operation, payload]));
    return db.transaction(() => {
      if (requestId) {
        const prior = db.prepare("SELECT signature, thread_id FROM code_review_requests WHERE workspace_id = ? AND actor_key = ? AND request_id = ?")
          .get(input.workspaceId, actorKey, requestId) as { signature: string; thread_id: string } | undefined;
        if (prior) {
          if (prior.signature !== signature && prior.signature !== legacySignature) throw new CodeReviewError("CODE_REVIEW_RETRY_CONFLICT", "This review request ID was already used for different input.");
          // Return the current snapshot without replaying the write, including
          // any later replies/state changes by another participant.
          return this.thread(db, input.workspaceId, prior.thread_id);
        }
      }
      this.runtime.beforeWrite?.(db, operation, input);
      const result = write(db, author);
      if (requestId) db.prepare("INSERT INTO code_review_requests (workspace_id, actor_key, request_id, signature, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.workspaceId, actorKey, requestId, signature, result.id, Date.now());
      return result;
    }).immediate();
  }

  create(raw: CodeReviewCreateInput, actor: CodeReviewActor): CodeReviewThread {
    const input = parseCodeReviewInput(codeReviewCreateInputSchema, raw);
    return this.mutate("create", input, actor, (db, author) => {
      const id = this.runtime.uuid();
      const now = Date.now();
      db.prepare("INSERT INTO code_review_threads (id, workspace_id, file_path, anchor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, input.workspaceId, input.anchor.path, JSON.stringify(input.anchor), now, now);
      db.prepare("INSERT INTO code_review_comments (id, thread_id, seq, author_json, body, created_at) VALUES (?, ?, 1, ?, ?, ?)")
        .run(this.runtime.uuid(), id, JSON.stringify(author), input.body, now);
      return this.thread(db, input.workspaceId, id);
    });
  }

  reply(raw: CodeReviewReplyInput, actor: CodeReviewActor): CodeReviewThread {
    const input = parseCodeReviewInput(codeReviewReplyInputSchema, raw);
    return this.mutate("reply", input, actor, (db, author) => {
      const current = this.thread(db, input.workspaceId, input.threadId);
      const now = Math.max(Date.now(), current.updatedAt);
      db.prepare("UPDATE code_review_threads SET version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .run(now, input.workspaceId, input.threadId);
      db.prepare("INSERT INTO code_review_comments (id, thread_id, seq, author_json, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(this.runtime.uuid(), input.threadId, current.commentCount! + 1, JSON.stringify(author), input.body, now);
      return this.thread(db, input.workspaceId, input.threadId);
    });
  }

  setResolved(raw: CodeReviewSetResolvedInput, actor: CodeReviewActor): CodeReviewThread {
    const input = parseCodeReviewInput(codeReviewSetResolvedInputSchema, raw);
    return this.mutate("setResolved", input, actor, (db, author) => {
      const current = this.thread(db, input.workspaceId, input.threadId);
      if (current.version !== input.expectedVersion) throw new CodeReviewError("CODE_REVIEW_STALE", "This review thread changed. Refresh before resolving or reopening it.");
      if (current.resolved === input.resolved) return current;
      const now = Math.max(Date.now(), current.updatedAt);
      const changed = db.prepare("UPDATE code_review_threads SET resolved = ?, resolved_by = ?, resolved_at = ?, version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ?")
        .run(input.resolved ? 1 : 0, input.resolved ? JSON.stringify(author) : null, input.resolved ? now : null, now, input.workspaceId, input.threadId, input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new CodeReviewError("CODE_REVIEW_STALE", "This review thread changed. Refresh before resolving or reopening it.");
      return this.thread(db, input.workspaceId, input.threadId);
    });
  }
}

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  codeReviewActorSchema, codeReviewAnchorSchema, codeReviewCommentSchema,
  codeReviewCreateInputSchema, codeReviewThreadSchema,
} from "@zeros/protocol/code-review";
import type { CloudDurabilityAuthority } from "./cloud-durability-runtime";
import { openZerosDb } from "./db";
import { listKnownRepoRoots } from "./db/projects";
import { QualifiedCloudFilePolicy } from "./files/cloud-file-policy";
import { getWorkspaceByCanonicalId, listWorkspaces, zerosStateRoot } from "./git/state";
import { CodeReviewError } from "./code-review/errors";
import { assertCodeReviewPath } from "./code-review/paths";

const PREFIX = "code-review-v1:";
const timestamp = z.number().int().safe().nonnegative();
const identity = codeReviewThreadSchema.shape.id;
const actorKeySchema = z.string().min(1).max(1_024).refine((value) => {
  try {
    const actor = z.tuple([codeReviewActorSchema.shape.kind, codeReviewActorSchema.shape.id]).parse(JSON.parse(value));
    return JSON.stringify(actor) === value;
  } catch { return false; }
});
const threadSchema = codeReviewThreadSchema.omit({
  workspaceId: true, comments: true, commentsComplete: true, commentsCursor: true, commentsCursorAfter: true,
}).extend({ commentCount: z.number().int().safe().positive() }).refine((thread) =>
  thread.version >= thread.commentCount && thread.updatedAt >= thread.createdAt &&
  (thread.resolved
    ? thread.resolvedBy !== undefined && thread.resolvedAt !== undefined &&
      thread.resolvedAt >= thread.createdAt && thread.resolvedAt <= thread.updatedAt
    : thread.resolvedBy === undefined && thread.resolvedAt === undefined),
);
const scopeSchema = z.object({
  version: z.literal(1), workspaceId: z.string().uuid(), organizationId: z.string().uuid(),
});
const recordSchema = z.discriminatedUnion("kind", [
  scopeSchema.extend({ kind: z.literal("thread"), thread: threadSchema }).strict(),
  scopeSchema.extend({ kind: z.literal("comment"), threadId: identity,
    comment: codeReviewCommentSchema.extend({ sequence: z.number().int().safe().positive() }) }).strict(),
  scopeSchema.extend({ kind: z.literal("request"), threadId: identity,
    actorKey: actorKeySchema, requestId: codeReviewCreateInputSchema.shape.requestId.unwrap(),
    signature: z.string().regex(/^[a-f0-9]{64}$/), createdAt: timestamp,
    threadVersion: z.number().int().safe().positive() }).strict(),
]);
type ReviewRecord = z.infer<typeof recordSchema>;
type ThreadRecord = Extract<ReviewRecord, { kind: "thread" }>;
type CommentRecord = Extract<ReviewRecord, { kind: "comment" }>;
type RequestRecord = Extract<ReviewRecord, { kind: "request" }>;

export interface CloudCodeReviewEntity {
  entityKind: "metadata";
  entityId: string;
  schemaVersion: 1;
  document: Record<string, unknown>;
}
export interface CloudCodeReviewRemoteEntry {
  entityKind: string;
  entityId: string;
  schemaVersion: number;
  document: unknown;
  tombstonedAt: string | null;
}

function invalid(): Error { return new Error("cloud review document is invalid"); }
function digest(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
function threadEntityId(threadId: string): string { return `${PREFIX}thread:${digest(threadId)}`; }
function recordId(record: ReviewRecord): string {
  switch (record.kind) {
    case "thread": return threadEntityId(record.thread.id);
    case "comment": return `${PREFIX}comment:${digest(record.threadId, record.comment.id)}`;
    case "request": return `${PREFIX}request:${digest(record.actorKey, record.requestId)}`;
  }
}
export function isCloudCodeReviewEntity(entry: Pick<CloudCodeReviewRemoteEntry, "entityKind" | "entityId">): boolean {
  return entry.entityKind === "metadata" && entry.entityId.startsWith(PREFIX);
}
/** Thread headers publish last, after immutable children. The count/version is
 * the commit boundary when a large capture spans multiple bounded appends. */
export function isCloudCodeReviewThreadEntity(entry: Pick<CloudCodeReviewRemoteEntry, "entityKind" | "entityId">): boolean {
  return entry.entityKind === "metadata" && entry.entityId.startsWith(`${PREFIX}thread:`);
}
function parseRecord(entry: CloudCodeReviewRemoteEntry, authority: CloudDurabilityAuthority): ReviewRecord {
  const parsed = recordSchema.safeParse(entry.document);
  if (entry.schemaVersion !== 1 || !parsed.success ||
      parsed.data.workspaceId !== authority.workspaceId || parsed.data.organizationId !== authority.organizationId ||
      recordId(parsed.data) !== entry.entityId) throw invalid();
  return parsed.data;
}
function ownerFor(root: string, authority: CloudDurabilityAuthority) {
  const owner = getWorkspaceByCanonicalId(authority.workspaceId);
  if (!owner) return null;
  if (owner.placement !== "cloud" || owner.organizationId !== authority.organizationId ||
      path.resolve(owner.path) !== path.resolve(root)) throw new Error("cloud review workspace identity changed");
  return owner;
}
function pathChecker(root: string): (relative: string) => boolean {
  const owners = [...listWorkspaces({}).map((workspace) => workspace.path), ...listKnownRepoRoots()];
  const cloudFiles = new QualifiedCloudFilePolicy(root, {
    // The durable projection can be read by workspace viewers. Keep private
    // engine paths and sensitive source context outside that projection.
    canEdit: false, authorized: () => true,
    privateRoots: [zerosStateRoot(), os.homedir(), "/srv/zeros/state", "/srv/zeros/home", "/opt/zeros", "/etc/zeros", "/zeros", "/opt/zeros-infra", "/opt/zeros-bootstrap", "/srv/zeros/runtime-installs"],
    ownerRoots: () => owners,
  });
  const known = new Map<string, boolean>();
  return (relative) => {
    const prior = known.get(relative);
    if (prior !== undefined) return prior;
    try {
      assertCodeReviewPath(root, relative, { remote: true, cloudFiles, ownerRoots: () => owners });
      known.set(relative, true); return true;
    } catch (error) {
      if (error instanceof CodeReviewError && error.code === "CODE_REVIEW_PATH_DENIED") {
        known.set(relative, false); return false;
      }
      throw error;
    }
  };
}
function entity(record: ReviewRecord): CloudCodeReviewEntity {
  return { entityKind: "metadata", entityId: recordId(record), schemaVersion: 1, document: record };
}
function json<T>(schema: z.ZodType<T>, raw: unknown): T {
  try { return schema.parse(typeof raw === "string" ? JSON.parse(raw) : raw); }
  catch { throw invalid(); }
}
function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return left === right;
}

interface ThreadRow {
  id: string; workspace_id: string; file_path: string; anchor_json: string;
  resolved: number; resolved_by: string | null; resolved_at: number | null;
  version: number; created_at: number; updated_at: number;
}
interface CommentRow {
  id: string; thread_id: string; seq: number; author_json: string; body: string; created_at: number;
}
interface RequestRow {
  workspace_id: string; actor_key: string; request_id: string; signature: string; thread_id: string; created_at: number;
}
function threadValue(row: ThreadRow, commentCount: number): ThreadRecord["thread"] {
  const thread = json(threadSchema, {
    id: row.id, anchor: json(codeReviewAnchorSchema, row.anchor_json),
    resolved: row.resolved === 1, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, commentCount,
    ...(row.resolved_by !== null ? { resolvedBy: json(codeReviewActorSchema, row.resolved_by) } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  });
  if (row.file_path !== thread.anchor.path) throw invalid();
  return thread;
}
function commentValue(row: CommentRow): CommentRecord["comment"] {
  return json(codeReviewCommentSchema.extend({ sequence: z.number().int().safe().positive() }), {
    id: row.id, author: json(codeReviewActorSchema, row.author_json), body: row.body, createdAt: row.created_at, sequence: row.seq,
  });
}

export function captureCloudCodeReviewRecords(
  root: string, authority: CloudDurabilityAuthority, remote: ReadonlyMap<string, CloudCodeReviewRemoteEntry>,
): CloudCodeReviewEntity[] {
  const db = openZerosDb();
  const owner = ownerFor(root, authority);
  if (!owner) return [];
  const rows = db.prepare("SELECT * FROM code_review_threads WHERE workspace_id = ? ORDER BY id").all(owner.id) as ThreadRow[];
  if (rows.length === 0) return [];
  const readable = pathChecker(root);
  const scope = { version: 1 as const, workspaceId: authority.workspaceId, organizationId: authority.organizationId };
  const result: CloudCodeReviewEntity[] = [];
  for (const row of rows) {
    const anchor = json(codeReviewAnchorSchema, row.anchor_json);
    if (!readable(anchor.path)) continue;
    const comments = db.prepare("SELECT * FROM code_review_comments WHERE thread_id = ? ORDER BY seq").all(row.id) as CommentRow[];
    const thread = threadValue(row, comments.length);
    result.push(entity({ ...scope, kind: "thread", thread }));
    for (const [index, comment] of comments.entries()) {
      if (comment.seq !== index + 1) throw invalid();
      result.push(entity({ ...scope, kind: "comment", threadId: row.id, comment: commentValue(comment) }));
    }
    const requests = db.prepare("SELECT * FROM code_review_requests WHERE workspace_id = ? AND thread_id = ? ORDER BY actor_key, request_id")
      .all(owner.id, row.id) as RequestRow[];
    for (const request of requests) {
      let record = json(recordSchema, { ...scope, kind: "request", threadId: row.id,
        actorKey: request.actor_key, requestId: request.request_id, signature: request.signature,
        createdAt: request.created_at, threadVersion: thread.version }) as RequestRecord;
      const prior = remote.get(`metadata\0${recordId(record)}`);
      if (prior && !prior.tombstonedAt) {
        const previous = parseRecord(prior, authority);
        if (previous.kind !== "request" || !same({ ...previous, threadVersion: record.threadVersion }, record)) throw invalid();
        // A receipt is immutable after its first capture. Its commit version
        // must not move forward every time the thread gets another reply.
        record = previous;
      }
      result.push(entity(record));
    }
  }
  return result;
}

/** Only incomplete upload children are discardable. Committed records hidden
 * by a later path policy remain durable; review APIs have no delete operation. */
export function isUncommittedCloudCodeReviewRecord(
  entry: CloudCodeReviewRemoteEntry, remote: ReadonlyMap<string, CloudCodeReviewRemoteEntry>,
): boolean {
  if (!isCloudCodeReviewEntity(entry) || entry.tombstonedAt) return false;
  const parsed = recordSchema.safeParse(entry.document);
  if (!parsed.success || parsed.data.kind === "thread") return false;
  const record = parsed.data;
  const parent = remote.get(`metadata\0${threadEntityId(record.threadId)}`);
  const header = parent && !parent.tombstonedAt ? recordSchema.safeParse(parent.document) : undefined;
  if (!header?.success || header.data.kind !== "thread") return true;
  return record.kind === "comment"
    ? record.comment.sequence > header.data.thread.commentCount
    : record.threadVersion > header.data.thread.version;
}

/** Validate before any mutation. The returned writer runs in the runtime's
 * existing transaction; it never reads or writes checkout source contents. */
export function prepareCloudCodeReviewRestore(
  root: string, authority: CloudDurabilityAuthority, remote: ReadonlyMap<string, CloudCodeReviewRemoteEntry>,
  mode: "replace" | "missing",
): () => void {
  const entries = [...remote.values()].filter(isCloudCodeReviewEntity);
  if (entries.length === 0) return () => undefined;
  const owner = ownerFor(root, authority);
  if (!owner) throw new Error("cloud review workspace identity is unavailable");
  const readable = pathChecker(root);
  const db = openZerosDb();
  const records = entries.filter((entry) => !entry.tombstonedAt).map((entry) => parseRecord(entry, authority));
  const threads = new Map(records.filter((record): record is ThreadRecord => record.kind === "thread")
    .map((record) => [record.thread.id, record.thread]));
  const comments = new Map<string, CommentRecord["comment"][]>();
  const requests: RequestRecord[] = [];
  for (const record of records) {
    if (record.kind === "thread") continue;
    const parent = threads.get(record.threadId);
    // An interrupted bounded upload cannot publish children before its header.
    if (!parent || (record.kind === "comment" ? record.comment.sequence > parent.commentCount : record.threadVersion > parent.version)) continue;
    if (record.kind === "request") { requests.push(record); continue; }
    const list = comments.get(record.threadId) ?? [];
    list.push(record.comment); comments.set(record.threadId, list);
  }
  const writes: Array<{ thread: ThreadRecord["thread"]; existing: boolean; comments: CommentRecord["comment"][] }> = [];
  const admitted = new Set<string>();
  for (const [id, thread] of threads) {
    const history = (comments.get(id) ?? []).sort((a, b) => a.sequence - b.sequence);
    if (history.length !== thread.commentCount || history.some((comment, index) => comment.sequence !== index + 1)) throw invalid();
    const local = db.prepare("SELECT * FROM code_review_threads WHERE id = ?").get(id) as ThreadRow | undefined;
    if (local && local.workspace_id !== owner.id) throw new Error("cloud review identity belongs to another workspace");
    if (!readable(thread.anchor.path)) continue;
    admitted.add(id);
    const missing: CommentRecord["comment"][] = [];
    const localComments = local ? db.prepare("SELECT * FROM code_review_comments WHERE thread_id = ? ORDER BY seq").all(id) as CommentRow[] : [];
    for (const comment of history) {
      const byId = db.prepare("SELECT * FROM code_review_comments WHERE id = ?").get(comment.id) as CommentRow | undefined;
      const bySequence = localComments[comment.sequence - 1];
      if ((byId && (byId.thread_id !== id || !same(commentValue(byId), comment))) ||
          (bySequence && !same(commentValue(bySequence), comment))) throw new Error("cloud review immutable comment changed");
      if (!byId) missing.push(comment);
    }
    let chosen = thread;
    if (local) {
      const previous = threadValue(local, localComments.length);
      if (!same(previous.anchor, thread.anchor) || previous.createdAt !== thread.createdAt) throw new Error("cloud review immutable anchor changed");
      if (previous.version === thread.version && !same(previous, thread)) throw new Error("cloud review state conflicts");
      if (previous.version > thread.version) {
        if (mode === "replace") throw new Error("cloud review state moved backwards");
        chosen = { ...previous, version: Math.max(previous.version + missing.length, thread.version),
          updatedAt: Math.max(previous.updatedAt, thread.updatedAt) };
      } else if (localComments.length > thread.commentCount) throw new Error("cloud review state conflicts");
    }
    writes.push({ thread: chosen, existing: !!local, comments: missing });
  }
  const requestWrites = requests.filter((record) => admitted.has(record.threadId)).filter((record) => {
    const local = db.prepare("SELECT * FROM code_review_requests WHERE workspace_id = ? AND actor_key = ? AND request_id = ?")
      .get(owner.id, record.actorKey, record.requestId) as RequestRow | undefined;
    if (local && (local.thread_id !== record.threadId || local.signature !== record.signature || local.created_at !== record.createdAt))
      throw new Error("cloud review retry receipt changed");
    return !local;
  });
  const deleted = (db.prepare("SELECT id FROM code_review_threads WHERE workspace_id = ?").all(owner.id) as { id: string }[])
    .filter(({ id }) => remote.get(`metadata\0${threadEntityId(id)}`)?.tombstonedAt);
  return () => {
    for (const { id } of deleted) db.prepare("DELETE FROM code_review_threads WHERE workspace_id = ? AND id = ?").run(owner.id, id);
    for (const write of writes) {
      const thread = write.thread;
      if (write.existing) {
        db.prepare("UPDATE code_review_threads SET resolved = ?, resolved_by = ?, resolved_at = ?, version = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
          .run(thread.resolved ? 1 : 0, thread.resolvedBy ? JSON.stringify(thread.resolvedBy) : null,
            thread.resolvedAt ?? null, thread.version, thread.updatedAt, owner.id, thread.id);
      } else {
        db.prepare("INSERT INTO code_review_threads (id, workspace_id, file_path, anchor_json, resolved, resolved_by, resolved_at, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(thread.id, owner.id, thread.anchor.path, JSON.stringify(thread.anchor), thread.resolved ? 1 : 0,
            thread.resolvedBy ? JSON.stringify(thread.resolvedBy) : null, thread.resolvedAt ?? null,
            thread.version, thread.createdAt, thread.updatedAt);
      }
      for (const comment of write.comments) db.prepare("INSERT INTO code_review_comments (id, thread_id, seq, author_json, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(comment.id, thread.id, comment.sequence, JSON.stringify(comment.author), comment.body, comment.createdAt);
    }
    for (const record of requestWrites) db.prepare("INSERT INTO code_review_requests (workspace_id, actor_key, request_id, signature, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(owner.id, record.actorKey, record.requestId, record.signature, record.threadId, record.createdAt);
  };
}

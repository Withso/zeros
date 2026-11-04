import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  CODE_REVIEW_SCHEMA, CodeReviewAgentToolsCore, CodeReviewError, CodeReviewStoreCore,
  assertCodeReviewPathCore, codeReviewAgentActor, codeReviewHumanActorCore, handleCodeReviewRouteCore,
  type CodeReviewActor, type CodeReviewDatabase, type CodeReviewOperation, type CodeReviewStoreRuntime,
} from "@zeros/protocol/code-review";
import { isSensitiveWorkspacePath } from "@zeros/protocol/workspace-paths";
import { unsupported, WorkspaceError, type WorkspaceScope } from "./scope";

export interface ReviewLimits { threads: number; comments: number; requests: number; bodyBytes: number; bytes: number }
export const CLOUD_REVIEW_LIMITS: Readonly<ReviewLimits> = Object.freeze({ threads: 10_000, comments: 100_000, requests: 100_000, bodyBytes: 80_000, bytes: 64 * 1024 * 1024 });
export type ReviewUser = { userId: string; userName?: string };
interface ReviewDatabase {
  prepare: CodeReviewDatabase["prepare"];
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (filename: string, options: { enableForeignKeyConstraints: boolean; allowExtension: boolean }) => ReviewDatabase;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const capacity = () => new CodeReviewError("CODE_REVIEW_CAPACITY", "This workspace's review storage limit has been reached. Existing comments remain available.");
const sqliteFailure = (error: unknown): unknown => (error as { errcode?: number } | null)?.errcode === 13 ? capacity() : error;
function rollback(db: ReviewDatabase): void {
  // SQLITE_FULL can roll back automatically; retain the original typed failure.
  try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
}

function sqliteAdapter(db: ReviewDatabase): CodeReviewDatabase {
  return {
    prepare: sql => db.prepare(sql),
    transaction: <T>(operation: () => T) => {
      const run = (immediate: boolean): T => {
        db.exec(immediate ? "BEGIN IMMEDIATE" : "BEGIN");
        try { const result = operation(); db.exec("COMMIT"); return result; }
        catch (error) { rollback(db); throw error; }
      };
      return Object.assign(() => run(false), { immediate: () => run(true) });
    },
  };
}

/** The VM store shares Local's transactional model; its limits refuse new
 * writes without pruning anchors, replies or retry receipts. */
export class WorkerCodeReview {
  private db?: ReviewDatabase;
  private descriptor?: number;
  private store?: CodeReviewStoreCore;
  private actor?: CodeReviewActor;
  private userId?: string;
  private closed = false;

  constructor(readonly scope: WorkspaceScope, private readonly directory: string,
    private readonly changed: () => void, private readonly limits = CLOUD_REVIEW_LIMITS) {}

  get enabled(): boolean { return !this.closed && !!this.actor && !!this.store; }

  async configure(user?: ReviewUser): Promise<void> {
    if (this.closed) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.");
    if (!user) { this.actor = undefined; return; }
    if (this.userId && this.userId !== user.userId)
      throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The review workspace identity changed.");
    const actor = codeReviewHumanActorCore(user.userId, hash, user.userName);
    if (!this.db) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (this.closed) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "The workspace is stopping.");
      const filename = path.join(this.directory, "review.sqlite");
      const descriptor = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      let db: ReviewDatabase | undefined;
      try {
        const file = fs.fstatSync(descriptor);
        if (!file.isFile() || file.nlink !== 1) throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The review store could not be verified.");
        db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
        const opened = fs.lstatSync(filename);
        if (opened.dev !== file.dev || opened.ino !== file.ino || opened.nlink !== 1)
          throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The review store changed while opening.");
        const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
        const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
        const pages = Math.floor(this.limits.bytes / pageSize);
        if (!Number.isSafeInteger(pages) || pages < 1 || pageCount > pages) throw capacity();
        db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=500; PRAGMA max_page_count=${pages};`);
        const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
        if (version === 0) {
          db.exec("BEGIN IMMEDIATE");
          try {
            db.exec(CODE_REVIEW_SCHEMA);
            db.exec("CREATE TABLE review_owner (id INTEGER PRIMARY KEY CHECK (id=1), workspace_key TEXT NOT NULL); PRAGMA user_version=1;");
            db.prepare("INSERT INTO review_owner (id,workspace_key) VALUES (1,?)").run(this.scope.key);
            db.exec("COMMIT");
          } catch (error) { rollback(db); throw error; }
        } else if (version !== 1) throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The review store version is unavailable.");
        const owner = db.prepare("SELECT workspace_key FROM review_owner WHERE id=1").get() as { workspace_key: string } | undefined;
        if (owner?.workspace_key !== this.scope.key)
          throw new CodeReviewError("CODE_REVIEW_AUTHORITY_REJECTED", "The review store belongs to another workspace.");
        fs.fchmodSync(descriptor, 0o600);
        const database = sqliteAdapter(db);
        this.store = new CodeReviewStoreCore(() => database, {
          hash, uuid: randomUUID, encode: value => Buffer.from(value).toString("base64url"),
          decode: value => Buffer.from(value, "base64url").toString("utf8"), beforeWrite: (...args) => this.checkBudget(...args),
        });
        this.db = db;
        // Closing another descriptor to this inode can release SQLite's process
        // locks, so keep the custody descriptor until after the database closes.
        this.descriptor = descriptor;
      } catch (error) { db?.close(); fs.closeSync(descriptor); throw sqliteFailure(error); }
    }
    this.userId = user.userId; this.actor = actor;
  }

  private checkBudget(...[db, operation, input]: Parameters<NonNullable<CodeReviewStoreRuntime["beforeWrite"]>>): void {
    const count = (table: "code_review_threads" | "code_review_comments" | "code_review_requests") =>
      Number((db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);
    if (operation === "create" && count("code_review_threads") >= this.limits.threads ||
        operation !== "setResolved" && count("code_review_comments") >= this.limits.comments ||
        input.requestId && count("code_review_requests") >= this.limits.requests ||
        "body" in input && Buffer.byteLength(input.body) > this.limits.bodyBytes) throw capacity();
  }

  private execute(operation: CodeReviewOperation, raw: unknown, actor: CodeReviewActor): unknown {
    if (!this.enabled) return unsupported();
    try {
      return handleCodeReviewRouteCore({
        resolveReadCwd: id => { if (id !== this.scope.key) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This request belongs to another workspace."); return this.scope.root; },
        ownerRoots: () => [this.scope.root],
      }, operation, raw, {
        author: () => actor, viewer: true, remote: true,
        assertPath: (root, relative, policy, creating) => assertCodeReviewPathCore({ fs, path,
          isSensitiveRepoPath: value => isSensitiveWorkspacePath(value, path.posix.normalize) }, root, relative, policy, creating),
      }, this.store!);
    } catch (error) {
      throw sqliteFailure(error);
    }
  }

  handle(operation: string, params: Record<string, unknown>): unknown {
    if (!this.enabled) return unsupported();
    this.scope.assertId(params.workspaceId);
    if (!["codeReview.list", "codeReview.create", "codeReview.reply", "codeReview.setResolved"].includes(operation)) return unsupported();
    const result = this.execute(operation as CodeReviewOperation, { ...params, ...(params.workspaceId !== undefined ? { workspaceId: this.scope.key } : {}) }, this.actor!) as Record<string, unknown>;
    if (operation !== "codeReview.list") this.changed();
    const native = (value: Record<string, unknown>) => ({ ...value, workspaceId: this.scope.workspace.id });
    return { ...native(result), ...(Array.isArray(result.threads) ? { threads: result.threads.map(thread => native(thread)) } : {}) };
  }

  tools(input: { agentId: string; conversationId: string; executionId: string; assertCurrent(): void }): CodeReviewAgentToolsCore {
    const actor = codeReviewAgentActor(input);
    if (!actor || !this.enabled) return unsupported();
    return new CodeReviewAgentToolsCore({ workspaceId: this.scope.key, workspacePath: this.scope.root, assertCurrent: () => {
      input.assertCurrent(); if (!this.enabled) return unsupported();
    } }, (operation, raw, author) => this.execute(operation, raw, author), actor, () => this.changed());
  }

  close(): void {
    this.closed = true; this.actor = undefined; this.store = undefined;
    this.db?.close(); this.db = undefined;
    if (this.descriptor !== undefined) fs.closeSync(this.descriptor);
    this.descriptor = undefined;
  }
}

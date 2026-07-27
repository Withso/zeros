// ──────────────────────────────────────────────────────────
// Chats — the sidebar chat list in the unified Zeros DB (Phase 2a)
// ──────────────────────────────────────────────────────────
//
// The renderer's chat list (ChatThread / ChatRowWire) lived only in the
// Electron-main `zeros-agent-history.db`, reachable solely via IPC — so a relay
// client (web/mobile) couldn't see the user's chats. This serves the chat list
// from the engine over the bridge instead. Desktop write-throughs its chats
// here; web reads them.
//
// Shape mirrors the renderer's ChatRowWire (agent-history-client.ts) 1:1 —
// camelCase on the wire, snake_case in the table, numeric (ms) timestamps.
//
// NOTE: `bulkUpsert` is a MERGE, not a wholesale replace. The engine is a SHARED
// store (a web user creates chats too); a destructive replace driven by one
// client's dbReplaceAllChats would clobber another client's chats. Deletes flow
// explicitly through deleteChat. True cross-client reconciliation is Phase 3.
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";
import { nextRev, recordTombstone, clearTombstone } from "./sync";

// ── workspace_id stamping (v11) ────────────────────────────
//
// `chats.workspace_id` is a denormalized CACHE of the owning workspace,
// derived from `folder` (the agent cwd). The engine is the authority on the
// folder→workspace mapping (it holds the registry), so it injects a resolver
// here once at startup — `db/chats.ts` stays a dumb persister and never imports
// the workspace service (avoids a layering cycle). Same module-level-setter
// idiom as git/github.ts setTokenStore. When unset (e.g. a unit test that calls
// upsertChat directly), workspace_id falls back to NULL. The resolver maps:
// primary checkout → LOCAL_MAIN id, managed worktree → its id, plain/empty
// folder → null (no workspace). It is engine-authoritative: a remote client
// never supplies workspace_id — every upsert recomputes it from `folder`.
let resolveChatWorkspaceId: ((folder: string) => string | null) | null = null;

/** Wire the engine's authoritative folder→workspaceId resolver (called once at
 *  engine start with `(folder) => workspace.workspaceIdForCwd(folder)`). Pass
 *  `null` to clear it (test isolation). */
export function setChatWorkspaceResolver(
  fn: ((folder: string) => string | null) | null,
): void {
  resolveChatWorkspaceId = fn;
}

/** Resolve `folder` → owning workspace id for the cache column. Defensive:
 *  persistence must NEVER throw, so a resolver error degrades to NULL. */
function workspaceIdForChat(folder: string | null | undefined): string | null {
  if (!resolveChatWorkspaceId) return null;
  try {
    return resolveChatWorkspaceId(folder ?? "") ?? null;
  } catch {
    return null;
  }
}

/** Mirrors the renderer's ChatRowWire. */
export interface ChatRow {
  id: string;
  folder: string;
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  effort: string;
  permissionMode: string;
  /** The EXACT agent mode id the user last selected in-session (lossless,
   *  unlike `permissionMode`), so bypass/auto survive a restart. null ≡ unset. */
  lastModeId: string | null;
  /** The mode to return to when the Plan toggle is switched off. null ≡ unset. */
  prePlanModeId: string | null;
  fast: boolean;
  /** Extra dirs Claude can access beyond `folder` (the `/add-dir` command).
   *  Absolute paths; persisted as a JSON-array TEXT column. */
  additionalDirectories: string[];
  title: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  pinned: boolean;
  archived: boolean;
  sourceChatId: string | null;
  kind: string | null;
}

interface ChatDbRow {
  id: string;
  folder: string | null;
  agent_id: string | null;
  agent_name: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  last_mode_id: string | null;
  pre_plan_mode_id: string | null;
  fast: number | null;
  additional_directories: string | null;
  title: string | null;
  created_at: number | null;
  updated_at: number | null;
  session_id: string | null;
  pinned: number;
  archived: number;
  source_chat_id: string | null;
  kind: string | null;
}

/** Parse a JSON-array TEXT column into a clean string[] (de-duped, non-empty).
 *  Tolerant: a NULL/legacy/corrupt value yields []. */
function parseDirs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") continue;
      const p = v.trim();
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}

function toChatRow(r: ChatDbRow): ChatRow {
  return {
    id: r.id,
    folder: r.folder ?? "",
    agentId: r.agent_id,
    agentName: r.agent_name,
    model: r.model,
    effort: r.effort ?? "",
    permissionMode: r.permission_mode ?? "",
    lastModeId: r.last_mode_id ?? null,
    prePlanModeId: r.pre_plan_mode_id ?? null,
    fast: r.fast === 1,
    additionalDirectories: parseDirs(r.additional_directories),
    title: r.title ?? "",
    createdAt: r.created_at ?? 0,
    updatedAt: r.updated_at ?? 0,
    sessionId: r.session_id,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    sourceChatId: r.source_chat_id,
    kind: r.kind,
  };
}

function toDbParams(c: ChatRow): Record<string, string | number | null> {
  return {
    id: c.id,
    folder: c.folder ?? "",
    agent_id: c.agentId ?? null,
    agent_name: c.agentName ?? null,
    model: c.model ?? null,
    effort: c.effort ?? "",
    permission_mode: c.permissionMode ?? "",
    last_mode_id: c.lastModeId ?? null,
    pre_plan_mode_id: c.prePlanModeId ?? null,
    fast: c.fast ? 1 : 0,
    additional_directories: JSON.stringify(
      Array.isArray(c.additionalDirectories) ? c.additionalDirectories : [],
    ),
    title: c.title ?? "",
    created_at: typeof c.createdAt === "number" ? c.createdAt : 0,
    updated_at: typeof c.updatedAt === "number" ? c.updatedAt : 0,
    session_id: c.sessionId ?? null,
    pinned: c.pinned ? 1 : 0,
    archived: c.archived ? 1 : 0,
    source_chat_id: c.sourceChatId ?? null,
    kind: c.kind ?? null,
    // Engine-authoritative cache (v11): always recomputed from `folder`, never
    // taken from the client. NULL until the resolver is wired / for a folder
    // with no owning workspace.
    workspace_id: workspaceIdForChat(c.folder),
  };
}

const UPSERT_SQL = `
INSERT INTO chats (id, folder, agent_id, agent_name, model, effort, permission_mode,
                   last_mode_id, pre_plan_mode_id, fast,
                   additional_directories, title,
                   created_at, updated_at, session_id, pinned, archived, source_chat_id, kind,
                   workspace_id, rev)
VALUES (@id, @folder, @agent_id, @agent_name, @model, @effort, @permission_mode,
        @last_mode_id, @pre_plan_mode_id, @fast,
        @additional_directories, @title,
        @created_at, @updated_at, @session_id, @pinned, @archived, @source_chat_id, @kind,
        @workspace_id, @rev)
ON CONFLICT(id) DO UPDATE SET
  folder=excluded.folder, agent_id=excluded.agent_id, agent_name=excluded.agent_name,
  model=excluded.model, effort=excluded.effort, permission_mode=excluded.permission_mode,
  last_mode_id=excluded.last_mode_id, pre_plan_mode_id=excluded.pre_plan_mode_id,
  fast=excluded.fast, additional_directories=excluded.additional_directories,
  title=excluded.title, updated_at=excluded.updated_at,
  session_id=excluded.session_id, pinned=excluded.pinned, archived=excluded.archived,
  source_chat_id=excluded.source_chat_id, kind=excluded.kind,
  workspace_id=excluded.workspace_id, rev=excluded.rev`;
// NOTE: created_at is intentionally NOT in the UPDATE set. It is immutable after
// first insert — a coerced/streaming upsert from a remote client (coerceChatRow
// defaults a missing createdAt to 0) or a desktop write-through replaying
// renderer state would otherwise reset the real creation time, corrupting
// sort/age. The original INSERT value is preserved on every conflict.

/** Coerce an untrusted wire object (from a remote client) into a ChatRow, or
 *  null if it has no usable id. Defensive at the trust boundary. */
export function coerceChatRow(o: unknown): ChatRow | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const strOrNull = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    id: r.id,
    folder: str(r.folder),
    agentId: strOrNull(r.agentId),
    agentName: strOrNull(r.agentName),
    model: strOrNull(r.model),
    effort: str(r.effort),
    permissionMode: str(r.permissionMode),
    lastModeId: strOrNull(r.lastModeId),
    prePlanModeId: strOrNull(r.prePlanModeId),
    fast: r.fast === true,
    // Wire form is already a string[] (renderer threadToRow), but a remote
    // client is untrusted — keep only the string entries, drop the rest.
    additionalDirectories: Array.isArray(r.additionalDirectories)
      ? r.additionalDirectories.filter((d): d is string => typeof d === "string")
      : [],
    title: str(r.title),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    sessionId: strOrNull(r.sessionId),
    pinned: r.pinned === true,
    archived: r.archived === true,
    sourceChatId: strOrNull(r.sourceChatId),
    kind: strOrNull(r.kind),
  };
}

export function listChats(): ChatRow[] {
  const db = openZerosDb();
  const rows = db
    .prepare(
      `SELECT id, folder, agent_id, agent_name, model, effort, permission_mode,
              last_mode_id, pre_plan_mode_id, fast,
              additional_directories, title,
              created_at, updated_at, session_id, pinned, archived, source_chat_id, kind
       FROM chats ORDER BY updated_at DESC`,
    )
    .all() as ChatDbRow[];
  return rows.map(toChatRow);
}

/** Read a single chat by id, or null. Used at the remote trust boundary to
 *  preserve host-only fields (`additionalDirectories`, `fast`) that a relay
 *  client may not set on upsert. */
export function getChat(id: string): ChatRow | null {
  if (!id) return null;
  const db = openZerosDb();
  const row = db
    .prepare(
      `SELECT id, folder, agent_id, agent_name, model, effort, permission_mode,
              last_mode_id, pre_plan_mode_id, fast,
              additional_directories, title,
              created_at, updated_at, session_id, pinned, archived, source_chat_id, kind
       FROM chats WHERE id = ?`,
    )
    .get(id) as ChatDbRow | undefined;
  return row ? toChatRow(row) : null;
}

/** The chat's agent cwd (`folder`) and cached owning workspace id
 *  (`workspace_id`, v11) — what the turns recorder needs to snapshot in the
 *  right directory and tag a turn with the workspace the Changes tab keys on.
 *  Returns null when the chat row is absent. */
export function getChatLocation(
  id: string,
): { folder: string | null; workspaceId: string | null } | null {
  if (!id) return null;
  const row = openZerosDb()
    .prepare("SELECT folder, workspace_id FROM chats WHERE id = ? LIMIT 1")
    .get(id) as { folder: string | null; workspace_id: string | null } | undefined;
  return row ? { folder: row.folder, workspaceId: row.workspace_id } : null;
}

export function upsertChat(c: ChatRow): void {
  if (!c?.id) return;
  const db = openZerosDb();
  const tx = db.transaction(() => {
    db.prepare(UPSERT_SQL).run({ ...toDbParams(c), rev: nextRev() });
    // A (re)created chat is alive again — drop any stale tombstone so a later pull
    // doesn't delete it.
    clearTombstone("chat", c.id);
  });
  tx();
}

export function deleteChat(id: string): void {
  if (!id) return;
  const db = openZerosDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    recordTombstone("chat", id); // so the delete propagates on the next pull
  });
  tx();
}

/** Merge a batch (the desktop's dbReplaceAllChats write-through). Non-destructive
 *  — never deletes chats it doesn't see (those may belong to another client). */
export function bulkUpsertChats(chats: ChatRow[]): void {
  const db = openZerosDb();
  const stmt = db.prepare(UPSERT_SQL);
  const tx = db.transaction((rows: ChatRow[]) => {
    for (const c of rows) {
      if (!c?.id) continue;
      stmt.run({ ...toDbParams(c), rev: nextRev() });
      clearTombstone("chat", c.id);
    }
  });
  tx(chats);
}

/** One-time backfill of `workspace_id` for chats that predate v11 (the column
 *  defaults to NULL). Resolves each NULL row's `folder` through the wired engine
 *  resolver. Idempotent + cheap after the first pass (the `WHERE workspace_id IS
 *  NULL` filter narrows to plain-folder chats, which legitimately stay NULL).
 *  Deliberately does NOT bump `rev`: this is a cache fill, not a user-visible
 *  change, so it must not trigger a full re-pull on every relay client — the id
 *  rides along on each chat's next natural upsert instead. No-op until the
 *  resolver is wired (setChatWorkspaceResolver). */
export function backfillChatWorkspaceIds(): number {
  if (!resolveChatWorkspaceId) return 0;
  const db = openZerosDb();
  const rows = db
    .prepare("SELECT id, folder FROM chats WHERE workspace_id IS NULL")
    .all() as { id: string; folder: string | null }[];
  if (rows.length === 0) return 0;
  const upd = db.prepare("UPDATE chats SET workspace_id = ? WHERE id = ?");
  let filled = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const wsId = workspaceIdForChat(r.folder);
      if (wsId) {
        upd.run(wsId, r.id);
        filled += 1;
      }
    }
  });
  tx();
  return filled;
}

/** Move every chat anchored at `oldFolder` (the folder itself OR any subfolder)
 *  to `newFolder`, re-stamping the cached `workspace_id` from the new location.
 *  Used when a worktree is RESTORED to a different on-disk path than it was
 *  archived from (the "always succeeds" restore can fork a new path on a
 *  collision): without this the chats stay bound to the old, now-
 *  nonexistent folder and EVERY agent spawn fails the cwd-exists gate
 *  (gateway.ts resolveAgentCwd) with "the chat's folder no longer exists".
 *  Bumps `rev` so the move propagates to relay clients. Returns the count moved. */
export function rebindChatsFolder(
  oldFolder: string,
  newFolder: string,
  workspaceIdOverride?: string,
): number {
  if (!oldFolder || !newFolder || oldFolder === newFolder) return 0;
  const db = openZerosDb();
  const prefix = oldFolder.endsWith("/") ? oldFolder : oldFolder + "/";
  // Escape LIKE metacharacters in the literal prefix (real paths contain `_` —
  // e.g. the `ws_<id>` basename — and `_`/`%` would otherwise act as wildcards
  // and over-match sibling folders). One pass, backslash-prefixing `\`/`%`/`_`,
  // paired with the ESCAPE clause below; the trailing `%` stays a real wildcard.
  const likePrefix = prefix.replace(/[\\%_]/g, "\\$&");
  const rows = db
    .prepare(
      "SELECT id, folder, updated_at FROM chats WHERE folder = ? OR folder LIKE ? ESCAPE '\\'",
    )
    .all(oldFolder, likePrefix + "%") as {
    id: string;
    folder: string | null;
    updated_at: number;
  }[];
  if (rows.length === 0) return 0;
  const upd = db.prepare(
    "UPDATE chats SET folder = ?, workspace_id = ?, updated_at = ?, rev = ? WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (const r of rows) {
      // Exact match → newFolder; a subfolder → re-root its tail under newFolder
      // so a chat opened in a worktree subdir keeps its relative location.
      const folder =
        r.folder === oldFolder
          ? newFolder
          : newFolder + (r.folder ?? "").slice(oldFolder.length);
      upd.run(
        folder,
        workspaceIdOverride ?? workspaceIdForChat(folder),
        Math.max(Date.now(), r.updated_at + 1),
        nextRev(),
        r.id,
      );
    }
  });
  tx();
  return rows.length;
}

export interface ChatSummaryRow {
  chatId: string;
  title: string;
  folder: string;
  summary: string;
  summaryAt: number;
  agentId: string | null;
  agentName: string | null;
}

/** Prior chats in a folder that have ≥1 user message, each carrying its FIRST
 *  user message as the "summary" — the empty-composer handoff picker (Phase D2).
 *  Reproduces the old electron/db.ts query over the engine's chats + chat_messages
 *  (so it works on web too). Explicit summaries were never written (the Summarize
 *  button is unwired), so the value is always the first user message; summaryAt 0. */
export function summariesForFolder(
  folder: string,
  excludeChatId?: string,
): ChatSummaryRow[] {
  if (!folder) return [];
  const rows = openZerosDb()
    .prepare(
      `SELECT chats.id AS chatId, chats.title AS title, chats.folder AS folder,
              chats.agent_id AS agentId, chats.agent_name AS agentName,
              (SELECT json_extract(cm.payload, '$.text') FROM chat_messages cm
                 WHERE cm.chat_id = chats.id AND cm.kind = 'text'
                   AND json_extract(cm.payload, '$.role') = 'user'
                   AND json_extract(cm.payload, '$.text') IS NOT NULL
                 ORDER BY cm.ord ASC LIMIT 1) AS summary
         FROM chats
        WHERE chats.folder = ? AND chats.id != ? AND chats.archived = 0
          AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = chats.id
                        AND cm.kind = 'text' AND json_extract(cm.payload, '$.role') = 'user')
        ORDER BY chats.updated_at DESC`,
    )
    .all(folder, excludeChatId ?? "") as {
    chatId: string;
    title: string | null;
    folder: string | null;
    agentId: string | null;
    agentName: string | null;
    summary: string | null;
  }[];
  return rows.map((r) => ({
    chatId: r.chatId,
    title: r.title ?? "",
    folder: r.folder ?? "",
    summary: r.summary ?? "",
    summaryAt: 0,
    agentId: r.agentId,
    agentName: r.agentName,
  }));
}

/** Chats changed since a pull cursor (rev > since), oldest-change first. The delta
 *  half of db.pull — paired with tombstonesSince('chat', since) for deletes. */
export function listChatsSince(since: number): ChatRow[] {
  const rows = openZerosDb()
    .prepare(
      `SELECT id, folder, agent_id, agent_name, model, effort, permission_mode,
              last_mode_id, pre_plan_mode_id, fast,
              additional_directories, title,
              created_at, updated_at, session_id, pinned, archived, source_chat_id, kind
       FROM chats WHERE rev > ? ORDER BY rev`,
    )
    .all(since) as ChatDbRow[];
  return rows.map(toChatRow);
}

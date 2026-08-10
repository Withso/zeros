// ──────────────────────────────────────────────────────────
// Chats — the sidebar chat list in the unified Zeros DB
// ──────────────────────────────────────────────────────────
//
// The renderer's chat list (ChatThread / ChatRowWire) lived only in the
// Electron-main `zeros-agent-history.db`, reachable solely via IPC — so a relay
// client could not see the user's chats. This serves the chat list from the
// engine over the bridge instead. Desktop writes its chats through here, and
// optional remote relay clients read them.
//
// Shape mirrors the renderer's ChatRowWire (agent-history-client.ts) 1:1 —
// camelCase on the wire, snake_case in the table, numeric (ms) timestamps.
//
// NOTE: `bulkUpsert` is a MERGE, not a wholesale replace. The engine is a SHARED
// store (a remote client may create chats too); a destructive replace driven by one
// client's dbReplaceAllChats would clobber another client's chats. Deletes flow
// explicitly through deleteChat. Cross-client reconciliation uses revision sync.
// ──────────────────────────────────────────────────────────

import { openZerosDb } from "./index";
import { nextRev, recordTombstone, clearTombstone } from "./sync";
import {
  coerceProviderBinding,
  coerceProviderMetadata,
  type ProviderBinding,
  type ProviderMetadata,
} from "@zeros/protocol/identities";

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
  /** Deprecated compatibility locator for builds before the identity model.
   * Never use this as a live execution route. */
  sessionId: string | null;
  /** Optional on the wire for protocol-v8/legacy renderer compatibility. */
  providerBinding?: ProviderBinding | null;
  /** Optional on the wire for protocol-v8/legacy renderer compatibility. */
  providerMetadata?: ProviderMetadata | null;
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
  provider_binding: string | null;
  provider_metadata: string | null;
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

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toChatRow(r: ChatDbRow): ChatRow {
  const parsedBinding = coerceProviderBinding(
    r.provider_binding ? safeJson(r.provider_binding) : null,
  );
  const providerBinding =
    parsedBinding && parsedBinding.providerId === r.agent_id
      ? parsedBinding
      : null;
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
    providerBinding,
    providerMetadata: providerBinding
      ? coerceProviderMetadata(r.provider_metadata)
      : null,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    sourceChatId: r.source_chat_id,
    kind: r.kind,
  };
}

function toDbParams(c: ChatRow): Record<string, string | number | null> {
  const parsedBinding = coerceProviderBinding(c.providerBinding);
  const providerBinding =
    parsedBinding && parsedBinding.providerId === c.agentId
      ? parsedBinding
      : null;
  const providerMetadata = providerBinding
    ? coerceProviderMetadata(c.providerMetadata)
    : null;
  // Keep the old column as a downgrade locator, never as the canonical route.
  // Migrated Claude rows retain their old directory locator; new native
  // bindings mirror the provider resume id and never a current execution id.
  const compatibilitySessionId = providerBinding
    ? (providerBinding.legacySessionId ?? providerBinding.resumeId)
    : (c.sessionId ?? null);
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
    session_id: compatibilitySessionId,
    provider_binding: providerBinding ? JSON.stringify(providerBinding) : null,
    provider_metadata: providerMetadata
      ? JSON.stringify(providerMetadata)
      : null,
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
                   created_at, updated_at, session_id, provider_binding, provider_metadata,
                   pinned, archived, source_chat_id, kind,
                   workspace_id, rev)
VALUES (@id, @folder, @agent_id, @agent_name, @model, @effort, @permission_mode,
        @last_mode_id, @pre_plan_mode_id, @fast,
        @additional_directories, @title,
        @created_at, @updated_at, @session_id, @provider_binding, @provider_metadata,
        @pinned, @archived, @source_chat_id, @kind,
        @workspace_id, @rev)
ON CONFLICT(id) DO UPDATE SET
  folder=excluded.folder, agent_id=excluded.agent_id, agent_name=excluded.agent_name,
  model=excluded.model, effort=excluded.effort, permission_mode=excluded.permission_mode,
  last_mode_id=excluded.last_mode_id, pre_plan_mode_id=excluded.pre_plan_mode_id,
  fast=excluded.fast, additional_directories=excluded.additional_directories,
  title=excluded.title, updated_at=excluded.updated_at,
  session_id=excluded.session_id, provider_binding=excluded.provider_binding,
  provider_metadata=excluded.provider_metadata,
  pinned=excluded.pinned, archived=excluded.archived,
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
  const agentId = strOrNull(r.agentId);
  const providerBinding = coerceProviderBinding(r.providerBinding);
  return {
    id: r.id,
    folder: str(r.folder),
    agentId,
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
      ? r.additionalDirectories.filter(
          (d): d is string => typeof d === "string",
        )
      : [],
    title: str(r.title),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
    sessionId: strOrNull(r.sessionId),
    // A binding is owned by the selected provider. Refuse a cross-provider
    // binding at the untrusted relay boundary instead of handing it to an
    // adapter with different credentials/storage semantics.
    providerBinding:
      providerBinding && providerBinding.providerId === agentId
        ? providerBinding
        : null,
    providerMetadata:
      providerBinding && providerBinding.providerId === agentId
        ? coerceProviderMetadata(r.providerMetadata)
        : null,
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
              created_at, updated_at, session_id, provider_binding, provider_metadata,
              pinned, archived, source_chat_id, kind
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
              created_at, updated_at, session_id, provider_binding, provider_metadata,
              pinned, archived, source_chat_id, kind
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
    .get(id) as
    | { folder: string | null; workspace_id: string | null }
    | undefined;
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

/** Persist a provider resume handle learned after session creation (Claude
 * publishes its native id from the first streamed init event). This narrow
 * engine-owned update avoids round-tripping the whole chat row through the
 * renderer, which can unmount on tab close before its effect runs.
 *
 * The selected agent remains authoritative and every identity column changes
 * in one SQL statement. Omitted metadata means "not refined by this event",
 * not "erase the last confirmed snapshot". */
export function updateChatProviderIdentity(
  chatId: string,
  agentId: string,
  binding: ProviderBinding,
  metadata?: ProviderMetadata | null,
): boolean {
  if (!chatId || !agentId) return false;
  const providerBinding = coerceProviderBinding(binding);
  if (!providerBinding || providerBinding.providerId !== agentId) return false;
  const hasMetadata = metadata !== undefined;
  const providerMetadata = hasMetadata
    ? coerceProviderMetadata(metadata)
    : null;
  const compatibilitySessionId =
    providerBinding.legacySessionId ?? providerBinding.resumeId;
  const result = openZerosDb()
    .prepare(
      `UPDATE chats
       SET session_id = @session_id,
           provider_binding = @provider_binding,
           provider_metadata = CASE
             WHEN @has_metadata = 1 THEN @provider_metadata
             ELSE provider_metadata
           END,
           rev = @rev
       WHERE id = @id AND agent_id = @agent_id`,
    )
    .run({
      id: chatId,
      agent_id: agentId,
      session_id: compatibilitySessionId,
      provider_binding: JSON.stringify(providerBinding),
      provider_metadata: providerMetadata
        ? JSON.stringify(providerMetadata)
        : null,
      has_metadata: hasMetadata ? 1 : 0,
      rev: nextRev(),
    });
  return result.changes > 0;
}

/** Explicitly detach a provider conversation after that provider confirmed it
 * no longer exists (or the user reset a pristine same-agent chat). The
 * compare-and-clear guard prevents a delayed renderer write from erasing a
 * newer binding learned by the engine after the reset was requested. */
export function clearChatProviderIdentity(
  chatId: string,
  agentId: string,
  expectedResumeId: string,
): boolean {
  if (!chatId || !agentId || !expectedResumeId) return false;
  const db = openZerosDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT session_id, provider_binding FROM chats WHERE id = ? AND agent_id = ?",
      )
      .get(chatId, agentId) as
      | { session_id: string | null; provider_binding: string | null }
      | undefined;
    const binding = coerceProviderBinding(
      row?.provider_binding ? safeJson(row.provider_binding) : null,
    );
    const providerMatches =
      binding?.providerId === agentId && binding.resumeId === expectedResumeId;
    const legacyMatches = !binding && row?.session_id === expectedResumeId;
    if (!providerMatches && !legacyMatches) {
      return false;
    }
    const result = db
      .prepare(
        `UPDATE chats
            SET session_id = NULL,
                provider_binding = NULL,
                provider_metadata = NULL,
                rev = @rev
          WHERE id = @id AND agent_id = @agent_id`,
      )
      .run({ id: chatId, agent_id: agentId, rev: nextRev() });
    return result.changes > 0;
  });
  return tx();
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
  /** Prompts the user sent to this agent — nothing else.
   *
   *  This was `COUNT(*)` over the persisted rows until 2026-07-30, and that
   *  number was indefensible on a pill: tool calls and reasoning each persist
   *  a row, so a chat the user could see was two questions long reported "55
   *  messages". A count nobody can reproduce by looking at the chat is worse
   *  than no count, and the founder's call was to count the one thing that IS
   *  legible — how many times you asked.
   *
   *  It is also now the SAME set the `summary` subquery draws its text from,
   *  and the same set `groupMessagesIntoTurns` opens a turn for — so the pill's
   *  number, the pill's label and the concise transcript the pill attaches all
   *  describe one thing.
   *
   *  Auto-actions (Create PR, Commit & Push — see AgentTextMessage.autoAction)
   *  ARE counted. Zeros sent the text, but it occupies a real user turn in the
   *  timeline and in the transcript, and excluding it would make this number
   *  disagree with the document it advertises. */
  userMessageCount: number;
  /** Epoch ms of the newest message, or 0 for a chat with none. Drives the
   *  "last active" line in the transcript hover preview and NOTHING else —
   *  deliberately not the sort key (see below). */
  lastMessageAt: number;
}

/** Prior chats in a folder that have ≥1 user message, each carrying its FIRST
 *  user message as the "summary" — feeds the empty chat's transcript pill row.
 *  Explicit summaries were never written (the Summarize button is unwired), so
 *  the value is always the first user message; summaryAt 0.
 *
 *  ORDERING (2026-07-30). This used to be `ORDER BY chats.updated_at DESC`,
 *  which looked like activity order and was not: `updated_at` is bumped only by
 *  title/settings writes and the `TOUCH_CHAT` reducer, and TOUCH_CHAT has zero
 *  dispatch sites. The persist-on-emit path writes `chat_messages` and never
 *  touches the parent row, so the key was effectively "when the AI title
 *  landed" — near-creation order with jitter from later renames.
 *
 *  It is now creation order, newest first, for two reasons:
 *
 *   • `created_at` is the one column here that cannot drift. It is
 *     deliberately excluded from the upsert's ON CONFLICT DO UPDATE set (see
 *     the note on CHAT_UPSERT_SQL) precisely so a coerced remote write can't
 *     corrupt sort/age.
 *   • It holds still. `MAX(created_at)` activity order re-sorts the row under
 *     the user's cursor every time a background agent finishes a turn — you
 *     reach for the second pill and click the third.
 *
 *  The `rowid` tiebreak is load-bearing, not decoration: `created_at` is
 *  INTEGER with no NOT NULL and no default, and `coerceChatRow` defaults a
 *  missing createdAt to 0, so legacy and coerced rows collapse into one tie
 *  that would otherwise order arbitrarily per query. rowid is insertion order.
 *
 *  ARCHIVED chats are included. A chat's transcript does not become less
 *  useful when its tab is closed — it is usually MORE useful, because you
 *  closed the tab when the work finished. Open-vs-closed is not a distinction
 *  this list makes anywhere.
 *
 *  The SQL is a named constant, and exported, ONLY so db.test.ts can run
 *  EXPLAIN QUERY PLAN over the exact text that ships: the user-prompt count's
 *  cost hangs on a partial index whose use SQLite decides syntactically, and
 *  the query returns identical rows with or without it — just two orders of
 *  magnitude slower. A behavioural test cannot see that; the plan can. */
export const CHAT_SUMMARIES_SQL = `SELECT chats.id AS chatId, chats.title AS title, chats.folder AS folder,
              chats.agent_id AS agentId, chats.agent_name AS agentName,
              (SELECT json_extract(cm.payload, '$.text') FROM chat_messages cm
                 WHERE cm.chat_id = chats.id AND cm.kind = 'text'
                   AND json_extract(cm.payload, '$.role') = 'user'
                   AND json_extract(cm.payload, '$.text') IS NOT NULL
                 ORDER BY cm.ord ASC LIMIT 1) AS summary,
              -- The one term here that cannot short-circuit, so it is the one
              -- that needs an index: idx_chat_messages_user_text (migration
              -- 25) is PARTIAL on exactly this predicate. SQLite only uses a
              -- partial index when it can syntactically prove the query
              -- implies the index's WHERE, so keep these two terms in this
              -- order and in this spelling — a rewrite silently falls back to
              -- a full scan of every message in the folder with no error.
              -- db.test.ts pins the plan.
              (SELECT COUNT(*) FROM chat_messages cm
                 WHERE cm.chat_id = chats.id AND cm.kind = 'text'
                   AND json_extract(cm.payload, '$.role') = 'user') AS userMessageCount,
              (SELECT MAX(cm.created_at) FROM chat_messages cm
                 WHERE cm.chat_id = chats.id) AS lastMessageAt
         FROM chats
        WHERE chats.folder = ? AND chats.id != ?
          AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = chats.id
                        AND cm.kind = 'text' AND json_extract(cm.payload, '$.role') = 'user')
        ORDER BY chats.created_at DESC, chats.rowid DESC`;

export function summariesForFolder(
  folder: string,
  excludeChatId?: string,
): ChatSummaryRow[] {
  if (!folder) return [];
  const rows = openZerosDb()
    .prepare(CHAT_SUMMARIES_SQL)
    .all(folder, excludeChatId ?? "") as {
    chatId: string;
    title: string | null;
    folder: string | null;
    agentId: string | null;
    agentName: string | null;
    summary: string | null;
    userMessageCount: number | null;
    lastMessageAt: number | null;
  }[];
  return rows.map((r) => ({
    chatId: r.chatId,
    title: r.title ?? "",
    folder: r.folder ?? "",
    summary: r.summary ?? "",
    summaryAt: 0,
    agentId: r.agentId,
    agentName: r.agentName,
    // The EXISTS gate above uses the IDENTICAL predicate, so every row that
    // reaches here has at least one — the pill can never draw a 0.
    userMessageCount: r.userMessageCount ?? 0,
    // MAX() over zero rows is SQL NULL. Unreachable through the EXISTS clause
    // today, but a 0 here is a falsy "unknown" the renderer can branch on,
    // where a NULL would print as "last active 1 Jan 1970".
    lastMessageAt: r.lastMessageAt ?? 0,
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
              created_at, updated_at, session_id, provider_binding, provider_metadata,
              pinned, archived, source_chat_id, kind
       FROM chats WHERE rev > ? ORDER BY rev`,
    )
    .all(since) as ChatDbRow[];
  return rows.map(toChatRow);
}

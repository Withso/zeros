// ──────────────────────────────────────────────────────────
// Zeros DB — linear schema migrations
// ──────────────────────────────────────────────────────────
//
// The model: a single SQLite file advanced by an ORDERED, append-only list of
// migrations tracked in `schema_migrations`. Each migration runs once, in a
// transaction, in version order. NEVER edit or
// reorder a shipped migration — add a new one. This replaced the ad-hoc
// `CREATE TABLE IF NOT EXISTS` / guarded `ALTER` style of the prior legacy DBs
// (agent-history + the git/workspace state DB), whose schemas were folded in here.
//
// Schema shape is defined by these forward-only migrations. Every row carries a
// monotonic `rev` for future remote/client synchronization over the bridge.
// ──────────────────────────────────────────────────────────

import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  /** Idempotency is NOT required — the runner guarantees each runs at most once. */
  up: string;
}

/** v1 — the initial unified schema. Folds in what today lives across
 *  state.db (workspaces), zeros-agent-history.db (chats/messages/policies),
 *  and the localStorage projects registry. */
const INITIAL_SCHEMA = `
-- Repos the user has added (today: localStorage zeros-projects-v1).
CREATE TABLE repos (
  id            TEXT PRIMARY KEY,
  remote_url    TEXT,
  name          TEXT,
  default_branch TEXT DEFAULT 'main',
  root_path     TEXT,
  setup_script  TEXT,
  run_script    TEXT,
  archive_script TEXT,
  zeros_config  TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  rev           INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Worktrees (today: state.db.workspaces).
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT REFERENCES repos(id),
  branch          TEXT,
  base_branch     TEXT,
  directory_name  TEXT,
  path            TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  derived_status  TEXT DEFAULT 'in-progress',
  manual_status   TEXT,
  active_session_id TEXT,
  stash_ref       TEXT,
  pr_number       INTEGER,
  pr_state        TEXT,
  pr_url          TEXT,
  pr_title        TEXT,
  pr_description  TEXT,
  agent_id        TEXT,
  last_active_at  TEXT,
  pinned_at       TEXT,
  notes           TEXT,
  location        TEXT NOT NULL DEFAULT 'local',  -- 'local' | 'cloud'
  sandbox_provider TEXT,
  hosting_server_url TEXT,
  rev             INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_id);
CREATE INDEX idx_workspaces_status ON workspaces(status);

-- One row per agent run/chat (today: split across chats + agent_chat_meta).
-- agent_type is just a label; storage is agent-agnostic.
-- native_session_id = resume handle: native-file uuid (Claude/Codex) or the SDK session id (Cursor).
-- NOTE: this v1 table is DROPPED by migration 7.
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT REFERENCES workspaces(id),
  folder          TEXT,
  agent_type      TEXT,
  native_session_id TEXT,
  model           TEXT,
  effort          TEXT,
  permission_mode TEXT DEFAULT 'default',
  title           TEXT DEFAULT 'Untitled',
  status          TEXT DEFAULT 'idle',
  context_token_count INTEGER DEFAULT 0,
  context_used_percent REAL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  source_chat_id  TEXT,
  kind            TEXT,
  last_user_message_at TEXT,
  resume_at       TEXT,
  rev             INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

-- Render rows (idealized Phase-0 guess). DROPPED by migration 7 — the engine
-- uses chat_messages.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id),
  seq           INTEGER NOT NULL,
  role          TEXT,
  kind          TEXT,
  content       TEXT,
  full_message  TEXT,
  turn_id       TEXT,
  native_msg_id TEXT,
  rev           INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);

-- Cross-session / cross-agent full-text search over rendered content (FTS5,
-- external-content over the messages table, kept in sync by triggers).
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Per-chat permission policies (today: agent_chat_policies).
CREATE TABLE policies (
  session_id TEXT NOT NULL,
  policy_id  TEXT NOT NULL,
  payload    TEXT,
  rev        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, policy_id)
);

-- Settings: scope='synced' rides the relay; scope='local' stays device-local.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT 'synced',
  rev        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,
  session_id   TEXT,
  message_id   TEXT,
  type         TEXT,
  original_name TEXT,
  path         TEXT,
  is_draft     INTEGER NOT NULL DEFAULT 1,
  rev          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_attachments_session ON attachments(session_id);

CREATE TABLE diff_comments (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  file_path    TEXT,
  line_number  INTEGER,
  end_line_number INTEGER,
  body         TEXT,
  state        TEXT,
  thread_id    TEXT,
  reply_to_comment_id TEXT,
  is_resolved  INTEGER,
  is_outdated  INTEGER,
  author       TEXT,
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_diff_comments_workspace ON diff_comments(workspace_id);

CREATE TABLE terminal_sessions (
  session_id   TEXT PRIMARY KEY,
  workspace_id TEXT,
  cwd          TEXT,
  cols         INTEGER,
  rows         INTEGER,
  rehydrate_sequences TEXT,
  started_at   TEXT,
  ended_at     TEXT,
  rev          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE port_forwards (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT,
  remote_port  INTEGER,
  local_port   INTEGER,
  protocol     TEXT DEFAULT 'tcp',
  label        TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1
);

-- Per-peer sync cursors for db.pull/push over the relay (§5).
CREATE TABLE sync_state (
  peer_id         TEXT PRIMARY KEY,
  last_pulled_rev INTEGER NOT NULL DEFAULT 0,
  last_pushed_rev INTEGER NOT NULL DEFAULT 0
);
`;

/** v2 — give `repos` the columns the renderer's Project shape needs
 *  (repoSlug + addedAt; originUrl reuses remote_url) and make root_path the
 *  natural dedup key so seed/upsert-by-root is conflict-safe. */
const MIGRATION_2_PROJECTS = `
ALTER TABLE repos ADD COLUMN repo_slug TEXT;
ALTER TABLE repos ADD COLUMN added_at INTEGER;
CREATE UNIQUE INDEX idx_repos_root ON repos(root_path);
`;

/** v3 — the sidebar chat list. Faithful to the renderer's
 *  ChatRowWire / electron-main `chats` table so the migration is a 1:1 copy and
 *  the existing ChatThread↔row mapping is reused. Numeric (ms) timestamps. The
 *  Phase-0 `sessions`/`messages` tables were idealized guesses superseded by
 *  this `chats` table plus the chat-keyed messages table added in v4; they
 *  stayed (empty/unused) and were dropped by migration 7. */
const MIGRATION_3_CHATS = `
CREATE TABLE chats (
  id              TEXT PRIMARY KEY,
  folder          TEXT,
  agent_id        TEXT,
  agent_name      TEXT,
  model           TEXT,
  effort          TEXT,
  permission_mode TEXT,
  title           TEXT,
  created_at      INTEGER,
  updated_at      INTEGER,
  session_id      TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  source_chat_id  TEXT,
  kind            TEXT,
  rev             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_chats_folder ON chats(folder);
CREATE INDEX idx_chats_updated ON chats(updated_at DESC);
`;

/** v4 — chat transcripts. The engine persists agent messages here as
 *  IT STREAMS them (engine-persists-on-emit; it's the source — works even for a
 *  running agent whose client is disconnected). One row per coalesced AgentMessage,
 *  keyed by (chat_id, msg_id) so a streaming message upserts a single row as its
 *  chunks arrive (mirrors the retired electron/db.ts agent_messages). `payload` is the
 *  JSON AgentMessage; `ord` drives pagination; aggregation is by chat_id so a
 *  chat that spans multiple sessions (model-swap forks) reads as one transcript. */
const MIGRATION_4_MESSAGES = `
CREATE TABLE chat_messages (
  chat_id    TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  ord        INTEGER NOT NULL,
  kind       TEXT,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rev        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX idx_chat_messages_chat_ord ON chat_messages(chat_id, ord);
CREATE INDEX idx_chat_messages_created ON chat_messages(chat_id, created_at);
`;

/** v5 — full-text search over transcripts. A plain `content` column
 *  holds the message's searchable text (extracted from the payload JSON: a text
 *  message's `text`, else a tool's `title`), kept current by db/messages.ts on
 *  upsert. An FTS5 external-content table indexes it, synced by triggers. The
 *  backfill populates content + the index for rows that predate this. */
const MIGRATION_5_FTS = `
ALTER TABLE chat_messages ADD COLUMN content TEXT;
UPDATE chat_messages
   SET content = COALESCE(json_extract(payload, '$.text'), json_extract(payload, '$.title'), '');
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(content, content='chat_messages', content_rowid='rowid');
INSERT INTO chat_messages_fts(rowid, content) SELECT rowid, content FROM chat_messages;
CREATE TRIGGER chat_messages_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER chat_messages_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER chat_messages_au AFTER UPDATE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

/** v6 — incremental delta sync. Until now `rev` was a
 *  per-row counter (`rev = rev + 1`), which can't answer "what changed since
 *  cursor N?" across rows. This adds ONE monotonic sequence (`sync_meta.next_rev`)
 *  handed out by nextRev(); writers stamp the row's `rev` from it, so a client can
 *  `pull(since)` exactly the rows with `rev > since`. Deletes can't be pulled (the
 *  row is gone) so they leave a `sync_tombstones` entry, also rev-stamped. The
 *  seed puts next_rev ABOVE any existing per-row rev so legacy rows keep sorting
 *  before fresh global revs (and the first pull, since=0, returns everything). */
const MIGRATION_6_SYNC = `
CREATE TABLE sync_meta (
  id        INTEGER PRIMARY KEY CHECK (id = 0),
  next_rev  INTEGER NOT NULL
);
INSERT INTO sync_meta (id, next_rev) VALUES (0, (
  SELECT COALESCE(MAX(r), 0) + 1 FROM (
    SELECT MAX(rev) AS r FROM chats
    UNION ALL SELECT MAX(rev) FROM repos
    -- M5: include chat_messages (created in migration 4) — omitting it could seed
    -- next_rev BELOW an existing message rev, breaking monotonicity (pre-existing
    -- messages re-deliver, and new revs eventually collide with old message rows).
    UNION ALL SELECT MAX(rev) FROM chat_messages
    UNION ALL SELECT 0
  )
));
CREATE TABLE sync_tombstones (
  kind TEXT NOT NULL,   -- 'chat' (extend as more entities sync)
  id   TEXT NOT NULL,
  rev  INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX idx_tombstones_rev ON sync_tombstones(rev);
`;

/** v7 — fold state.db into zeros.db under the one-engine-database model. The
 *  `workspaces`/`sessions`/`messages`/`messages_fts`/`policies` tables were
 *  idealized guesses, all empty + unused — the app uses `chats`/`chat_messages`
 *  (migrations 3-5), per-chat policies live in renderer localStorage, and the
 *  real workspace registry lived in the separate ~/.zeros/state.db. Drop the
 *  idealized set and create state.db's REAL schema here so the engine owns ONE
 *  file. The data copy from the legacy state.db is a one-time engine-side import
 *  (db/state-import.ts), like the agent-history import. */
const MIGRATION_7_WORKSPACES = `
DROP TRIGGER IF EXISTS messages_ai;
DROP TRIGGER IF EXISTS messages_ad;
DROP TRIGGER IF EXISTS messages_au;
DROP TABLE IF EXISTS messages_fts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS policies;
DROP INDEX IF EXISTS idx_workspaces_repo;
DROP INDEX IF EXISTS idx_workspaces_status;
DROP TABLE IF EXISTS workspaces;

CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  repo_slug       TEXT NOT NULL,
  repo_root       TEXT NOT NULL,
  branch          TEXT NOT NULL,
  base_branch     TEXT NOT NULL,
  path            TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER,
  stash_ref       TEXT,
  pr_number       INTEGER,
  pr_state        TEXT,
  pr_url          TEXT,
  agent_id        TEXT,
  last_active_at  INTEGER
);
CREATE INDEX idx_workspaces_repo_slug ON workspaces(repo_slug);
CREATE INDEX idx_workspaces_status ON workspaces(status);
CREATE INDEX idx_workspaces_branch ON workspaces(repo_slug, branch);

CREATE TABLE workspace_meta (
  workspace_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE detach_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  workspace_id    TEXT NOT NULL,
  pre_root_head   TEXT NOT NULL,
  checkpoint_sha  TEXT,
  started_at      INTEGER NOT NULL,
  lockfile_pid    INTEGER NOT NULL
);
`;

// Per-workspace remote-access opt-out (default share-all = remote == local; the
// owner can hide a workspace from remote in repo settings). Its own table, NOT
// workspace_meta, because it must also hold the synthetic 'local-main' id (which
// has no workspaces row, so the meta FK would reject it). Device-local: never
// synced to a relay client — a remote device must not even learn what's hidden.
const MIGRATION_8_REMOTE_RESTRICTIONS = `
CREATE TABLE remote_restricted_workspaces (
  workspace_id TEXT PRIMARY KEY
);
`;

/** v9 — fast-mode toggle per chat (Opus/GPT-5.x lower-latency inference).
 *  Mirrors the renderer ChatThread.fast added 2026-06-08. */
const MIGRATION_9_CHAT_FAST = `
ALTER TABLE chats ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
`;

/** v10 — extra working directories per chat (Claude `/add-dir` → SDK
 *  `additionalDirectories`). Stored as a JSON-array TEXT (paths can hold any
 *  character; '[]' is the empty default). Mirrors ChatThread.additionalDirectories
 *  added 2026-06-08. */
const MIGRATION_10_CHAT_ADDITIONAL_DIRS = `
ALTER TABLE chats ADD COLUMN additional_directories TEXT NOT NULL DEFAULT '[]';
`;

/** v11 — explicit chat→workspace link (2026-06-09). Until now a chat's owning
 *  workspace was *resolved by path* from `folder` at read time (workspace-
 *  resolution.ts). That stays the source of truth for the agent cwd, but the
 *  resolved id is now ALSO cached here as a durable column so the link survives
 *  a worktree path move/rename, and grouping is an indexed lookup rather than a
 *  path scan. NULLABLE on purpose — a chat
 *  in a plain/empty folder (no worktree, no git) has no workspace and stays NULL.
 *  This is a denormalized CACHE, NOT the security boundary: remote spawns are
 *  still gated independently by a registered workspaceId + allowlist clamp
 *  (index.ts agentSpawnOpts). The engine re-stamps it from `folder` on every
 *  upsert (db/chats.ts), and a one-time backfill fills pre-existing rows. */
const MIGRATION_11_CHAT_WORKSPACE_ID = `
ALTER TABLE chats ADD COLUMN workspace_id TEXT;
CREATE INDEX idx_chats_workspace ON chats(workspace_id);
`;

/** v12 — persist the EXACT permission mode per chat (2026-06-09). `last_mode_id`
 *  is the agent's own mode id the user last selected in-session (Claude:
 *  default/plan/accept-edits/auto/bypass; Codex: ask/auto-edit/full-access/
 *  read-only). Unlike `permission_mode` (a lossy 4-bucket posture that can't
 *  tell bypass from accept-edits or represent "auto"), this round-trips exactly,
 *  so a selected mode — incl. bypass/auto — survives an app restart for every
 *  agent. `pre_plan_mode_id` is the mode to return to when the Plan toggle is
 *  switched off (the mode before plan), so "exit plan → previous mode" works
 *  even across a restart. Both NULLABLE — a chat that never changed mode
 *  in-session falls back to the `permission_mode` posture bucket. */
const MIGRATION_12_CHAT_MODE_IDS = `
ALTER TABLE chats ADD COLUMN last_mode_id TEXT;
ALTER TABLE chats ADD COLUMN pre_plan_mode_id TEXT;
`;

/** v13 — agent "turns" (2026-06-24). A turn = one agent request→response cycle
 *  (one `prompt()` call) that ends with a rendered answer and a set of file
 *  changes. Until now a turn was implicit (the renderer groups messages by
 *  user-message boundaries). This records it as a first-class row so we can: show
 *  a per-turn footer (duration, file pills), filter the Changes tab to a turn, and
 *  "reset to this point". `turn_id` = the opening user message's msg_id (stable,
 *  already unique, already the transcript-truncation key). `pre_snapshot` /
 *  `post_snapshot` are hidden snapshot-commit OIDs (refs/zeros/turns/*) captured
 *  at turn start/end; null when the chat folder isn't a git work tree or the
 *  snapshot was skipped. `files` is the JSON authored-change set (from the turn's
 *  own edit/write/delete tool calls — concurrency-immune attribution, NOT a
 *  whole-tree diff). NULLABLE snapshots/files keep a non-git chat's turns usable
 *  (duration + pills-from-tools still work). */
const MIGRATION_13_TURNS = `
CREATE TABLE turns (
  chat_id       TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  workspace_id  TEXT,
  folder        TEXT,
  agent_id      TEXT,
  ord           INTEGER NOT NULL,
  summary       TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  stop_reason   TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  pre_snapshot  TEXT,
  post_snapshot TEXT,
  files         TEXT,
  rev           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, turn_id)
);
CREATE INDEX idx_turns_workspace ON turns(workspace_id, ord);
CREATE INDEX idx_turns_chat_ord ON turns(chat_id, ord);
`;

/** v14 — reset undo capture (2026-06-24). "Reset to this point" truncates the
 *  transcript (chat_messages + turns rows) and reverts files. To make the undo
 *  FULL-fidelity (not files-only), we stash the about-to-be-deleted rows here,
 *  keyed by a generated `reset_id`, just before deleting them. Undo restores the
 *  files from `snapshot` AND re-inserts `messages`/`turns` verbatim (guarded by
 *  `cut_ord`: only when the chat wasn't continued past the reset, so the exact
 *  ords are still free). Engine-local — NOT in the delta-sync set; pruned to the
 *  last few per chat. `messages`/`turns` are JSON arrays of the raw rows. */
const MIGRATION_14_RESET_UNDO = `
CREATE TABLE reset_undo (
  reset_id    TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL,
  folder      TEXT,
  snapshot    TEXT,
  reset_paths TEXT,
  cut_ord     INTEGER,
  messages    TEXT NOT NULL,
  turns       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_reset_undo_chat ON reset_undo(chat_id, created_at);
`;

// Setup script now runs in the background (a PTY) after a worktree is created,
// instead of synchronously inside workspace.create (which blew the RPC timeout
// on `pnpm install`-class setups). `setup_state` persists the last run's outcome
// so the Setup tab shows the right state across reloads. NULL = no setup run.
const MIGRATION_15_WORKSPACE_SETUP = `
ALTER TABLE workspaces ADD COLUMN setup_state TEXT;
`;

/** v16 — recovery anchor for archive→restore (2026-06-26). Archiving keeps the
 *  branch ref + a `zeros-archive:<id>` stash, but if the branch is later DELETED
 *  out-of-band there was no anchor to recreate the worktree from. `archived_head`
 *  records the branch tip commit (SHA) captured at archive time, so the
 *  "always-succeeds" restore can recreate a missing branch from the exact commit
 *  (stronger than the stash's first parent, which only exists when work was
 *  stashed). NULL for never-archived rows and pre-v16 archives (restore then
 *  falls back to the stash parent / origin / base branch). */
const MIGRATION_16_WORKSPACE_ARCHIVED_HEAD = `
ALTER TABLE workspaces ADD COLUMN archived_head TEXT;
`;

/** v17 — durable archive snapshot (2026-06-30). Archive now captures the whole
 *  working tree (tracked + untracked-not-ignored) into a per-workspace git ref
 *  `refs/zeros/archive/<id>` via the existing per-turn snapshot plumbing
 *  (snapshotWorkingTree), instead of `git stash`. `archive_snapshot` records that
 *  snapshot's commit OID so restore can overlay the uncommitted/untracked work
 *  back onto a freshly-recreated worktree — robust even when the worktree gitdir
 *  was orphaned (stash needs a live gitdir; the ref does not). NULL for
 *  never-archived rows and pre-v17 (stash-based) archives, which restore via the
 *  legacy `stash_ref` path. */
const MIGRATION_17_WORKSPACE_ARCHIVE_SNAPSHOT = `
ALTER TABLE workspaces ADD COLUMN archive_snapshot TEXT;
`;

/** v18 — kanban lifecycle status (2026-07-02). The `status` column is repurposed
 *  from the old {draft,active,in-review,merged,archived} machine to the five
 *  user-facing lifecycle states {backlog,in-progress,in-review,done,cancelled}.
 *  "archived" is no longer a status value — archived rows are now identified by
 *  `archived_at IS NOT NULL` (already maintained), so status survives archive/
 *  restore. Remap existing rows:
 *    draft/active → in-progress ·  merged → done ·  in-review stays.
 *  Legacy archived rows lost their pre-archive status (archive used to overwrite
 *  it), so infer a best-effort status from `pr_state` and keep `archived_at`. */
const MIGRATION_18_WORKSPACE_LIFECYCLE_STATUS = `
UPDATE workspaces SET status = 'in-progress' WHERE status IN ('draft', 'active');
UPDATE workspaces SET status = 'done' WHERE status = 'merged';
UPDATE workspaces
   SET status = CASE
     WHEN pr_state = 'merged' THEN 'done'
     WHEN pr_state IN ('ready', 'draft') THEN 'in-review'
     ELSE 'in-progress'
   END
 WHERE status = 'archived';
`;

/** v19 — undo merge base (2026-07-13). `post_snapshot` records the whole-tree
 *  state right AFTER a reset applied (a second `refs/zeros/resets/*` snapshot,
 *  taken alongside the existing pre-reset one). Undo uses it as the 3-way merge
 *  base so edits made BETWEEN the reset and the undo are merged around — an
 *  overlap conflicts and is left as-is — instead of being blindly overwritten
 *  (the reset path already had this never-clobber rule; this extends it to
 *  undo). NULL for pre-v19 records and snapshot-less resets → undo falls back
 *  to the legacy blind restore. */
const MIGRATION_19_RESET_UNDO_POST_SNAPSHOT = `
ALTER TABLE reset_undo ADD COLUMN post_snapshot TEXT;
`;

// Per-turn usage (tokens/cost, including the per-model breakdown) is stored as a
// JSON blob on the turn row. Feeds the turn footer's usage popover; null for
// turns whose agent reports no usage (Cursor) and for all pre-migration rows.
const MIGRATION_20_TURN_USAGE = `
ALTER TABLE turns ADD COLUMN usage TEXT;
`;

/** v21 — durable workspace lifecycle journal (2026-07-23).
 *
 * Create/archive/restore/delete all span SQLite, the Git worktree registry, ordinary
 * filesystem directories, and durable Git refs.  None of those systems can
 * participate in one transaction.  Previously archive removed the directory
 * first and only then set `archived_at`; an engine crash in that gap left a
 * live DB row pointing at a missing folder.  The startup snapshot janitor then
 * mistook the recovery ref for an orphan and deleted it.
 *
 * One row records the operation intent before the first destructive step.  The
 * operation is advanced idempotently and removed in the same SQLite transaction
 * that commits the final workspace state.  Startup recovery rolls every
 * remaining row forward before archive-ref retention runs.
 */
const MIGRATION_21_WORKSPACE_LIFECYCLE_JOURNAL = `
CREATE TABLE workspace_lifecycle_journal (
  workspace_id     TEXT PRIMARY KEY,
  operation        TEXT NOT NULL
                   CHECK (operation IN ('create', 'archive', 'restore', 'delete')),
  phase            TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  target_path      TEXT,
  source_branch    TEXT NOT NULL,
  target_branch    TEXT,
  create_from      TEXT,
  archive_snapshot TEXT,
  archived_head    TEXT,
  adaptations_json TEXT NOT NULL DEFAULT '[]',
  payload_json     TEXT NOT NULL DEFAULT '{}',
  include_branch   INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX idx_workspace_lifecycle_operation
  ON workspace_lifecycle_journal(operation);
`;

/** v22 — repair pre-release v21 lifecycle journals that were created before
 * `payload_json` was added to the create-operation payload.
 *
 * Some long-running dev instances already recorded the earlier v21 draft in
 * schema_migrations. Editing v21 cannot repair those databases because the
 * migration runner correctly never replays an applied version. The runner
 * conditionally executes this ALTER only when the column is absent: fresh
 * databases already receive it from the final v21 schema, while draft-v21
 * databases receive it here without losing their journal rows.
 */
const MIGRATION_22_LIFECYCLE_JOURNAL_PAYLOAD = `
ALTER TABLE workspace_lifecycle_journal
  ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';
`;

/** v23 — canonicalize the pre-release v21 operation constraint.
 *
 * The same draft v21 that omitted payload_json constrained `operation` to
 * archive/restore/delete. Adding the column in v22 lets create reach the
 * journal, but SQLite then rejects `operation = 'create'`. SQLite cannot ALTER
 * a CHECK constraint, so rebuild the table transactionally and copy every
 * in-flight intent into the final schema. This is intentionally unconditional:
 * final-v21 databases are rebuilt to an equivalent shape, while draft-v21
 * databases gain the missing create operation without deleting user state.
 */
const MIGRATION_23_LIFECYCLE_JOURNAL_CREATE_OPERATION = `
ALTER TABLE workspace_lifecycle_journal
  RENAME TO workspace_lifecycle_journal_v22;
DROP INDEX IF EXISTS idx_workspace_lifecycle_operation;

CREATE TABLE workspace_lifecycle_journal (
  workspace_id     TEXT PRIMARY KEY,
  operation        TEXT NOT NULL
                   CHECK (operation IN ('create', 'archive', 'restore', 'delete')),
  phase            TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  target_path      TEXT,
  source_branch    TEXT NOT NULL,
  target_branch    TEXT,
  create_from      TEXT,
  archive_snapshot TEXT,
  archived_head    TEXT,
  adaptations_json TEXT NOT NULL DEFAULT '[]',
  payload_json     TEXT NOT NULL DEFAULT '{}',
  include_branch   INTEGER NOT NULL DEFAULT 0,
  started_at       INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO workspace_lifecycle_journal (
  workspace_id,
  operation,
  phase,
  source_path,
  target_path,
  source_branch,
  target_branch,
  create_from,
  archive_snapshot,
  archived_head,
  adaptations_json,
  payload_json,
  include_branch,
  started_at
)
SELECT
  workspace_id,
  operation,
  phase,
  source_path,
  target_path,
  source_branch,
  target_branch,
  create_from,
  archive_snapshot,
  archived_head,
  adaptations_json,
  payload_json,
  include_branch,
  started_at
FROM workspace_lifecycle_journal_v22;

DROP TABLE workspace_lifecycle_journal_v22;
CREATE INDEX idx_workspace_lifecycle_operation
  ON workspace_lifecycle_journal(operation);
`;

/** 2026-07-29: workspace names became allocated colours (`zeros/Cream`) with
 *  no random tail. The old `zeros/<flower>-<4 hex>` scheme was self-uniquifying
 *  — two concurrent creates collided at ~1-in-16M — so a plain index sufficed.
 *  A deterministic allocator has no such luck: two creates that read the same
 *  free-name snapshot pick the SAME name, and the check-then-insert in
 *  prepareWorkspaceCreate is a TOCTOU window. This index is what actually
 *  enforces uniqueness; callers retry on violation.
 *
 *  Keyed on lower(branch), not branch: macOS filesystems are case-insensitive
 *  and git stores loose refs as files, so `zeros/Cream` and `zeros/cream`
 *  are ONE ref on the machines this ships to. Treating them as distinct in
 *  the DB would let a row exist that git cannot represent.
 *
 *  The UPDATE ahead of it is defensive. Duplicates cannot exist under the old
 *  random-hex scheme, but CREATE UNIQUE INDEX aborts the whole migration if
 *  one somehow does. Rather than fail to launch — or silently delete a
 *  workspace — a duplicate is renamed to a visibly-broken `-dup-<id>` so the
 *  user still has the row and can see what happened.
 *
 *  The suffix is the WHOLE id, deliberately: it is the table's primary key, so
 *  it is the only per-row value guaranteed to make every rename distinct. An
 *  id TAIL does not — ids are `ws_<6hex>-<prompt slug>` (generateWorkspaceId),
 *  so their last characters come from the prompt, and two workspaces created
 *  from similar prompts share them. Three rows on one branch with two matching
 *  tails would both rename to the same value and abort the migration this
 *  UPDATE exists to keep running. Ugly beats unlaunchable. */
const MIGRATION_24_WORKSPACE_BRANCH_UNIQUE = `
UPDATE workspaces
SET branch = branch || '-dup-' || id
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY repo_slug, lower(branch) ORDER BY created_at, id
    ) AS rn
    FROM workspaces
  ) WHERE rn > 1
);

CREATE UNIQUE INDEX idx_workspaces_branch_unique
  ON workspaces(repo_slug, lower(branch));
`;

/** 2026-07-30: `summariesForFolder` grew a `COUNT(*)` of a chat's USER text
 *  messages (the number on a transcript pill). Unlike its two neighbours in
 *  that query it cannot short-circuit — the `summary` subquery is
 *  `ORDER BY ord LIMIT 1` and the `EXISTS` gate stops at the first row, but a
 *  count has to visit every message of every chat in the folder and run
 *  `json_extract` on each one. Measured on the real schema (12 chats × 3,000
 *  messages): 0.03 ms before, 6.19 ms after, 0.07 ms with this index.
 *
 *  It matters because that query stopped being a picker read: the transcript
 *  row re-pulls on every `messages`/`chats` DB_CHANGED, debounced to 400 ms,
 *  so an empty chat tab open while a background agent streams runs it ~2.5×/s
 *  on the engine's single connection — and the cost grows with the whole
 *  message table, i.e. worst on the oldest installs.
 *
 *  PARTIAL, and that is the whole reason this is affordable. The predicate
 *  matches ~3% of rows (a chat is mostly agent text, reasoning and tool
 *  calls), so the index stays small and the write cost on the persist-on-emit
 *  path is one `json_extract` per insert — measured in the noise against the
 *  JSON serialization already happening there (~1 µs/row on 20k single-row
 *  inserts).
 *
 *  The WHERE clause must stay BYTE-COMPATIBLE with the query's own predicate:
 *  SQLite only uses a partial index when it can syntactically prove the
 *  query implies the index's WHERE, so reordering these two terms or
 *  rewriting `json_extract(payload, '$.role')` silently drops back to the
 *  full scan with no error. `chats.ts` carries the matching note. */
const MIGRATION_25_CHAT_MESSAGES_USER_TEXT = `
CREATE INDEX idx_chat_messages_user_text
  ON chat_messages(chat_id)
  WHERE kind = 'text' AND json_extract(payload, '$.role') = 'user';
`;

/** v26 — immutable chat backend mode. Chat `kind` already distinguishes the
 * ordinary transcript surface from a terminal tab; `mode` instead records
 * whether the same chat UI is backed by a code or design workspace. */
const MIGRATION_26_CHAT_MODE = `
ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'
  CHECK (mode IN ('code', 'design'));
`;
// Historical/inert: the design workspace no longer uses the shared chat
// backend, and current chat persistence intentionally ignores this column.
// Keep v26 forever because existing databases may already have applied it;
// removing or renumbering an applied migration would break the forward ladder.

/** v27 — workspace product kind. Existing rows are code workspaces. A design
 * workspace shares the lifecycle table and Git semantics, but is provisioned
 * under its own visible root with a sparse `Zeros Design/` checkout. */
const MIGRATION_27_WORKSPACE_KIND = `
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'
  CHECK (kind IN ('code', 'design'));
CREATE INDEX idx_workspaces_kind ON workspaces(kind, archived_at);
`;

/** v28 — provider-neutral durable binding. This replaces the draft Codex-only
 * `native_session_id`: the JSON value is a versioned ProviderBinding and is
 * equally usable by Codex, Claude, Cursor, and future adapters. The existing
 * `session_id` column remains as a read/downgrade compatibility locator; it is
 * no longer the canonical live execution identity. */
const MIGRATION_28_CHAT_PROVIDER_BINDING = `
ALTER TABLE chats ADD COLUMN provider_binding TEXT;
`;

/** v29 — descriptive provider metadata, separate from identity. This
 * generalizes the draft `native_git_info` column and backfills pre-model chat
 * locators. Cursor historically persisted its native SDK agent id; other
 * adapters persisted a Zeros runtime/session-directory locator and therefore
 * remain explicitly legacy until the adapter resolves the native handle. */
const MIGRATION_29_CHAT_PROVIDER_METADATA = `
ALTER TABLE chats ADD COLUMN provider_metadata TEXT;

UPDATE chats
   SET provider_binding = CASE
     WHEN agent_id = 'cursor' THEN json_object(
       'version', 1,
       'providerId', agent_id,
       'kind', 'native',
       'resumeId', session_id
     )
     ELSE json_object(
       'version', 1,
       'providerId', agent_id,
       'kind', 'legacy',
       'resumeId', session_id,
       'legacySessionId', session_id
     )
   END
 WHERE provider_binding IS NULL
   AND agent_id IS NOT NULL
   AND session_id IS NOT NULL
   AND length(trim(session_id)) > 0;
`;

/** v30 — compatibility marker for dev databases that already applied the old
 * draft v28/v29 under their original Codex-only column names. The actual repair
 * is conditional JavaScript in repairDraftChatIdentityColumns because SQLite
 * has no portable ADD COLUMN IF NOT EXISTS. */
const MIGRATION_30_CHAT_IDENTITY_COMPATIBILITY = `
SELECT 1;
`;

/** v31 — semantic owner and execution placement. Existing rows predate
 * organization selection and are therefore interpreted as Personal; NULL is
 * retained as that compatibility marker. All existing worktrees are local.
 * A cloud row must name an organization, while Personal's local-only rule is
 * enforced by the control-plane capability and desktop create gate. */
const MIGRATION_31_WORKSPACE_OWNER = `
ALTER TABLE workspaces ADD COLUMN organization_id TEXT;
ALTER TABLE workspaces ADD COLUMN placement TEXT NOT NULL DEFAULT 'local'
  CHECK (placement IN ('local', 'cloud'))
  CHECK (placement = 'local' OR organization_id IS NOT NULL);
CREATE INDEX idx_workspaces_organization
  ON workspaces(organization_id, placement, archived_at);
`;

/** v32 — split presentation state from actor authority. `view_mode` is the
 * canonical presentation value; `kind` remains a mirrored DB/wire
 * compatibility field for older clients. Neither field grants an agent any
 * filesystem or tool capability. Runtime writes update both fields atomically;
 * triggers cover older binaries and direct SQLite recovery tools. A legacy
 * insert/update that supplies only `kind` is projected into `view_mode`; an
 * explicit standalone `view_mode` repair is projected back into `kind`. */
const MIGRATION_32_WORKSPACE_VIEW_MODE = `
ALTER TABLE workspaces ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'code'
  CHECK (view_mode IN ('code', 'design'));
UPDATE workspaces SET view_mode = kind;

CREATE TRIGGER workspaces_kind_to_view_mode_insert
AFTER INSERT ON workspaces
WHEN NEW.view_mode <> NEW.kind
BEGIN
  UPDATE workspaces SET view_mode = NEW.kind WHERE id = NEW.id;
END;
CREATE TRIGGER workspaces_kind_to_view_mode_update
AFTER UPDATE OF kind ON workspaces
WHEN NEW.view_mode = OLD.view_mode AND NEW.view_mode <> NEW.kind
BEGIN
  UPDATE workspaces SET view_mode = NEW.kind WHERE id = NEW.id;
END;
CREATE TRIGGER workspaces_view_mode_to_kind_update
AFTER UPDATE OF view_mode ON workspaces
WHEN NEW.kind = OLD.kind AND NEW.kind <> NEW.view_mode
BEGIN
  UPDATE workspaces SET kind = NEW.view_mode WHERE id = NEW.id;
END;
`;

/** v33 — append-only repair for internal foundation checkpoints that recorded
 * retired workspace-command/artifact drafts as v28-v30 before the provider
 * identity ladder landed on main. Those databases can already report v32 while
 * lacking provider_binding/provider_metadata. The conditional JavaScript
 * repair adds only the two final columns and backfills the existing durable
 * session locator; a normal released database makes this migration a no-op. */
const MIGRATION_33_CHAT_IDENTITY_SCHEMA_REPAIR = `
SELECT 1;
`;

/** v34 — durable cursors for the boot janitors. A repair that walks an
 *  IMMUTABLE history (today: turn file attribution, turn-recovery.ts) has no
 *  way to record that it already looked at a row: the rows it decides to leave
 *  alone are exactly the rows it cannot write to. Without somewhere to keep
 *  "how far I got", every launch re-reads the same backlog forever — and that
 *  backlog only grows, because a turn that runs concurrently with another agent
 *  legitimately lands in it. One tiny engine-local key/value table fixes that
 *  for this janitor and any later one. Deliberately NOT rev-stamped and NOT in
 *  the delta-sync set: a cursor describes one machine's progress through its
 *  own copy of the history, never shared state. */
const MIGRATION_34_JANITOR_STATE = `
CREATE TABLE janitor_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** v35 — device-private receive-only cloud replica projection. Absolute paths,
 * local divergence, and apply journals belong to this Mac and deliberately do
 * not participate in the engine's cross-device delta-sync tables. Credentials
 * and Ed25519 private keys remain in the OS secret store, never SQLite. */
const MIGRATION_35_CLOUD_REPLICA_LOCAL_STATE = `
CREATE TABLE cloud_device_registrations (
  account_user_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL UNIQUE,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  public_key TEXT NOT NULL CHECK (length(public_key) = 43),
  key_fingerprint TEXT NOT NULL CHECK (length(key_fingerprint) = 64),
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE cloud_replica_local_state (
  replica_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  desired_state TEXT NOT NULL CHECK (
    desired_state IN ('active', 'paused', 'removed')
  ),
  observed_state TEXT NOT NULL CHECK (
    observed_state IN (
      'bootstrapping', 'pending', 'syncing', 'in_sync', 'diverged', 'paused',
      'detached', 'failed', 'removed'
    )
  ),
  checkpoint_id TEXT,
  manifest_revision INTEGER CHECK (
    manifest_revision IS NULL OR manifest_revision >= 0
  ),
  event_cursor INTEGER NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
  workspace_authority_epoch INTEGER NOT NULL CHECK (
    workspace_authority_epoch > 0
  ),
  grant_epoch INTEGER NOT NULL CHECK (grant_epoch > 0),
  ignore_policy_json TEXT NOT NULL CHECK (json_valid(ignore_policy_json)),
  ignore_policy_sha256 TEXT NOT NULL CHECK (length(ignore_policy_sha256) = 64),
  client_manifest_sha256 TEXT CHECK (
    client_manifest_sha256 IS NULL OR length(client_manifest_sha256) = 64
  ),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER,
  FOREIGN KEY (account_user_id)
    REFERENCES cloud_device_registrations(account_user_id) ON DELETE RESTRICT,
  CHECK (
    (desired_state = 'removed' AND removed_at IS NOT NULL)
    OR (desired_state <> 'removed' AND removed_at IS NULL)
  )
);
CREATE INDEX idx_cloud_replica_workspace
  ON cloud_replica_local_state(workspace_id, updated_at DESC);

CREATE TABLE cloud_replica_entries (
  replica_id TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  portable_path_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('file', 'symlink')),
  mode INTEGER NOT NULL CHECK (mode IN (33188, 33261, 40960)),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (replica_id, normalized_path),
  UNIQUE (replica_id, portable_path_key),
  FOREIGN KEY (replica_id) REFERENCES cloud_replica_local_state(replica_id)
    ON DELETE CASCADE
);

CREATE TABLE cloud_replica_apply_journal (
  replica_id TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
  to_revision INTEGER NOT NULL CHECK (to_revision >= from_revision),
  stage_path TEXT,
  expected_previous_sha256 TEXT,
  next_content_sha256 TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('staged', 'committing', 'applied', 'failed')
  ),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (replica_id, normalized_path),
  FOREIGN KEY (replica_id) REFERENCES cloud_replica_local_state(replica_id)
    ON DELETE CASCADE
);

CREATE TABLE cloud_replica_divergences (
  replica_id TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  expected_sha256 TEXT,
  observed_sha256 TEXT,
  cloud_sha256 TEXT,
  resolution TEXT CHECK (
    resolution IS NULL OR
    resolution IN ('replace_from_cloud', 'saved_as_copy', 'removed_local')
  ),
  resolved_at INTEGER,
  PRIMARY KEY (replica_id, normalized_path, detected_at),
  FOREIGN KEY (replica_id) REFERENCES cloud_replica_local_state(replica_id)
    ON DELETE CASCADE,
  CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);
CREATE INDEX idx_cloud_replica_divergences_open
  ON cloud_replica_divergences(replica_id, detected_at)
  WHERE resolution IS NULL;
`;

/** v36 — engine-private durable-record convergence marker. The cloud server
 * stores transcript data; this row only proves which exact local SQLite head
 * was last compared with which remote revision. It is never renderer state and
 * never leaves the engine except as the resulting durable record mutations. */
const MIGRATION_36_CLOUD_RECORD_SYNC_STATE = `
CREATE TABLE cloud_record_sync_state (
  workspace_id TEXT PRIMARY KEY,
  remote_revision INTEGER NOT NULL CHECK (remote_revision >= 0),
  local_head_revision INTEGER NOT NULL CHECK (local_head_revision >= 0),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  updated_at INTEGER NOT NULL
);
`;

/** v37 — immutable global identities for repositories and workspaces. The
 * existing path-derived `repos.id` and human-readable `workspaces.id` values
 * are serialized compatibility aliases and deliberately remain primary keys.
 * Cloud fork/import protocols use these UUIDs so a copy never reuses or
 * transfers the source workspace identity.
 *
 * SQLite cannot add a non-constant UUID default with ALTER TABLE. Existing
 * rows are backfilled in-place, while AFTER INSERT triggers cover legacy/direct
 * writers that do not yet supply the new column. Explicit writers are still
 * expected to provide a UUID; the validation and immutability triggers make the
 * database the final authority either way. */
const MIGRATION_37_GLOBAL_REPOSITORY_WORKSPACE_IDS = `
ALTER TABLE repos ADD COLUMN canonical_id TEXT;
ALTER TABLE workspaces ADD COLUMN canonical_id TEXT;

UPDATE repos
SET canonical_id = lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
)
WHERE canonical_id IS NULL;

UPDATE workspaces
SET canonical_id = lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-' ||
  substr('89ab', (random() & 3) + 1, 1) ||
  substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
)
WHERE canonical_id IS NULL;

CREATE UNIQUE INDEX repos_canonical_id_unique ON repos(canonical_id);
CREATE UNIQUE INDEX workspaces_canonical_id_unique ON workspaces(canonical_id);

CREATE TRIGGER repos_canonical_id_validate_insert
BEFORE INSERT ON repos
WHEN NEW.canonical_id IS NOT NULL AND (
  length(NEW.canonical_id) <> 36 OR
  NEW.canonical_id <> lower(NEW.canonical_id) OR
  substr(NEW.canonical_id, 9, 1) <> '-' OR
  substr(NEW.canonical_id, 14, 1) <> '-' OR
  substr(NEW.canonical_id, 19, 1) <> '-' OR
  substr(NEW.canonical_id, 24, 1) <> '-' OR
  replace(NEW.canonical_id, '-', '') GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'repos.canonical_id must be a lowercase UUID');
END;

CREATE TRIGGER repos_canonical_id_validate_update
BEFORE UPDATE OF canonical_id ON repos
WHEN NEW.canonical_id IS NULL OR
  length(NEW.canonical_id) <> 36 OR
  NEW.canonical_id <> lower(NEW.canonical_id) OR
  substr(NEW.canonical_id, 9, 1) <> '-' OR
  substr(NEW.canonical_id, 14, 1) <> '-' OR
  substr(NEW.canonical_id, 19, 1) <> '-' OR
  substr(NEW.canonical_id, 24, 1) <> '-' OR
  replace(NEW.canonical_id, '-', '') GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'repos.canonical_id must be a lowercase UUID');
END;

CREATE TRIGGER repos_canonical_id_fill_insert
AFTER INSERT ON repos
WHEN NEW.canonical_id IS NULL
BEGIN
  UPDATE repos
  SET canonical_id = lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER repos_canonical_id_immutable
BEFORE UPDATE OF canonical_id ON repos
WHEN OLD.canonical_id IS NOT NULL AND NEW.canonical_id IS NOT OLD.canonical_id
BEGIN
  SELECT RAISE(ABORT, 'repos.canonical_id is immutable');
END;

CREATE TRIGGER workspaces_canonical_id_validate_insert
BEFORE INSERT ON workspaces
WHEN NEW.canonical_id IS NOT NULL AND (
  length(NEW.canonical_id) <> 36 OR
  NEW.canonical_id <> lower(NEW.canonical_id) OR
  substr(NEW.canonical_id, 9, 1) <> '-' OR
  substr(NEW.canonical_id, 14, 1) <> '-' OR
  substr(NEW.canonical_id, 19, 1) <> '-' OR
  substr(NEW.canonical_id, 24, 1) <> '-' OR
  replace(NEW.canonical_id, '-', '') GLOB '*[^0-9a-f]*'
)
BEGIN
  SELECT RAISE(ABORT, 'workspaces.canonical_id must be a lowercase UUID');
END;

CREATE TRIGGER workspaces_canonical_id_validate_update
BEFORE UPDATE OF canonical_id ON workspaces
WHEN NEW.canonical_id IS NULL OR
  length(NEW.canonical_id) <> 36 OR
  NEW.canonical_id <> lower(NEW.canonical_id) OR
  substr(NEW.canonical_id, 9, 1) <> '-' OR
  substr(NEW.canonical_id, 14, 1) <> '-' OR
  substr(NEW.canonical_id, 19, 1) <> '-' OR
  substr(NEW.canonical_id, 24, 1) <> '-' OR
  replace(NEW.canonical_id, '-', '') GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'workspaces.canonical_id must be a lowercase UUID');
END;

CREATE TRIGGER workspaces_canonical_id_fill_insert
AFTER INSERT ON workspaces
WHEN NEW.canonical_id IS NULL
BEGIN
  UPDATE workspaces
  SET canonical_id = lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2, 3) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) ||
    substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER workspaces_canonical_id_immutable
BEFORE UPDATE OF canonical_id ON workspaces
WHEN OLD.canonical_id IS NOT NULL AND NEW.canonical_id IS NOT OLD.canonical_id
BEGIN
  SELECT RAISE(ABORT, 'workspaces.canonical_id is immutable');
END;
`;

/** v38 — device-private, restart-safe local↔cloud copy jobs. The control plane
 * owns cloud fork intents; this journal owns only the Mac-side snapshot,
 * download, and local materialization progress. WorkOS access tokens, export
 * grants, device private keys, and provider credentials are never persisted.
 */
const MIGRATION_38_CLOUD_WORKSPACE_FORK_JOBS = `
CREATE TABLE cloud_workspace_fork_jobs (
  job_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (
    operation IN ('local_to_cloud', 'cloud_to_local')
  ),
  account_user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  target_workspace_id TEXT NOT NULL,
  source_workspace_alias TEXT,
  target_workspace_alias TEXT,
  repo_root TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'snapshotting', 'creating_remote', 'uploading', 'finalizing',
    'requesting_export', 'waiting_export', 'downloading', 'materializing',
    'succeeded', 'failed', 'cancelled'
  )),
  remote_fork_intent_id TEXT,
  remote_lifecycle_intent_id TEXT,
  checkpoint_request_id TEXT,
  checkpoint_id TEXT,
  source_snapshot_sha256 TEXT CHECK (
    source_snapshot_sha256 IS NULL OR length(source_snapshot_sha256) = 64
  ),
  source_revision INTEGER CHECK (
    source_revision IS NULL OR source_revision >= 0
  ),
  manifest_json TEXT CHECK (
    manifest_json IS NULL OR json_valid(manifest_json)
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (operation, organization_id, source_workspace_id, target_workspace_id),
  CHECK (source_workspace_id <> target_workspace_id),
  CHECK ((state IN ('succeeded', 'cancelled')) = (completed_at IS NOT NULL))
);
CREATE INDEX idx_cloud_workspace_fork_jobs_resume
  ON cloud_workspace_fork_jobs(state, next_attempt_at, updated_at)
  WHERE state NOT IN ('succeeded', 'cancelled');

CREATE TABLE cloud_workspace_fork_job_entries (
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  normalized_path TEXT NOT NULL,
  portable_path_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  entry_type TEXT CHECK (entry_type IS NULL OR entry_type IN ('file', 'symlink')),
  mode INTEGER CHECK (mode IS NULL OR mode IN (33188, 33261, 40960)),
  content_sha256 TEXT CHECK (
    content_sha256 IS NULL OR length(content_sha256) = 64
  ),
  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
  stage_name TEXT,
  remote_blob_id TEXT,
  PRIMARY KEY (job_id, ordinal),
  UNIQUE (job_id, normalized_path),
  UNIQUE (job_id, portable_path_key),
  FOREIGN KEY (job_id) REFERENCES cloud_workspace_fork_jobs(job_id)
    ON DELETE CASCADE,
  CHECK (
    (operation = 'delete' AND entry_type IS NULL AND mode IS NULL
      AND content_sha256 IS NULL AND size_bytes IS NULL
      AND stage_name IS NULL AND remote_blob_id IS NULL)
    OR
    (operation = 'upsert' AND entry_type IS NOT NULL AND mode IS NOT NULL
      AND content_sha256 IS NOT NULL AND size_bytes IS NOT NULL
      AND stage_name IS NOT NULL)
  )
);

CREATE TABLE cloud_workspace_fork_job_records (
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (job_id, ordinal),
  FOREIGN KEY (job_id) REFERENCES cloud_workspace_fork_jobs(job_id)
    ON DELETE CASCADE
);
`;

/** The ordered migration list. Append only — NEVER edit or reorder a shipped
 *  entry; add a new one. */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: "initial unified schema", up: INITIAL_SCHEMA },
  {
    version: 2,
    name: "repos: repo_slug + added_at + unique root",
    up: MIGRATION_2_PROJECTS,
  },
  {
    version: 3,
    name: "chats (sidebar list) — electron/db.ts parity",
    up: MIGRATION_3_CHATS,
  },
  {
    version: 4,
    name: "chat_messages (transcripts) — engine-persists-on-emit",
    up: MIGRATION_4_MESSAGES,
  },
  {
    version: 5,
    name: "chat_messages FTS5 search (content + triggers)",
    up: MIGRATION_5_FTS,
  },
  {
    version: 6,
    name: "sync_meta (global rev) + sync_tombstones (delta pull)",
    up: MIGRATION_6_SYNC,
  },
  {
    version: 7,
    name: "fold state.db (workspaces + meta + detach) into zeros.db",
    up: MIGRATION_7_WORKSPACES,
  },
  {
    version: 8,
    name: "remote_restricted_workspaces (per-workspace remote opt-out)",
    up: MIGRATION_8_REMOTE_RESTRICTIONS,
  },
  {
    version: 9,
    name: "chats.fast (fast-mode toggle per chat)",
    up: MIGRATION_9_CHAT_FAST,
  },
  {
    version: 10,
    name: "chats.additional_directories (Claude /add-dir extra dirs)",
    up: MIGRATION_10_CHAT_ADDITIONAL_DIRS,
  },
  {
    version: 11,
    name: "chats.workspace_id (durable chat→workspace link, cached from folder)",
    up: MIGRATION_11_CHAT_WORKSPACE_ID,
  },
  {
    version: 12,
    name: "chats.last_mode_id + pre_plan_mode_id (exact permission mode per chat)",
    up: MIGRATION_12_CHAT_MODE_IDS,
  },
  {
    version: 13,
    name: "turns (agent request→response cycles) — footer, per-turn changes, reset",
    up: MIGRATION_13_TURNS,
  },
  {
    version: 14,
    name: "reset_undo (full-fidelity undo: stashed transcript + turns + snapshot)",
    up: MIGRATION_14_RESET_UNDO,
  },
  {
    version: 15,
    name: "workspaces.setup_state (background setup script status)",
    up: MIGRATION_15_WORKSPACE_SETUP,
  },
  {
    version: 16,
    name: "workspaces.archived_head (restore recovery anchor — branch tip at archive)",
    up: MIGRATION_16_WORKSPACE_ARCHIVED_HEAD,
  },
  {
    version: 17,
    name: "workspaces.archive_snapshot (durable per-workspace archive checkpoint OID)",
    up: MIGRATION_17_WORKSPACE_ARCHIVE_SNAPSHOT,
  },
  {
    version: 18,
    name: "workspaces.status → kanban lifecycle (backlog/in-progress/in-review/done/cancelled); archive via archived_at",
    up: MIGRATION_18_WORKSPACE_LIFECYCLE_STATUS,
  },
  {
    version: 19,
    name: "reset_undo.post_snapshot (undo merge base — never-clobber undo)",
    up: MIGRATION_19_RESET_UNDO_POST_SNAPSHOT,
  },
  {
    version: 20,
    name: "turns.usage (per-turn tokens/cost JSON incl. per-model breakdown)",
    up: MIGRATION_20_TURN_USAGE,
  },
  {
    version: 21,
    name: "workspace lifecycle journal (restart-safe create/archive/restore/delete)",
    up: MIGRATION_21_WORKSPACE_LIFECYCLE_JOURNAL,
  },
  {
    version: 22,
    name: "workspace lifecycle journal: repair missing payload_json",
    up: MIGRATION_22_LIFECYCLE_JOURNAL_PAYLOAD,
  },
  {
    version: 23,
    name: "workspace lifecycle journal: allow create operation",
    up: MIGRATION_23_LIFECYCLE_JOURNAL_CREATE_OPERATION,
  },
  {
    version: 24,
    name: "workspaces: unique (repo_slug, lower(branch))",
    up: MIGRATION_24_WORKSPACE_BRANCH_UNIQUE,
  },
  {
    version: 25,
    name: "chat_messages: partial index for the user-prompt count",
    up: MIGRATION_25_CHAT_MESSAGES_USER_TEXT,
  },
  {
    version: 26,
    name: "chats.mode (code or design backend, shared chat UI)",
    up: MIGRATION_26_CHAT_MODE,
  },
  {
    version: 27,
    name: "workspaces.kind (code or design workspace)",
    up: MIGRATION_27_WORKSPACE_KIND,
  },
  {
    version: 28,
    name: "chats.provider_binding (provider-neutral durable resume identity)",
    up: MIGRATION_28_CHAT_PROVIDER_BINDING,
  },
  {
    version: 29,
    name: "chats.provider_metadata (provider-neutral descriptive metadata)",
    up: MIGRATION_29_CHAT_PROVIDER_METADATA,
  },
  {
    version: 30,
    name: "chat identity compatibility repair for draft v28/v29",
    up: MIGRATION_30_CHAT_IDENTITY_COMPATIBILITY,
  },
  {
    version: 31,
    name: "workspaces: organization owner + local/cloud placement",
    up: MIGRATION_31_WORKSPACE_OWNER,
  },
  {
    version: 32,
    name: "workspace view mode compatibility projection",
    up: MIGRATION_32_WORKSPACE_VIEW_MODE,
  },
  {
    version: 33,
    name: "chat identity schema invariant repair",
    up: MIGRATION_33_CHAT_IDENTITY_SCHEMA_REPAIR,
  },
  {
    version: 34,
    name: "boot janitor cursors",
    up: MIGRATION_34_JANITOR_STATE,
  },
  {
    version: 35,
    name: "device-private receive-only cloud replica state",
    up: MIGRATION_35_CLOUD_REPLICA_LOCAL_STATE,
  },
  {
    version: 36,
    name: "cloud durable-record convergence state",
    up: MIGRATION_36_CLOUD_RECORD_SYNC_STATE,
  },
  {
    version: 37,
    name: "immutable repository and workspace global identities",
    up: MIGRATION_37_GLOBAL_REPOSITORY_WORKSPACE_IDS,
  },
  {
    version: 38,
    name: "restart-safe local and cloud workspace copy jobs",
    up: MIGRATION_38_CLOUD_WORKSPACE_FORK_JOBS,
  },
];

/** Run all pending migrations in order, each in its own transaction. Idempotent
 *  across process restarts (tracked in `schema_migrations`). */
/** Migration 7 drops the idealized v1 `workspaces`/`messages`/`sessions`/
 *  `policies` tables. They're empty in every known build, but a DROP is
 *  irrecoverable — so if any of them actually holds rows, RENAME it to
 *  `<name>_v1_backup` first (the subsequent `DROP TABLE IF EXISTS` then no-ops
 *  on the now-absent name) so no data is silently lost. Runs inside migration
 *  7's transaction. */
function backupNonEmptyV1Tables(db: Database.Database): void {
  for (const name of ["workspaces", "messages", "sessions", "policies"]) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
    if (!exists) continue;
    const backupExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(`${name}_v1_backup`);
    if (backupExists) continue; // a prior run already backed it up
    const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as {
      c: number;
    };
    if (c > 0) {
      console.warn(
        `[zeros-db] migration 7: ${name} has ${c} row(s) — preserving as ${name}_v1_backup instead of dropping`,
      );
      db.exec(`ALTER TABLE "${name}" RENAME TO "${name}_v1_backup"`);
    }
  }
}

function hasWorkspaceLifecyclePayloadColumn(db: Database.Database): boolean {
  const columns = db
    .prepare("PRAGMA table_info(workspace_lifecycle_journal)")
    .all() as { name: string }[];
  return columns.some((column) => column.name === "payload_json");
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
}

/** This feature branch briefly recorded workspace ownership as v28 before the
 * provider-identity v28-v30 ladder landed on main. Those columns were created
 * atomically, so their presence means v31's ALTERs must be skipped while its
 * final version marker is still recorded. */
function hasFeatureBranchWorkspaceOwnerColumns(db: Database.Database): boolean {
  const columns = tableColumns(db, "workspaces");
  return columns.has("organization_id") && columns.has("placement");
}

/** Repair databases that saw the feature-branch draft v28/v29. Those versions
 * are already recorded, so the final v28/v29 cannot replay. Preserve the old
 * native values, add the generalized columns, then fill any remaining mainline
 * `session_id` locators. Runs inside v30's transaction and is idempotent. */
function repairDraftChatIdentityColumns(db: Database.Database): void {
  let columns = tableColumns(db, "chats");
  const needsCompatibilityRepair =
    columns.has("native_session_id") ||
    columns.has("native_git_info") ||
    !columns.has("provider_binding") ||
    !columns.has("provider_metadata");
  if (!columns.has("provider_binding")) {
    db.exec("ALTER TABLE chats ADD COLUMN provider_binding TEXT");
  }
  if (!columns.has("provider_metadata")) {
    db.exec("ALTER TABLE chats ADD COLUMN provider_metadata TEXT");
  }
  columns = tableColumns(db, "chats");

  if (columns.has("native_session_id")) {
    const rows = db
      .prepare(
        `SELECT id, agent_id, session_id, native_session_id
          FROM chats
          WHERE provider_binding IS NULL
            AND agent_id IS NOT NULL
            AND native_session_id IS NOT NULL
            AND length(trim(native_session_id)) > 0`,
      )
      .all() as Array<{
      id: string;
      agent_id: string | null;
      session_id: string | null;
      native_session_id: string;
    }>;
    const update = db.prepare(
      "UPDATE chats SET provider_binding = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (!row.agent_id) continue;
      update.run(
        JSON.stringify({
          version: 1,
          providerId: row.agent_id,
          kind: "native",
          resumeId: row.native_session_id,
          ...(row.session_id ? { legacySessionId: row.session_id } : {}),
        }),
        row.id,
      );
    }
  }

  if (columns.has("native_git_info")) {
    const rows = db
      .prepare(
        `SELECT id, native_git_info
           FROM chats
          WHERE provider_metadata IS NULL
            AND native_git_info IS NOT NULL`,
      )
      .all() as Array<{ id: string; native_git_info: string }>;
    const update = db.prepare(
      "UPDATE chats SET provider_metadata = ? WHERE id = ?",
    );
    for (const row of rows) {
      try {
        const git = JSON.parse(row.native_git_info) as unknown;
        if (!git || typeof git !== "object" || Array.isArray(git)) continue;
        update.run(JSON.stringify({ version: 1, git }), row.id);
      } catch {
        // Corrupt draft metadata is descriptive only. Leave it null rather
        // than blocking the user's database from opening.
      }
    }
  }

  // A mainline/fresh database already ran v29's set-based legacy backfill.
  // Avoid scanning every chat again when v30 is only recording its compatibility
  // marker; only draft/incomplete schemas need the JavaScript repair below.
  if (!needsCompatibilityRepair) return;

  const legacyRows = db
    .prepare(
      `SELECT id, agent_id, session_id
         FROM chats
        WHERE provider_binding IS NULL
          AND agent_id IS NOT NULL
          AND session_id IS NOT NULL
          AND length(trim(session_id)) > 0`,
    )
    .all() as Array<{
    id: string;
    agent_id: string | null;
    session_id: string;
  }>;
  const updateLegacy = db.prepare(
    "UPDATE chats SET provider_binding = ? WHERE id = ?",
  );
  for (const row of legacyRows) {
    if (!row.agent_id) continue;
    const providerId = row.agent_id;
    updateLegacy.run(
      JSON.stringify(
        providerId === "cursor"
          ? {
              version: 1,
              providerId,
              kind: "native",
              resumeId: row.session_id,
            }
          : {
              version: 1,
              providerId,
              kind: "legacy",
              resumeId: row.session_id,
              legacySessionId: row.session_id,
            },
      ),
      row.id,
    );
  }
}

/** A few internal builds could stop after only one draft identity migration.
 * Detect those schemas before replaying the final v28/v29 SQL: otherwise final
 * v29 would reference provider_binding before v30 had a chance to repair it. */
function shouldRepairDraftChatIdentity(
  db: Database.Database,
  version: 28 | 29,
): boolean {
  const columns = tableColumns(db, "chats");
  if (columns.has("native_session_id") || columns.has("native_git_info")) {
    return true;
  }
  return version === 28
    ? columns.has("provider_binding")
    : !columns.has("provider_binding") || columns.has("provider_metadata");
}

/** Internal builds from before this feature was rebased recorded the view-mode
 * projection as migration 28. The final ladder reserves 28-31 for mainline and
 * appends view mode at 32. Detect the schema, repair the mainline columns while
 * their old version markers are already occupied, then record 29-32 normally.
 * This is development-build compatibility only; released databases take the
 * ordinary append-only 28→32 path. */
function hasDraftWorkspaceViewModeV28(db: Database.Database): boolean {
  if (!tableColumns(db, "workspaces").has("view_mode")) return false;
  const row = db
    .prepare("SELECT name FROM schema_migrations WHERE version = 28")
    .get() as { name: string } | undefined;
  return row?.name === "workspace view mode compatibility projection";
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as {
    v: number | null;
  };
  const applied = row.v ?? 0;
  const draftViewModeV28 = hasDraftWorkspaceViewModeV28(db);
  const pending = MIGRATIONS.filter((m) => m.version > applied).sort(
    (a, b) => a.version - b.version,
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
  );
  // SINGLE-WRITER (2026-06-09): the engine is now the ONLY process that opens
  // zeros.db. The desktop's DB-touching git/GitHub/workspace IPC handlers were
  // moved onto the engine bridge (apps/desktop/src/renderer/platform/git.ts → workspace/service.ts), so
  // Electron main no longer opens the DB — its remaining handlers are all
  // DB-free. Migrations therefore run in ONE process, so the old cross-process
  // WAL-race workaround (swallow "table already exists" when the other writer
  // won the race) is gone: each migration runs once, in order, and a genuine
  // failure now surfaces instead of being silently continued past.
  for (const m of pending) {
    const tx = db.transaction(() => {
      if (m.version === 7) backupNonEmptyV1Tables(db); // Preserve non-empty v1 tables.
      let skipSql = false;
      if (
        (m.version === 28 || m.version === 29) &&
        shouldRepairDraftChatIdentity(db, m.version)
      ) {
        repairDraftChatIdentityColumns(db);
        skipSql = true;
      }
      if (m.version === 29 && draftViewModeV28) {
        // v28 was consumed by the draft view-mode migration, so v29 must create
        // both final identity columns and perform the ordinary legacy backfill.
        repairDraftChatIdentityColumns(db);
        skipSql = true;
      }
      if (m.version === 30) repairDraftChatIdentityColumns(db);
      if (m.version === 31 && hasFeatureBranchWorkspaceOwnerColumns(db)) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_workspaces_organization
            ON workspaces(organization_id, placement, archived_at)
        `);
        skipSql = true;
      }
      if (m.version === 32 && tableColumns(db, "workspaces").has("view_mode")) {
        skipSql = true;
      }
      if (m.version === 33) repairDraftChatIdentityColumns(db);
      // Early dev builds applied a draft v21 before payload_json existed.
      // SQLite has no portable ADD COLUMN IF NOT EXISTS, so v22 is an ordinary
      // tracked ALTER for those databases and a recorded no-op for fresh/final
      // v21 databases that already have the exact column.
      if (
        !skipSql &&
        (m.version !== 22 || !hasWorkspaceLifecyclePayloadColumn(db))
      ) {
        db.exec(m.up);
      }
      insert.run(m.version, m.name);
    });
    tx();
  }
}

/** The highest migration version this build knows about (for diagnostics). */
export function latestSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

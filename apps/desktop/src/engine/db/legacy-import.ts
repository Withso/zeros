// ──────────────────────────────────────────────────────────
// Legacy agent-history migration — one-time, engine-side
// ──────────────────────────────────────────────────────────
//
// Retiring electron/db.ts means the engine must hold a COMPLETE copy of the
// user's chat history before the renderer stops reading the legacy store. This
// migrates the legacy Electron-main DB (zeros-agent-history.db: `chats` +
// `agent_messages`) into the unified Zeros DB — engine-side, so it's guaranteed
// regardless of whether the old renderer one-shot import ever ran.
//
// Safety:
//  • Reads the legacy file READ-ONLY; never writes or deletes it. The file stays
//    on disk as a recovery net even after the electron/db.ts code is removed.
//  • INSERT-IF-ABSENT by chat id: a chat already in the engine (live persist or a
//    prior import) is skipped wholesale, so newer engine data is never clobbered.
//  • Idempotent: a flag row in the engine's `settings` makes it run at most once.
//  • Desktop-only: the path comes from ZEROS_LEGACY_AGENT_DB, injected by the
//    Electron sidecar. Without that explicit path, the import is a no-op.
// ──────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { openSqlite } from "./sqlite";
import { openZerosDb } from "./index";
import { upsertChat, type ChatRow } from "./chats";
import { upsertChatMessagesBulk, type PersistedMessage } from "./messages";
import { legacyProviderBinding } from "@zeros/protocol/identities";

const FLAG_KEY = "legacy-agent-history-migrated";

interface LegacyChatRow {
  id: string;
  folder: string | null;
  agent_id: string | null;
  agent_name: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  title: string | null;
  created_at: number | null;
  updated_at: number | null;
  session_id: string | null;
  pinned: number | null;
  archived: number | null;
  source_chat_id: string | null;
  kind: string | null;
}

interface LegacyMsgRow {
  msg_id: string;
  kind: string | null;
  payload: string;
  created_at: number | null;
}

function alreadyMigrated(): boolean {
  const row = openZerosDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(FLAG_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

function markMigrated(): void {
  openZerosDb()
    .prepare(
      "INSERT INTO settings (key, value, scope) VALUES (?, '1', 'local') ON CONFLICT(key) DO UPDATE SET value = '1'",
    )
    .run(FLAG_KEY);
}

function hasTable(legacy: Database.Database, name: string): boolean {
  return (
    legacy
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name) !== undefined
  );
}

function toChatRow(r: LegacyChatRow): ChatRow {
  return {
    id: r.id,
    folder: r.folder ?? "",
    agentId: r.agent_id,
    agentName: r.agent_name,
    model: r.model,
    effort: r.effort ?? "",
    permissionMode: r.permission_mode ?? "",
    // The legacy agent-history DB predates per-chat exact mode ids — start unset.
    lastModeId: null,
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: r.title ?? "",
    createdAt: r.created_at ?? 0,
    updatedAt: r.updated_at ?? 0,
    sessionId: r.session_id,
    ...(r.agent_id && r.session_id
      ? { providerBinding: legacyProviderBinding(r.agent_id, r.session_id) }
      : {}),
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    sourceChatId: r.source_chat_id,
    kind: r.kind,
  };
}

/** Run the one-time legacy migration if a legacy DB is present and we haven't
 *  migrated yet. Safe to call on every engine start (flag-guarded). Errors are
 *  swallowed (no flag set → retried next start); the legacy file is untouched. */
export function migrateLegacyAgentHistory(): void {
  const legacyPath = process.env.ZEROS_LEGACY_AGENT_DB;
  if (!legacyPath || !existsSync(legacyPath)) return;
  if (alreadyMigrated()) return;

  const zdb = openZerosDb();
  const chatExists = zdb.prepare("SELECT 1 FROM chats WHERE id = ? LIMIT 1");
  let legacy: Database.Database | undefined;
  try {
    legacy = openSqlite(legacyPath, { readonly: true, fileMustExist: true });
    // A legacy file with no chats table = nothing to migrate (fresh install).
    if (!hasTable(legacy, "chats")) {
      markMigrated();
      return;
    }
    const chats = legacy
      .prepare(
        `SELECT id, folder, agent_id, agent_name, model, effort, permission_mode, title,
                created_at, updated_at, session_id, pinned, archived, source_chat_id, kind
         FROM chats`,
      )
      .all() as LegacyChatRow[];
    const hasMessages = hasTable(legacy, "agent_messages");
    const msgStmt = hasMessages
      ? legacy.prepare(
          "SELECT msg_id, kind, payload, created_at FROM agent_messages WHERE chat_id = ? ORDER BY ord",
        )
      : null;

    let importedChats = 0;
    for (const r of chats) {
      if (!r.id || chatExists.get(r.id)) continue; // already in the engine — skip
      // Import each chat and its messages atomically. Previously a crash
      // between the chat insert and the message insert left the chat present-
      // but-empty; the retry saw the chat exists, skipped, and never imported
      // its messages → permanent partial loss. The transaction makes a crash
      // roll back the chat too, so the retry re-imports it cleanly.
      const importOne = zdb.transaction(() => {
        upsertChat(toChatRow(r));
        if (msgStmt) {
          const msgs = (msgStmt.all(r.id) as LegacyMsgRow[]).map(
            (m): PersistedMessage => ({
              msgId: m.msg_id,
              kind: m.kind ?? "",
              payload: m.payload,
              createdAt: m.created_at ?? 0,
            }),
          );
          if (msgs.length > 0) upsertChatMessagesBulk(r.id, msgs);
        }
      });
      importOne();
      importedChats++;
    }
    markMigrated();
    console.log(
      `[zeros-db] legacy agent-history migrated (${importedChats} new chat(s) of ${chats.length})`,
    );
  } catch (err) {
    console.warn(
      "[zeros-db] legacy agent-history migration failed (will retry):",
      err,
    );
  } finally {
    legacy?.close();
  }
}

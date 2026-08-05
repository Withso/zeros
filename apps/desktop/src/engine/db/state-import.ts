// ──────────────────────────────────────────────────────────
// Legacy state.db → zeros.db migration — one-time, engine-side
// ──────────────────────────────────────────────────────────
//
// Workspaces/meta/detach_state used to live in a SEPARATE engine DB at
// ~/.zeros/state.db. This importer folds them into the unified zeros.db using
// tables created by migration 7. It copies existing rows once, engine-side, so the
// fold-in is transparent. Mirrors db/legacy-import.ts:
//   • reads the legacy file READ-ONLY; never writes or deletes it (recovery net).
//   • INSERT OR IGNORE — never clobbers a row already in zeros.db (re-runs,
//     seedFromDisk, or a partial prior run are all safe).
//   • idempotent via a flag in zeros.db settings.
// On any error the flag is NOT set, so it retries next start; the legacy file
// stays put and seedFromDisk still rebuilds workspaces from disk as a backstop.
// ──────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { openZerosDb } from "./index";
import { openSqlite } from "./sqlite";
import { coerceLifecycleStatus, stateDbPath } from "../git/state";

const FLAG_KEY = "state-db-migrated";

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

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      )
      .get(name) !== undefined
  );
}

function normalizeLegacyWorkspaceRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (row.status === "archived") {
    const prState = row.pr_state;
    return {
      ...row,
      status:
        prState === "merged"
          ? "done"
          : prState === "ready" || prState === "draft"
            ? "in-review"
            : "in-progress",
    };
  }
  return { ...row, status: coerceLifecycleStatus(row.status) };
}

/** Copy the legacy ~/.zeros/state.db workspace tables into zeros.db, once. No-op
 *  if there's no legacy file (fresh install / already folded) or it already ran. */
export function migrateLegacyStateDb(): void {
  const legacyPath = stateDbPath();
  if (!existsSync(legacyPath)) {
    markMigrated();
    return;
  }
  if (alreadyMigrated()) return;

  const zdb = openZerosDb();
  let legacy: Database.Database | undefined;
  try {
    legacy = openSqlite(legacyPath, { readonly: true, fileMustExist: true });

    if (hasTable(legacy, "workspaces")) {
      const rows = (
        legacy.prepare("SELECT * FROM workspaces").all() as Record<
          string,
          unknown
        >[]
      ).map(normalizeLegacyWorkspaceRow);
      const ins = zdb.prepare(
        `INSERT OR IGNORE INTO workspaces
           (id, repo_slug, repo_root, branch, base_branch, path, status, created_at,
            archived_at, stash_ref, pr_number, pr_state, pr_url, agent_id, last_active_at)
         VALUES (@id, @repo_slug, @repo_root, @branch, @base_branch, @path, @status, @created_at,
                 @archived_at, @stash_ref, @pr_number, @pr_state, @pr_url, @agent_id, @last_active_at)`,
      );
      zdb.transaction((items: Record<string, unknown>[]) => {
        for (const r of items) ins.run(r);
      })(rows);
    }

    if (hasTable(legacy, "workspace_meta")) {
      const rows = legacy
        .prepare("SELECT * FROM workspace_meta")
        .all() as Record<string, unknown>[];
      // Under foreign_keys=ON, INSERT OR IGNORE SILENTLY swallows an FK
      // violation — a meta row whose workspace_id wasn't inserted (id collision
      // with a pre-existing zeros.db row, or an absent parent) just vanishes,
      // and markMigrated() below makes that loss one-shot/irreversible with no
      // diagnostic. Pre-filter to parents that actually landed, and surface the
      // gap so a silent drop is observable.
      const existing = new Set(
        (
          zdb.prepare("SELECT id FROM workspaces").all() as { id: string }[]
        ).map((w) => w.id),
      );
      const importable = rows.filter((r) =>
        existing.has(String(r.workspace_id)),
      );
      const orphaned = rows.length - importable.length;
      if (orphaned > 0) {
        console.warn(
          `[zeros-db] state.db fold-in: skipped ${orphaned}/${rows.length} workspace_meta row(s) whose workspace is absent from zeros.db`,
        );
      }
      const ins = zdb.prepare(
        "INSERT OR IGNORE INTO workspace_meta (workspace_id, key, value) VALUES (@workspace_id, @key, @value)",
      );
      let inserted = 0;
      zdb.transaction((items: Record<string, unknown>[]) => {
        for (const r of items) inserted += ins.run(r).changes;
      })(importable);
      if (inserted < importable.length) {
        console.warn(
          `[zeros-db] state.db fold-in: ${importable.length - inserted} workspace_meta row(s) ignored on conflict (already present)`,
        );
      }
    }

    if (hasTable(legacy, "detach_state")) {
      const row = legacy
        .prepare("SELECT * FROM detach_state WHERE id = 1")
        .get() as Record<string, unknown> | undefined;
      if (row) {
        // Bind only the columns the INSERT names, positionally. The old code
        // bound the whole `SELECT *` row (which always carries `id`, plus any
        // legacy extra column) to a named-param statement — better-sqlite3 throws
        // RangeError on an unused bound key, so ANY active detach blew up the
        // whole fold-in at upgrade.
        zdb
          .prepare(
            `INSERT OR IGNORE INTO detach_state
               (id, workspace_id, pre_root_head, checkpoint_sha, started_at, lockfile_pid)
             VALUES (1, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.workspace_id ?? null,
            row.pre_root_head ?? null,
            row.checkpoint_sha ?? null,
            row.started_at ?? null,
            row.lockfile_pid ?? null,
          );
      }
    }

    markMigrated();
    console.log("[zeros-db] folded legacy state.db (workspaces) into zeros.db");
  } catch (err) {
    console.warn("[zeros-db] state.db fold-in failed (will retry):", err);
  } finally {
    legacy?.close();
  }
}

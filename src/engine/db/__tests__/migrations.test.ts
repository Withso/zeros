// Migration-ladder data-safety tests for the shipped zeros.db.
//
// zeros.db is the SOLE copy of each user's chats / transcripts / workspaces /
// settings, living only on their Mac. The one mistake that corrupts existing
// users is editing or reordering an already-released migration — runMigrations()
// skips versions already in schema_migrations, so an edited old migration NEVER
// re-runs on an existing install. These tests guard the two failure modes a
// fresh-install assertion can't see:
//   1. the full ladder applies empty→head and is idempotent (version-agnostic);
//   2. a destructive migration that runs WITH data present (migration 7, which
//      DROPs the idealized v1 tables) preserves non-empty data instead of
//      losing it — the exact "upgrade-only data-loss" class.
//
// Uses better-sqlite3 + the exported MIGRATIONS/runMigrations directly (not the
// engine's path-resolving openZerosDb) so the ladder is tested in isolation and
// we can stop at an intermediate version to simulate an existing user upgrading.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";

import { MIGRATIONS, runMigrations, latestSchemaVersion } from "../migrations";

function applyUpTo(db: Database.Database, maxVersion: number): void {
  db.exec(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );
  const mark = db.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );
  for (const m of MIGRATIONS.filter((m) => m.version <= maxVersion)) {
    db.exec(m.up);
    mark.run(m.version, m.name);
  }
}

function appliedVersions(db: Database.Database): number[] {
  return (
    db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: number }[]
  ).map((r) => r.version);
}

function tableNames(db: Database.Database): Set<string> {
  return new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
}

describe("Zeros DB — migration ladder data safety (forward-only)", () => {
  it("applies the whole ladder empty→head (contiguous 1..latest) and re-running is a no-op", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);

      const latest = latestSchemaVersion();
      // Version-agnostic: whatever `latest` is, schema_migrations must be the
      // exact contiguous run 1..latest (no gaps, no duplicates, no overshoot).
      expect(appliedVersions(db)).toEqual(
        Array.from({ length: latest }, (_, i) => i + 1),
      );
      expect(tableNames(db).has("workspace_lifecycle_journal")).toBe(true);
      expect(
        (
          db
            .prepare("PRAGMA table_info(workspace_lifecycle_journal)")
            .all() as { name: string }[]
        ).some((column) => column.name === "payload_json"),
      ).toBe(true);

      // Idempotent: a second run on the same DB applies nothing and never throws
      // (re-applying a migration's CREATE/ALTER would throw — proves the
      // schema_migrations guard holds).
      expect(() => runMigrations(db)).not.toThrow();
      expect(appliedVersions(db)).toHaveLength(latest);
    } finally {
      db.close();
    }
  });

  it("migrations 22-23 repair the exact draft v21 schema without losing lifecycle intent", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 20);

      // A dev build briefly shipped this v21 draft: create/delete/restore/archive
      // fail once newer code needs payload_json or journals operation='create'.
      db.exec(`
        INSERT INTO workspaces (
          id, repo_slug, repo_root, branch, base_branch, path, status, created_at
        ) VALUES
          (
            'ws_recover', 'repo', '/repo', 'zeros/recover', 'main',
            '/workspaces/recover', 'in-progress', 1
          ),
          (
            'ws_create', 'repo', '/repo', 'zeros/create', 'main',
            '/workspaces/create', 'in-progress', 2
          );

        CREATE TABLE workspace_lifecycle_journal (
          workspace_id     TEXT PRIMARY KEY,
          operation        TEXT NOT NULL
                           CHECK (operation IN ('archive', 'restore', 'delete')),
          phase            TEXT NOT NULL,
          source_path      TEXT NOT NULL,
          target_path      TEXT,
          source_branch    TEXT NOT NULL,
          target_branch    TEXT,
          create_from      TEXT,
          archive_snapshot TEXT,
          archived_head    TEXT,
          adaptations_json TEXT NOT NULL DEFAULT '[]',
          include_branch   INTEGER NOT NULL DEFAULT 0,
          started_at       INTEGER NOT NULL
        );
        CREATE INDEX idx_workspace_lifecycle_operation
          ON workspace_lifecycle_journal(operation);
        INSERT INTO workspace_lifecycle_journal (
          workspace_id, operation, phase, source_path, source_branch,
          adaptations_json, include_branch, started_at
        ) VALUES (
          'ws_recover', 'restore', 'intent', '/old/path',
          'zeros/recover', '["keep"]', 0, 123
        );
      `);
      db.prepare(
        "INSERT INTO schema_migrations (version, name) VALUES (21, ?)",
      ).run(
        "workspace lifecycle journal (restart-safe archive/restore/delete)",
      );

      expect(() => runMigrations(db)).not.toThrow();
      expect(appliedVersions(db).at(-1)).toBe(24);

      const columns = db
        .prepare("PRAGMA table_info(workspace_lifecycle_journal)")
        .all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      const payload = columns.find((column) => column.name === "payload_json");
      expect(payload).toMatchObject({
        name: "payload_json",
        notnull: 1,
        dflt_value: "'{}'",
      });
      expect(
        db
          .prepare(
            `SELECT operation, phase, source_path, adaptations_json,
                    include_branch, started_at, payload_json
               FROM workspace_lifecycle_journal
              WHERE workspace_id = 'ws_recover'`,
          )
          .get(),
      ).toEqual({
        operation: "restore",
        phase: "intent",
        source_path: "/old/path",
        adaptations_json: '["keep"]',
        include_branch: 0,
        started_at: 123,
        payload_json: "{}",
      });

      // The rebuilt CHECK constraint now accepts the operation that failed in
      // the real dev instance, while retaining the draft-v21 recovery row.
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspace_lifecycle_journal (
               workspace_id, operation, phase, source_path, source_branch,
               adaptations_json, payload_json, include_branch, started_at
             ) VALUES (
               'ws_create', 'create', 'prepared', '/workspaces/create',
               'zeros/create', '[]', '{}', 0, 456
             )`,
          )
          .run(),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("migration 7 preserves NON-EMPTY legacy v1 tables as *_v1_backup instead of dropping (existing-user upgrade with data)", () => {
    const db = new Database(":memory:");
    try {
      // Stop at v6 — the idealized v1 `sessions`/`messages` tables still exist
      // (migration 7 drops them). This is the state of a user who installed
      // before v7 shipped.
      applyUpTo(db, 6);

      // Seed the v1 tables migration 7 DROPs...
      db.prepare("INSERT INTO sessions (id) VALUES ('s1')").run();
      db.prepare(
        "INSERT INTO messages (id, session_id, seq, content) VALUES ('m1','s1',0,'hello')",
      ).run();
      // ...and the LIVE tables (chats v3 / chat_messages v4) that must survive.
      db.prepare("INSERT INTO chats (id, title) VALUES ('c1','keepme')").run();
      db.prepare(
        "INSERT INTO chat_messages (chat_id, msg_id, ord, payload, created_at) VALUES ('c1','cm1',0,'{}',1)",
      ).run();

      // Upgrade the remaining ladder (7..head) with data present.
      runMigrations(db);

      const tables = tableNames(db);
      expect(appliedVersions(db).at(-1)).toBe(latestSchemaVersion());

      // The non-empty v1 tables were RENAMED to *_v1_backup, not silently dropped
      // (backupNonEmptyV1Tables), and their rows are intact.
      expect(tables.has("sessions_v1_backup")).toBe(true);
      expect(tables.has("messages_v1_backup")).toBe(true);
      expect(
        (
          db.prepare("SELECT COUNT(*) AS n FROM sessions_v1_backup").get() as {
            n: number;
          }
        ).n,
      ).toBe(1);
      expect(
        (
          db
            .prepare("SELECT content FROM messages_v1_backup WHERE id='m1'")
            .get() as { content: string }
        ).content,
      ).toBe("hello");

      // The live tables and their data survived the upgrade untouched, and the
      // REAL post-7 workspaces schema is in place.
      expect(
        (
          db.prepare("SELECT title FROM chats WHERE id='c1'").get() as {
            title: string;
          }
        ).title,
      ).toBe("keepme");
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id='c1'",
            )
            .get() as { n: number }
        ).n,
      ).toBe(1);
      expect(tables.has("workspaces")).toBe(true);
    } finally {
      db.close();
    }
  });

  // Migration 24 adds the UNIQUE index that makes allocated colour names safe.
  // CREATE UNIQUE INDEX aborts the whole migration if the table already holds a
  // duplicate, which would leave the user unable to launch — so 24 renames
  // duplicates out of the way first. Duplicates cannot occur under the old
  // random-hex scheme; this guards the "impossible" DB rather than a real one.
  it("migration 24 survives pre-existing duplicate branches without losing rows", () => {
    const db = new Database(":memory:");
    try {
      // Stop at 21: migration 22 is the conditional draft-v21 repair, which
      // only runMigrations knows how to skip. It applies 22-24 below.
      applyUpTo(db, 21);
      const insert = db.prepare(
        `INSERT INTO workspaces
           (id, repo_slug, repo_root, branch, base_branch, path, status, created_at)
         VALUES (?, ?, '/tmp/r', ?, 'main', ?, 'in-progress', ?)`,
      );
      // Same repo, same branch — what 24 has to defuse.
      insert.run("ws_older", "alpha", "zeros/Cream", "/tmp/w1", 1);
      insert.run("ws_newer", "alpha", "zeros/Cream", "/tmp/w2", 2);
      // Same branch, DIFFERENT repo — must be left completely alone.
      insert.run("ws_other", "beta", "zeros/Cream", "/tmp/w3", 3);

      expect(() => runMigrations(db)).not.toThrow();

      // No row is deleted: the user keeps every workspace.
      const rows = db
        .prepare("SELECT id, repo_slug, branch FROM workspaces ORDER BY id")
        .all() as { id: string; repo_slug: string; branch: string }[];
      expect(rows).toHaveLength(3);

      const byId = new Map(rows.map((r) => [r.id, r]));
      // Oldest keeps the name; the later duplicate is renamed visibly.
      expect(byId.get("ws_older")!.branch).toBe("zeros/Cream");
      expect(byId.get("ws_newer")!.branch).toMatch(/^zeros\/Cream-dup-/);
      // The other repo is untouched — uniqueness is per-repo.
      expect(byId.get("ws_other")!.branch).toBe("zeros/Cream");

      // And the index is now actually enforcing.
      expect(() =>
        insert.run("ws_late", "alpha", "zeros/Cream", "/tmp/w4", 4),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  // The rename has to be unique across the LOSERS too, not just against the
  // winner. Real ids are `ws_<6hex>-<prompt slug>`, so any id TAIL comes from
  // the prompt and two workspaces made from similar prompts share it — three
  // rows on one branch would then rename two of them to the same value and
  // abort the very migration the rename exists to keep running.
  it("migration 24 defuses three rows on one branch with look-alike ids", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 21);
      const insert = db.prepare(
        `INSERT INTO workspaces
           (id, repo_slug, repo_root, branch, base_branch, path, status, created_at)
         VALUES (?, ?, '/tmp/r', ?, 'main', ?, 'in-progress', ?)`,
      );
      // The last six characters of all three ids are identical ("s-zoom").
      insert.run("ws_111111-add-canvas-zoom", "alpha", "zeros/Cream", "/a", 1);
      insert.run("ws_222222-add-canvas-zoom", "alpha", "zeros/Cream", "/b", 2);
      insert.run("ws_333333-fix-canvas-zoom", "alpha", "zeros/Cream", "/c", 3);

      expect(() => runMigrations(db)).not.toThrow();

      const branches = (
        db.prepare("SELECT branch FROM workspaces ORDER BY id").all() as {
          branch: string;
        }[]
      ).map((row) => row.branch);
      expect(branches).toHaveLength(3);
      // Oldest keeps the name; both losers get DISTINCT renames.
      expect(branches).toContain("zeros/Cream");
      expect(new Set(branches).size).toBe(3);
    } finally {
      db.close();
    }
  });
});

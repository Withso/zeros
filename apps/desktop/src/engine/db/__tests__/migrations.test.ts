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
    // v22 is a conditional repair: the final v21 already has payload_json,
    // while the draft v21 does not. Mirror runMigrations so this helper can
    // safely construct any later released schema.
    const hasPayload =
      m.version === 22 &&
      (
        db.prepare("PRAGMA table_info(workspace_lifecycle_journal)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "payload_json");
    if (!hasPayload) db.exec(m.up);
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

function tableColumnsForTest(
  db: Database.Database,
  table: string,
): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
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
      const chatColumns = db.prepare("PRAGMA table_info(chats)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(
        chatColumns.find((column) => column.name === "mode"),
      ).toMatchObject({
        name: "mode",
        notnull: 1,
        dflt_value: "'code'",
      });
      const workspaceColumns = db
        .prepare("PRAGMA table_info(workspaces)")
        .all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(
        workspaceColumns.find((column) => column.name === "kind"),
      ).toMatchObject({
        name: "kind",
        notnull: 1,
        dflt_value: "'code'",
      });
      expect(
        workspaceColumns.find((column) => column.name === "placement"),
      ).toMatchObject({
        name: "placement",
        notnull: 1,
        dflt_value: "'local'",
      });
      expect(
        workspaceColumns.find((column) => column.name === "organization_id"),
      ).toMatchObject({ name: "organization_id", notnull: 0 });
      expect(
        chatColumns.some((column) => column.name === "provider_binding"),
      ).toBe(true);
      expect(
        chatColumns.some((column) => column.name === "provider_metadata"),
      ).toBe(true);
      expect(
        workspaceColumns.find((column) => column.name === "view_mode"),
      ).toMatchObject({
        name: "view_mode",
        notnull: 1,
        dflt_value: "'code'",
      });
      db.prepare(
        `INSERT INTO workspaces (
           id, repo_slug, repo_root, branch, base_branch, path, status,
           created_at, kind
         ) VALUES ('view-mode-probe', 'repo', '/repo', 'zeros/probe', 'main',
                   '/workspaces/probe', 'in-progress', 1, 'design')`,
      ).run();
      expect(
        db
          .prepare("SELECT kind, view_mode FROM workspaces WHERE id = ?")
          .get("view-mode-probe"),
      ).toEqual({ kind: "design", view_mode: "design" });
      db.prepare("UPDATE workspaces SET view_mode = 'code' WHERE id = ?").run(
        "view-mode-probe",
      );
      expect(
        db
          .prepare("SELECT kind, view_mode FROM workspaces WHERE id = ?")
          .get("view-mode-probe"),
      ).toEqual({ kind: "code", view_mode: "code" });
      db.prepare("UPDATE workspaces SET kind = 'design' WHERE id = ?").run(
        "view-mode-probe",
      );
      expect(
        db
          .prepare("SELECT kind, view_mode FROM workspaces WHERE id = ?")
          .get("view-mode-probe"),
      ).toEqual({ kind: "design", view_mode: "design" });

      // Idempotent: a second run on the same DB applies nothing and never throws
      // (re-applying a migration's CREATE/ALTER would throw — proves the
      // schema_migrations guard holds).
      expect(() => runMigrations(db)).not.toThrow();
      expect(appliedVersions(db)).toHaveLength(latest);
    } finally {
      db.close();
    }
  });

  it("migration 31 backfills legacy workspaces as local and reserves cloud for an organization owner", () => {
    const db = new Database(":memory:");
    try {
      // Stop before the conditional v22 repair; runMigrations owns that path.
      // The row still crosses every workspace migration, including v31.
      applyUpTo(db, 21);
      db.prepare(
        `INSERT INTO workspaces
           (id, repo_slug, repo_root, branch, base_branch, path,
            status, created_at)
         VALUES ('ws_legacy', 'repo', '/repo', 'zeros/Cream',
                 'main', '/workspaces/Cream', 'in-progress', 1)`,
      ).run();

      runMigrations(db);

      expect(
        db
          .prepare(
            `SELECT organization_id, placement FROM workspaces
             WHERE id = 'ws_legacy'`,
          )
          .get(),
      ).toEqual({ organization_id: null, placement: "local" });
      expect(() =>
        db
          .prepare(
            `INSERT INTO workspaces
               (id, kind, repo_slug, repo_root, branch, base_branch, path,
                status, created_at, placement)
             VALUES ('ws_bad', 'code', 'repo', '/repo', 'zeros/Blue',
                     'main', '/workspaces/Blue', 'in-progress', 2, 'cloud')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });

  it("upgrades a feature-branch database that recorded workspace ownership as migration 28", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      db.exec(`
        ALTER TABLE workspaces ADD COLUMN organization_id TEXT;
        ALTER TABLE workspaces ADD COLUMN placement TEXT NOT NULL DEFAULT 'local'
          CHECK (placement IN ('local', 'cloud'))
          CHECK (placement = 'local' OR organization_id IS NOT NULL);
        CREATE INDEX idx_workspaces_organization
          ON workspaces(organization_id, placement, archived_at);
        INSERT INTO schema_migrations (version, name)
          VALUES (28, 'workspaces: organization owner + local/cloud placement');
      `);

      expect(() => runMigrations(db)).not.toThrow();
      expect(appliedVersions(db).at(-1)).toBe(latestSchemaVersion());

      const workspaceColumns = db
        .prepare("PRAGMA table_info(workspaces)")
        .all() as { name: string }[];
      const chatColumns = db.prepare("PRAGMA table_info(chats)").all() as {
        name: string;
      }[];
      expect(
        workspaceColumns.some((column) => column.name === "organization_id"),
      ).toBe(true);
      expect(
        workspaceColumns.some((column) => column.name === "placement"),
      ).toBe(true);
      expect(
        chatColumns.some((column) => column.name === "provider_binding"),
      ).toBe(true);
      expect(
        chatColumns.some((column) => column.name === "provider_metadata"),
      ).toBe(true);
    } finally {
      db.close();
    }
  });

  it("repairs provider identity after retired foundation drafts consumed migrations 28-30", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      db.prepare(
        `INSERT INTO chats (id, folder, agent_id, title, session_id)
         VALUES ('draft-chat', '/repo', 'codex', 'Draft chat', 'legacy-thread')`,
      ).run();

      // Internal checkpoint builds used these migration numbers for early
      // Design-agent foundation drafts. A later build could legitimately add
      // the final v31/v32 workspace columns while v28-v30 remained recorded,
      // leaving the database at head without provider_binding/provider_metadata.
      db.exec(`
        ALTER TABLE workspaces ADD COLUMN view_mode TEXT NOT NULL DEFAULT 'code'
          CHECK (view_mode IN ('code', 'design'));
        INSERT INTO schema_migrations (version, name) VALUES
          (28, 'workspace view mode compatibility + durable generation identity'),
          (29, 'durable workspace commands, revisions, events, and outbox'),
          (30, 'content-addressed artifact metadata and retention pins');

        ALTER TABLE workspaces ADD COLUMN organization_id TEXT;
        ALTER TABLE workspaces ADD COLUMN placement TEXT NOT NULL DEFAULT 'local'
          CHECK (placement IN ('local', 'cloud'))
          CHECK (placement = 'local' OR organization_id IS NOT NULL);
        CREATE INDEX idx_workspaces_organization
          ON workspaces(organization_id, placement, archived_at);
        INSERT INTO schema_migrations (version, name) VALUES
          (31, 'workspaces: organization owner + local/cloud placement'),
          (32, 'workspace view mode compatibility projection');
      `);

      runMigrations(db);

      expect(appliedVersions(db).at(-1)).toBe(latestSchemaVersion());
      const chatColumns = tableColumnsForTest(db, "chats");
      expect(chatColumns.has("provider_binding")).toBe(true);
      expect(chatColumns.has("provider_metadata")).toBe(true);
      const row = db
        .prepare(
          `SELECT provider_binding, provider_metadata
             FROM chats
            WHERE id = 'draft-chat'`,
        )
        .get() as {
        provider_binding: string | null;
        provider_metadata: string | null;
      };
      expect(JSON.parse(row.provider_binding ?? "null")).toEqual({
        version: 1,
        providerId: "codex",
        kind: "legacy",
        resumeId: "legacy-thread",
        legacySessionId: "legacy-thread",
      });
      expect(row.provider_metadata).toBeNull();
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
      // To HEAD, not to a pinned number: this test is about the 22-23 repair
      // surviving a draft-v21 database, and hardcoding the ladder's length
      // made every later migration fail it for an unrelated reason. The
      // fresh-install assertion in db.test.ts is where the exact version list
      // is pinned. (Line 219 below already did it this way.)
      expect(appliedVersions(db).at(-1)).toBe(latestSchemaVersion());

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

  it("repairs a development database that recorded view mode as draft migration 28", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      const viewModeMigration = MIGRATIONS.find(
        (migration) => migration.version === 32,
      );
      expect(viewModeMigration).toBeDefined();
      db.exec(viewModeMigration!.up);
      db.prepare(
        "INSERT INTO schema_migrations (version, name) VALUES (28, ?)",
      ).run("workspace view mode compatibility projection");
      db.prepare(
        `INSERT INTO chats (id, agent_id, session_id, title)
         VALUES ('draft-chat', 'claude', 'legacy-session', 'Draft')`,
      ).run();

      expect(() => runMigrations(db)).not.toThrow();
      expect(appliedVersions(db)).toEqual(
        Array.from({ length: latestSchemaVersion() }, (_, index) => index + 1),
      );
      const chat = db
        .prepare(
          `SELECT provider_binding, provider_metadata
             FROM chats WHERE id = 'draft-chat'`,
        )
        .get() as {
        provider_binding: string;
        provider_metadata: string | null;
      };
      expect(JSON.parse(chat.provider_binding)).toMatchObject({
        providerId: "claude",
        kind: "legacy",
        resumeId: "legacy-session",
      });
      expect(chat.provider_metadata).toBeNull();
      expect(tableColumnsForTest(db, "workspaces").has("organization_id")).toBe(
        true,
      );
      expect(tableColumnsForTest(db, "workspaces").has("view_mode")).toBe(true);
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

  it("migration 30 repairs draft v28/v29 native columns and preserves their Codex identity", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      db.exec(`
        ALTER TABLE chats ADD COLUMN native_session_id TEXT;
        ALTER TABLE chats ADD COLUMN native_git_info TEXT;
        INSERT INTO schema_migrations (version, name)
          VALUES (28, 'chats.native_session_id');
        INSERT INTO schema_migrations (version, name)
          VALUES (29, 'chats.native_git_info');
        INSERT INTO chats (
          id, agent_id, session_id, native_session_id, native_git_info, title
        ) VALUES (
          'chat-codex', 'codex', 'old-live-execution', 'codex-thread-1',
          '{"sha":"abc","branch":"main","originUrl":"https://example.test/repo"}',
          'Keep me'
        );
      `);

      expect(() => runMigrations(db)).not.toThrow();

      const row = db
        .prepare(
          `SELECT provider_binding, provider_metadata, title
             FROM chats WHERE id = 'chat-codex'`,
        )
        .get() as {
        provider_binding: string;
        provider_metadata: string;
        title: string;
      };
      expect(JSON.parse(row.provider_binding)).toEqual({
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "codex-thread-1",
        legacySessionId: "old-live-execution",
      });
      expect(JSON.parse(row.provider_metadata)).toEqual({
        version: 1,
        git: {
          sha: "abc",
          branch: "main",
          originUrl: "https://example.test/repo",
        },
      });
      expect(row.title).toBe("Keep me");
    } finally {
      db.close();
    }
  });

  it("repairs a database that stopped after only draft v28 before final v29 runs", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      db.exec(`
        ALTER TABLE chats ADD COLUMN native_session_id TEXT;
        INSERT INTO schema_migrations (version, name)
          VALUES (28, 'chats.native_session_id');
        INSERT INTO chats (
          id, agent_id, session_id, native_session_id, title
        ) VALUES (
          'chat-codex', 'codex', 'old-execution', 'codex-thread-partial',
          'Partial draft'
        );
      `);

      expect(() => runMigrations(db)).not.toThrow();
      const row = db
        .prepare(
          `SELECT provider_binding, provider_metadata
             FROM chats WHERE id = 'chat-codex'`,
        )
        .get() as {
        provider_binding: string;
        provider_metadata: string | null;
      };
      expect(JSON.parse(row.provider_binding)).toEqual({
        version: 1,
        providerId: "codex",
        kind: "native",
        resumeId: "codex-thread-partial",
        legacySessionId: "old-execution",
      });
      expect(row.provider_metadata).toBeNull();
      expect(appliedVersions(db).at(-1)).toBe(latestSchemaVersion());
    } finally {
      db.close();
    }
  });

  it("migration 29 backfills legacy mainline chat locators without treating Claude executions as native ids", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 27);
      db.exec(`
        INSERT INTO chats (id, agent_id, session_id, title) VALUES
          ('chat-cursor', 'cursor', 'cursor-agent-1', 'Cursor'),
          ('chat-claude', 'claude', 'old-claude-execution', 'Claude'),
          ('chat-unbound', NULL, 'ambiguous-locator', 'Unbound');
      `);

      runMigrations(db);
      const rows = db
        .prepare(
          `SELECT id, provider_binding FROM chats
            WHERE id IN ('chat-cursor', 'chat-claude') ORDER BY id`,
        )
        .all() as Array<{ id: string; provider_binding: string }>;
      const bindings = new Map(
        rows.map((row) => [row.id, JSON.parse(row.provider_binding)]),
      );
      expect(bindings.get("chat-cursor")).toEqual({
        version: 1,
        providerId: "cursor",
        kind: "native",
        resumeId: "cursor-agent-1",
      });
      expect(bindings.get("chat-claude")).toEqual({
        version: 1,
        providerId: "claude",
        kind: "legacy",
        resumeId: "old-claude-execution",
        legacySessionId: "old-claude-execution",
      });
      expect(
        (
          db
            .prepare(
              "SELECT provider_binding FROM chats WHERE id = 'chat-unbound'",
            )
            .get() as { provider_binding: string | null }
        ).provider_binding,
      ).toBeNull();
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

  it("migration 37 backfills immutable UUIDs without rewriting compatibility ids", () => {
    const db = new Database(":memory:");
    try {
      applyUpTo(db, 36);
      db.prepare(
        `INSERT INTO repos (id, name, root_path)
         VALUES ('proj_legacy', 'Legacy', '/tmp/legacy')`,
      ).run();
      db.prepare(
        `INSERT INTO workspaces
           (id, repo_slug, repo_root, branch, base_branch, path, status, created_at)
         VALUES
           ('ws_legacy-readable', 'legacy', '/tmp/legacy', 'zeros/Legacy',
            'main', '/tmp/legacy-worktree', 'in-progress', 1)`,
      ).run();

      runMigrations(db);

      const repository = db
        .prepare("SELECT id, canonical_id FROM repos WHERE id = 'proj_legacy'")
        .get() as { id: string; canonical_id: string };
      const workspace = db
        .prepare(
          "SELECT id, canonical_id FROM workspaces WHERE id = 'ws_legacy-readable'",
        )
        .get() as { id: string; canonical_id: string };
      expect(repository.id).toBe("proj_legacy");
      expect(workspace.id).toBe("ws_legacy-readable");
      expect(repository.canonical_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(workspace.canonical_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(workspace.canonical_id).not.toBe(repository.canonical_id);

      // Legacy/direct writers remain compatible and are filled by the DB.
      db.prepare(
        `INSERT INTO repos (id, name, root_path)
         VALUES ('proj_later', 'Later', '/tmp/later')`,
      ).run();
      const later = db
        .prepare("SELECT canonical_id FROM repos WHERE id = 'proj_later'")
        .get() as { canonical_id: string };
      expect(later.canonical_id).toMatch(/^[0-9a-f-]{36}$/);

      expect(() =>
        db
          .prepare(
            "UPDATE workspaces SET canonical_id = ? WHERE id = 'ws_legacy-readable'",
          )
          .run("00000000-0000-4000-8000-000000000000"),
      ).toThrow(/immutable/i);
      expect(() =>
        db
          .prepare(
            "INSERT INTO repos (id, canonical_id) VALUES ('bad', 'NOT-A-UUID')",
          )
          .run(),
      ).toThrow(/lowercase UUID/i);
    } finally {
      db.close();
    }
  });
});

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqlite } from "../sqlite";
import { closeZerosDb } from "../index";
import {
  setStateRootForTesting,
  listWorkspaces,
  getWorkspaceMeta,
  getDetachState,
  insertWorkspace,
} from "../../git/state";
import { migrateLegacyStateDb } from "../state-import";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zeros-stateimport-"));
}

/** Build a fixture matching the legacy ~/.zeros/state.db schema. */
function makeLegacyStateDb(root: string): void {
  const db = openSqlite(path.join(root, "state.db"));
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, repo_slug TEXT NOT NULL, repo_root TEXT NOT NULL,
      branch TEXT NOT NULL, base_branch TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, archived_at INTEGER, stash_ref TEXT, pr_number INTEGER,
      pr_state TEXT, pr_url TEXT, agent_id TEXT, last_active_at INTEGER);
    CREATE TABLE workspace_meta (workspace_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key));
    CREATE TABLE detach_state (id INTEGER PRIMARY KEY CHECK (id = 1), workspace_id TEXT NOT NULL,
      pre_root_head TEXT NOT NULL, checkpoint_sha TEXT, started_at INTEGER NOT NULL, lockfile_pid INTEGER NOT NULL);
  `);
  db.prepare(
    "INSERT INTO workspaces (id, repo_slug, repo_root, branch, base_branch, path, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("ws1", "myrepo", "/r", "zeros/x", "main", "/r/wt", "active", 100);
  db.prepare("INSERT INTO workspace_meta (workspace_id, key, value) VALUES (?,?,?)").run("ws1", "setup", "done");
  db.prepare(
    "INSERT INTO detach_state (id, workspace_id, pre_root_head, started_at, lockfile_pid) VALUES (1,?,?,?,?)",
  ).run("ws1", "abc123", 200, 4242);
  db.close();
}

describe("legacy state.db fold-in (Phase 0)", () => {
  afterEach(() => {
    closeZerosDb();
    setStateRootForTesting(null);
  });

  it("copies workspaces + meta + detach_state into zeros.db, idempotently", () => {
    const root = tmpRoot();
    makeLegacyStateDb(root);
    // zeros.db → root/zeros.db; stateDbPath() (the legacy source) → root/state.db.
    setStateRootForTesting(root);

    migrateLegacyStateDb();
    expect(listWorkspaces().map((w) => w.id)).toEqual(["ws1"]);
    expect(listWorkspaces()[0]?.status).toBe("in-progress");
    expect(getWorkspaceMeta("ws1", "setup")).toBe("done");
    expect(getDetachState()?.workspaceId).toBe("ws1");

    // Second run is a no-op (flag set) — counts unchanged.
    migrateLegacyStateDb();
    expect(listWorkspaces().length).toBe(1);
  });

  it("normalizes legacy workspace status values during import", () => {
    const root = tmpRoot();
    makeLegacyStateDb(root);
    const db = openSqlite(path.join(root, "state.db"));
    db.prepare(
      "INSERT INTO workspaces (id, repo_slug, repo_root, branch, base_branch, path, status, created_at, archived_at, pr_state) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("ws2", "myrepo", "/r", "zeros/y", "main", "/r/wt2", "merged", 101, null, "merged");
    db.prepare(
      "INSERT INTO workspaces (id, repo_slug, repo_root, branch, base_branch, path, status, created_at, archived_at, pr_state) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run("ws3", "myrepo", "/r", "zeros/z", "main", "/r/wt3", "archived", 102, 123, "ready");
    db.close();
    setStateRootForTesting(root);

    migrateLegacyStateDb();
    const statuses = new Map(listWorkspaces().map((w) => [w.id, w.status]));
    expect(statuses.get("ws1")).toBe("in-progress");
    expect(statuses.get("ws2")).toBe("done");
    expect(statuses.get("ws3")).toBe("in-review");
  });

  it("INSERT-OR-IGNORE: never clobbers a workspace already in zeros.db", () => {
    const root = tmpRoot();
    makeLegacyStateDb(root);
    setStateRootForTesting(root);
    // Pre-seed the engine with the same id but a different branch.
    insertWorkspace({
      id: "ws1", repoSlug: "myrepo", repoRoot: "/r", branch: "newer", baseBranch: "main",
      path: "/r/wt2", status: "in-progress", createdAt: 999, archivedAt: null, stashRef: null,
      prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
    });
    migrateLegacyStateDb();
    expect(listWorkspaces().find((w) => w.id === "ws1")!.branch).toBe("newer");
  });

  it("no-op when there's no legacy state.db", () => {
    const root = tmpRoot();
    setStateRootForTesting(root);
    migrateLegacyStateDb();
    expect(listWorkspaces()).toEqual([]);
  });
});

// Worktree crash-recovery seed lives in app-data now (the in-tree
// `<worktree>/.zeros/workspace.json` was retired). These guard the contract:
// seeds never touch the worktree, recovery reads them from app-data, vanished
// worktrees aren't resurrected, and the legacy in-tree seed is migrated out.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  setStateRootForTesting,
  insertWorkspace,
  getWorkspaceById,
  deleteWorkspaceRow,
  writeWorktreeSeed,
  removeWorktreeSeed,
  migrateLegacyWorktreeSeeds,
  seedFromDisk,
  worktreesRoot,
} from "../state";
import { worktreeSeedPath } from "../../db/paths";
import type { Workspace } from "../types";

function makeWs(root: string): Workspace {
  const wsPath = path.join(worktreesRoot(), "repo", "ws_seed_1");
  mkdirSync(wsPath, { recursive: true });
  return {
    id: "ws_seed_1",
    repoSlug: "repo",
    repoRoot: root,
    branch: "zeros/seed-1",
    baseBranch: "main",
    path: wsPath,
    status: "in-progress",
    createdAt: Date.now(),
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
  };
}

describe("worktree recovery seed (app-data; .zeros retired)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-seed-"));
    setStateRootForTesting(root);
  });
  afterEach(() => {
    setStateRootForTesting(null); // closes the DB + clears the data-dir override
    rmSync(root, { recursive: true, force: true });
  });

  it("writeWorktreeSeed writes to app-data, never into the worktree", () => {
    const ws = makeWs(root);
    insertWorkspace(ws);
    writeWorktreeSeed(ws);
    expect(existsSync(worktreeSeedPath(ws.path))).toBe(true);
    expect(existsSync(path.join(ws.path, ".zeros"))).toBe(false);
  });

  it("seedFromDisk recovers a workspace from its app-data seed", () => {
    const ws = makeWs(root);
    insertWorkspace(ws);
    writeWorktreeSeed(ws);
    deleteWorkspaceRow(ws.id); // simulate a lost DB row (worktree + seed remain)
    expect(getWorkspaceById(ws.id)).toBeNull();
    expect(seedFromDisk().inserted).toBe(1);
    expect(getWorkspaceById(ws.id)?.path).toBe(ws.path);
  });

  it("does NOT resurrect a workspace whose worktree folder is gone", () => {
    const ws = makeWs(root);
    insertWorkspace(ws);
    writeWorktreeSeed(ws);
    deleteWorkspaceRow(ws.id);
    rmSync(ws.path, { recursive: true, force: true }); // worktree deleted
    expect(seedFromDisk().inserted).toBe(0);
    expect(getWorkspaceById(ws.id)).toBeNull();
  });

  it("removeWorktreeSeed deletes the app-data seed", () => {
    const ws = makeWs(root);
    writeWorktreeSeed(ws);
    expect(existsSync(worktreeSeedPath(ws.path))).toBe(true);
    removeWorktreeSeed(ws.path);
    expect(existsSync(worktreeSeedPath(ws.path))).toBe(false);
  });

  it("migrateLegacyWorktreeSeeds moves an in-tree .zeros seed to app-data and removes .zeros", () => {
    const ws = makeWs(root);
    insertWorkspace(ws);
    const legacyDir = path.join(ws.path, ".zeros"); // OLD in-tree seed
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, "workspace.json"), JSON.stringify(ws), "utf8");
    expect(existsSync(worktreeSeedPath(ws.path))).toBe(false);

    expect(migrateLegacyWorktreeSeeds().migrated).toBe(1);
    expect(existsSync(worktreeSeedPath(ws.path))).toBe(true); // moved to app-data
    expect(existsSync(legacyDir)).toBe(false); // in-tree .zeros removed
  });
});

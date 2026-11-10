// Workspace numbers (`w-<n>`) are permanent within an owner, and a workspace
// is "Untitled" until one of its chats is first named. These drive the real
// SQLite schema (migration 46), the engine's insert/recovery/owner-repair
// paths and the floor file that survives a lost database.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteWorkspaceRow,
  getWorkspaceById,
  insertWorkspace,
  reassignLocalWorkspaceOrganization,
  seedFromDisk,
  setStateRootForTesting,
  worktreesRoot,
  writeWorktreeSeed,
} from "../../git/state";
import type { Workspace } from "../../git/types";
import { closeZerosDb, openZerosDb } from "../database";
import {
  adoptWorkspaceTitlesFromChats,
  bulkUpsertChats,
  coerceChatRow,
  setChatWorkspaceResolver,
  upsertChat,
  type ChatRow,
} from "../chats";
import { reserveWorkspaceNumber, WORKSPACE_NUMBER_RESERVATION_TTL_MS } from "../workspace-numbers";

let root: string;
let serial = 0;

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  serial += 1;
  const id = overrides.id ?? `ws_${String(serial).padStart(6, "0")}-test`;
  const wsPath = overrides.path ?? path.join(worktreesRoot(), "repo", id);
  mkdirSync(wsPath, { recursive: true });
  return {
    id,
    repoSlug: "repo",
    repoRoot: path.join(root, "repo"),
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: wsPath,
    status: "in-progress",
    createdAt: serial,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    ...overrides,
  };
}

function chat(id: string, folder: string, title: string, extra: Partial<ChatRow> = {}): ChatRow {
  return { ...coerceChatRow({ id, folder, title, createdAt: ++serial, updatedAt: serial })!, ...extra };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "zeros-workspace-numbers-"));
  setStateRootForTesting(root);
});

afterEach(() => {
  setChatWorkspaceResolver(null);
  setStateRootForTesting(null);
  rmSync(root, { recursive: true, force: true });
});

describe("workspace numbers", () => {
  it("numbers Local workspaces 1, 2, 3 and never reuses a deleted number", () => {
    const a = workspace();
    const b = workspace();
    insertWorkspace(a);
    insertWorkspace(b);
    expect(getWorkspaceById(a.id)?.number).toBe(1);
    expect(getWorkspaceById(b.id)?.number).toBe(2);

    deleteWorkspaceRow(b.id);
    deleteWorkspaceRow(a.id);
    const c = workspace();
    insertWorkspace(c);
    expect(getWorkspaceById(c.id)?.number).toBe(3);
  });

  it("keeps a separate sequence per owner", () => {
    const local = workspace();
    const organization = workspace({ organizationId: "org-1" });
    insertWorkspace(local);
    insertWorkspace(organization);
    expect(getWorkspaceById(local.id)?.number).toBe(1);
    expect(getWorkspaceById(organization.id)?.number).toBe(1);
  });

  it("inserts the number prepare reserved, and the reservation is consumed", () => {
    const later = workspace();
    const reserved = reserveWorkspaceNumber(later.id, null);
    expect(reserveWorkspaceNumber(later.id, null)).toBe(reserved);
    // Another workspace created meanwhile does not take the announced number.
    const other = workspace();
    insertWorkspace(other);
    insertWorkspace(later);
    expect(getWorkspaceById(later.id)?.number).toBe(reserved);
    expect(getWorkspaceById(other.id)?.number).toBe(reserved + 1);
    const held = openZerosDb()
      .prepare("SELECT COUNT(*) AS n FROM workspace_number_reservations")
      .get() as { n: number };
    expect(held.n).toBe(0);
  });

  it("spends an abandoned reservation's number instead of handing it out again", () => {
    const abandoned = reserveWorkspaceNumber("ws_abandon-test", null, 1_000);
    const next = reserveWorkspaceNumber("ws_after-test", null, 1_000 + WORKSPACE_NUMBER_RESERVATION_TTL_MS + 1);
    expect(next).toBe(abandoned + 1);
    const held = openZerosDb()
      .prepare("SELECT workspace_id FROM workspace_number_reservations")
      .all() as { workspace_id: string }[];
    expect(held.map((row) => row.workspace_id)).toEqual(["ws_after-test"]);
  });

  it("continues after a lost database while the floor beside it survives", () => {
    for (let i = 0; i < 3; i++) insertWorkspace(workspace());
    const last = workspace();
    insertWorkspace(last);
    expect(getWorkspaceById(last.id)?.number).toBe(4);
    const floor = JSON.parse(readFileSync(path.join(root, "workspace-number-floor.json"), "utf8"));
    expect(floor).toEqual({ version: 1, owners: { "": 4 } });

    closeZerosDb();
    rmSync(path.join(root, "zeros.db"), { force: true });
    rmSync(path.join(root, "zeros.db-wal"), { force: true });
    rmSync(path.join(root, "zeros.db-shm"), { force: true });
    const fresh = workspace();
    insertWorkspace(fresh);
    expect(getWorkspaceById(fresh.id)?.number).toBe(5);
  });

  it("starts again at 1 only when the database and its floor are both gone", () => {
    insertWorkspace(workspace());
    insertWorkspace(workspace());
    closeZerosDb();
    for (const file of ["zeros.db", "zeros.db-wal", "zeros.db-shm", "workspace-number-floor.json"])
      rmSync(path.join(root, file), { force: true });
    const fresh = workspace();
    insertWorkspace(fresh);
    expect(getWorkspaceById(fresh.id)?.number).toBe(1);
  });

  it("ignores a malformed floor without blocking the database", () => {
    closeZerosDb();
    writeFileSync(path.join(root, "workspace-number-floor.json"), "{not json");
    const fresh = workspace();
    insertWorkspace(fresh);
    expect(getWorkspaceById(fresh.id)?.number).toBe(1);
    expect(JSON.parse(readFileSync(path.join(root, "workspace-number-floor.json"), "utf8"))).toEqual({
      version: 1,
      owners: { "": 1 },
    });
  });

  it("recovers a seed with its number and title, and numbers a colliding seed anew", () => {
    const kept = workspace();
    insertWorkspace(kept);
    openZerosDb().prepare("UPDATE workspaces SET title = 'Add canvas zoom' WHERE id = ?").run(kept.id);
    writeWorktreeSeed(getWorkspaceById(kept.id)!);
    const seedFile = path.join(root, ".appdata", "worktrees");
    expect(existsSync(seedFile)).toBe(true);

    deleteWorkspaceRow(kept.id);
    expect(seedFromDisk().inserted).toBe(1);
    expect(getWorkspaceById(kept.id)).toMatchObject({ number: 1, title: "Add canvas zoom" });

    // A seed claiming a number another row already holds gets the next one.
    const squatter = workspace();
    writeWorktreeSeed({ ...squatter, number: 1 });
    expect(seedFromDisk().inserted).toBe(1);
    expect(getWorkspaceById(squatter.id)?.number).toBe(2);
  });

  it("writes the database's number into the seed of a row inserted without one", () => {
    const adopted = workspace();
    insertWorkspace(adopted);
    writeWorktreeSeed(adopted);
    deleteWorkspaceRow(adopted.id);
    seedFromDisk();
    expect(getWorkspaceById(adopted.id)?.number).toBe(1);
  });

  it("renumbers workspaces moved to another owner after that owner's own", () => {
    const local = workspace();
    insertWorkspace(local);
    const first = workspace({ organizationId: "legacy-personal" });
    const second = workspace({ organizationId: "legacy-personal" });
    insertWorkspace(first);
    insertWorkspace(second);
    expect(reassignLocalWorkspaceOrganization("legacy-personal", null).changes).toBe(2);
    expect(getWorkspaceById(local.id)?.number).toBe(1);
    expect(getWorkspaceById(first.id)).toMatchObject({ organizationId: null, number: 2 });
    expect(getWorkspaceById(second.id)).toMatchObject({ organizationId: null, number: 3 });
  });
});

describe("workspace titles", () => {
  beforeEach(() => {
    setChatWorkspaceResolver((folder) => getWorkspaceByFolder(folder));
  });

  function getWorkspaceByFolder(folder: string): string | null {
    const row = openZerosDb().prepare("SELECT id FROM workspaces WHERE path = ?").get(folder) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  it("is Untitled until a chat is first named, then keeps that name", () => {
    const ws = workspace();
    insertWorkspace(ws);
    expect(getWorkspaceById(ws.id)?.title).toBeNull();

    expect(upsertChat(chat("c1", ws.path, "Untitled"))).toBeNull();
    expect(upsertChat(chat("c2", ws.path, "New chat"))).toBeNull();
    expect(getWorkspaceById(ws.id)?.title).toBeNull();

    expect(upsertChat(chat("c1", ws.path, "  Add   canvas zoom "))).toBe(ws.id);
    expect(getWorkspaceById(ws.id)?.title).toBe("Add canvas zoom");

    // Later names never rename the workspace.
    expect(upsertChat(chat("c1", ws.path, "Renamed later"))).toBeNull();
    expect(upsertChat(chat("c2", ws.path, "Second chat"))).toBeNull();
    expect(getWorkspaceById(ws.id)?.title).toBe("Add canvas zoom");
  });

  it("is not named by a terminal tab or an archived chat", () => {
    const ws = workspace();
    insertWorkspace(ws);
    upsertChat(chat("t1", ws.path, "zsh", { kind: "terminal" }));
    upsertChat(chat("a1", ws.path, "Archived idea", { archived: true }));
    expect(getWorkspaceById(ws.id)?.title).toBeNull();
  });

  it("reports workspaces titled by a bulk save", () => {
    const one = workspace();
    const two = workspace();
    insertWorkspace(one);
    insertWorkspace(two);
    expect(bulkUpsertChats([chat("b1", one.path, "Fix login"), chat("b2", two.path, "Untitled")])).toEqual([one.id]);
  });

  it("names older workspaces from their earliest named chat at startup", () => {
    const ws = workspace();
    insertWorkspace(ws);
    // Chats saved before workspaces had titles.
    setChatWorkspaceResolver(null);
    upsertChat(chat("old-2", ws.path, "Untitled"));
    upsertChat(chat("old-1", ws.path, "Earliest name"));
    upsertChat(chat("old-3", ws.path, "Later name"));
    openZerosDb().prepare("UPDATE chats SET workspace_id = ?").run(ws.id);
    expect(getWorkspaceById(ws.id)?.title).toBeNull();

    expect(adoptWorkspaceTitlesFromChats()).toEqual([ws.id]);
    expect(getWorkspaceById(ws.id)?.title).toBe("Earliest name");
    expect(adoptWorkspaceTitlesFromChats()).toEqual([]);
  });
});

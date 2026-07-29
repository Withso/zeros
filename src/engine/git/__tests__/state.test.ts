import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  advanceLifecycle,
  closeState,
  getDetachState,
  getWorkspaceById,
  getWorkspaceMeta,
  insertWorkspace,
  listWorkspaces,
  setDetachState,
  setStateRootForTesting,
  setWorkspaceMeta,
  updateWorkspace,
  deleteWorkspaceRow,
  clearDetachState,
} from "../state";
import type { Workspace } from "../types";

function sampleWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const now = Date.now();
  const id = overrides.id ?? "ws_aaa111-foo";
  return {
    id,
    repoSlug: "test-repo",
    repoRoot: "/tmp/test-repo",
    // Derived from the id, not a constant: (repo_slug, lower(branch)) is
    // UNIQUE since migration 24, so fixtures in one repo that differ only by
    // id must still differ by branch.
    branch: `zeros/${id}`,
    baseBranch: "main",
    path: `/tmp/worktrees/test-repo/${id}`,
    status: "in-progress",
    createdAt: now,
    archivedAt: null,
    stashRef: null,
    archivedHead: null,
    archiveSnapshot: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: now,
    setupState: null,
    ...overrides,
  };
}

describe("state", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(tmpdir(), "zeros-state-test-"));
    setStateRootForTesting(stateRoot);
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(stateRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("insert + get round-trips a workspace", () => {
    const ws = sampleWorkspace();
    insertWorkspace(ws);
    const got = getWorkspaceById(ws.id);
    expect(got).toEqual(ws);
  });

  // Workspace names are allocated colours with no random tail (2026-07-29),
  // so the DB — not the improbability of a hex collision — is what keeps them
  // unique. See migration 24.
  describe("workspace name uniqueness", () => {
    it("rejects a duplicate branch within one repo", () => {
      insertWorkspace(
        sampleWorkspace({
          id: "ws_1",
          repoSlug: "alpha",
          branch: "zeros/Cream",
        }),
      );
      expect(() =>
        insertWorkspace(
          sampleWorkspace({
            id: "ws_2",
            repoSlug: "alpha",
            branch: "zeros/Cream",
          }),
        ),
      ).toThrow(/UNIQUE/i);
    });

    it("allows the SAME name in a different repo", () => {
      // The whole point of scoping to repo_slug: "Cream" in two projects is
      // two unrelated workspaces, with separate refs and separate folders.
      insertWorkspace(
        sampleWorkspace({
          id: "ws_1",
          repoSlug: "alpha",
          branch: "zeros/Cream",
        }),
      );
      insertWorkspace(
        sampleWorkspace({
          id: "ws_2",
          repoSlug: "beta",
          branch: "zeros/Cream",
        }),
      );
      expect(
        listWorkspaces({ repoSlug: "alpha" }).map((w) => w.branch),
      ).toEqual(["zeros/Cream"]);
      expect(listWorkspaces({ repoSlug: "beta" }).map((w) => w.branch)).toEqual(
        ["zeros/Cream"],
      );
    });

    it("treats names differing only by case as the same name", () => {
      // macOS folds case and git loose refs are files, so zeros/Cream and
      // zeros/cream are ONE ref on the machines this ships to.
      insertWorkspace(
        sampleWorkspace({
          id: "ws_1",
          repoSlug: "alpha",
          branch: "zeros/Cream",
        }),
      );
      expect(() =>
        insertWorkspace(
          sampleWorkspace({
            id: "ws_2",
            repoSlug: "alpha",
            branch: "zeros/cream",
          }),
        ),
      ).toThrow(/UNIQUE/i);
    });

    it("frees the name once the row is deleted", () => {
      insertWorkspace(
        sampleWorkspace({
          id: "ws_1",
          repoSlug: "alpha",
          branch: "zeros/Cream",
        }),
      );
      deleteWorkspaceRow("ws_1");
      expect(() =>
        insertWorkspace(
          sampleWorkspace({
            id: "ws_2",
            repoSlug: "alpha",
            branch: "zeros/Cream",
          }),
        ),
      ).not.toThrow();
    });

    it("keeps the name reserved while the workspace is merely ARCHIVED", () => {
      // An archived workspace still owns its name: its branch and folder
      // usually still exist, and restoring it must not find a squatter.
      insertWorkspace(
        sampleWorkspace({
          id: "ws_1",
          repoSlug: "alpha",
          branch: "zeros/Cream",
          archivedAt: Date.now(),
        }),
      );
      expect(() =>
        insertWorkspace(
          sampleWorkspace({
            id: "ws_2",
            repoSlug: "alpha",
            branch: "zeros/Cream",
          }),
        ),
      ).toThrow(/UNIQUE/i);
    });
  });

  it("listWorkspaces filters by repoSlug", () => {
    insertWorkspace(sampleWorkspace({ id: "ws_1", repoSlug: "alpha" }));
    insertWorkspace(sampleWorkspace({ id: "ws_2", repoSlug: "beta" }));
    insertWorkspace(sampleWorkspace({ id: "ws_3", repoSlug: "alpha" }));
    const got = listWorkspaces({ repoSlug: "alpha" });
    expect(got.map((w) => w.id).sort()).toEqual(["ws_1", "ws_3"]);
  });

  it("listWorkspaces filters by status", () => {
    insertWorkspace(sampleWorkspace({ id: "ws_1", status: "in-progress" }));
    insertWorkspace(sampleWorkspace({ id: "ws_2", status: "in-review" }));
    insertWorkspace(sampleWorkspace({ id: "ws_3", status: "done" }));
    const got = listWorkspaces({ status: "in-review" });
    expect(got.map((w) => w.id)).toEqual(["ws_2"]);
  });

  it("listWorkspaces filters by archived flag (orthogonal to status)", () => {
    insertWorkspace(
      sampleWorkspace({ id: "ws_1", status: "in-progress", archivedAt: null }),
    );
    insertWorkspace(
      sampleWorkspace({ id: "ws_2", status: "done", archivedAt: Date.now() }),
    );
    expect(listWorkspaces({ archived: true }).map((w) => w.id)).toEqual([
      "ws_2",
    ]);
    expect(listWorkspaces({ archived: false }).map((w) => w.id)).toEqual([
      "ws_1",
    ]);
  });

  it("updateWorkspace patches fields", () => {
    const ws = sampleWorkspace();
    insertWorkspace(ws);
    updateWorkspace(ws.id, {
      status: "in-review",
      prNumber: 42,
      prState: "draft",
    });
    const got = getWorkspaceById(ws.id);
    expect(got?.status).toBe("in-review");
    expect(got?.prNumber).toBe(42);
    expect(got?.prState).toBe("draft");
    expect(got?.branch).toBe(ws.branch); // unchanged
  });

  it("advanceLifecycle advances, but respects the cancelled + archived guards", () => {
    // Normal auto-advance: in-progress → in-review.
    insertWorkspace(sampleWorkspace({ id: "adv_1", status: "in-progress" }));
    advanceLifecycle("adv_1", "in-review");
    expect(getWorkspaceById("adv_1")?.status).toBe("in-review");

    // Cancelled is sticky — an auto-transition never revives it.
    insertWorkspace(sampleWorkspace({ id: "adv_2", status: "cancelled" }));
    advanceLifecycle("adv_2", "done");
    expect(getWorkspaceById("adv_2")?.status).toBe("cancelled");

    // Archived rows are frozen — status is preserved through auto-transitions.
    insertWorkspace(
      sampleWorkspace({
        id: "adv_3",
        status: "in-review",
        archivedAt: Date.now(),
      }),
    );
    advanceLifecycle("adv_3", "done");
    expect(getWorkspaceById("adv_3")?.status).toBe("in-review");
  });

  it("deleteWorkspaceRow cascades to workspace_meta", () => {
    const ws = sampleWorkspace();
    insertWorkspace(ws);
    setWorkspaceMeta(ws.id, "foo", "bar");
    expect(getWorkspaceMeta(ws.id, "foo")).toBe("bar");
    deleteWorkspaceRow(ws.id);
    expect(getWorkspaceMeta(ws.id, "foo")).toBeNull();
  });

  it("workspace_meta upserts on conflict", () => {
    const ws = sampleWorkspace();
    insertWorkspace(ws);
    setWorkspaceMeta(ws.id, "k", "v1");
    setWorkspaceMeta(ws.id, "k", "v2");
    expect(getWorkspaceMeta(ws.id, "k")).toBe("v2");
  });

  it("detach_state set / get / clear", () => {
    expect(getDetachState()).toBeNull();
    setDetachState({
      workspaceId: "ws_1",
      preRootHead: "deadbeef",
      checkpointSha: null,
      startedAt: 1000,
      lockfilePid: 9999,
    });
    const got = getDetachState();
    expect(got?.workspaceId).toBe("ws_1");
    expect(got?.preRootHead).toBe("deadbeef");
    clearDetachState();
    expect(getDetachState()).toBeNull();
  });

  it("detach_state enforces singleton via id=1 conflict", () => {
    setDetachState({
      workspaceId: "ws_a",
      preRootHead: "aaa",
      checkpointSha: null,
      startedAt: 1,
      lockfilePid: 100,
    });
    setDetachState({
      workspaceId: "ws_b",
      preRootHead: "bbb",
      checkpointSha: "ccc",
      startedAt: 2,
      lockfilePid: 200,
    });
    const got = getDetachState();
    expect(got?.workspaceId).toBe("ws_b");
    expect(got?.checkpointSha).toBe("ccc");
  });
});

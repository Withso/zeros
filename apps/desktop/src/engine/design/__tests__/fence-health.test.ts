import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearDesignFenceFailure,
  designFenceStartBlock,
  recordDesignFenceFailure,
} from "../fence-health";
import {
  closeState,
  insertWorkspace,
  setStateRootForTesting,
  setWorkspaceMeta,
} from "../../git/state";
import type { Workspace } from "../../git/types";

function workspace(root: string): Workspace {
  const now = Date.now();
  return {
    id: "ws_fence-health",
    repoSlug: "repo",
    repoRoot: path.join(root, "repo"),
    branch: "zeros/Fence",
    baseBranch: "main",
    path: path.join(root, "workspace"),
    kind: "code",
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
  };
}

describe("design fence health", () => {
  let root: string;
  let ws: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-fence-health-"));
    setStateRootForTesting(root);
    ws = workspace(root);
    insertWorkspace(ws);
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it("does not block Zeros processes on obsolete cross-application ACL state", () => {
    recordDesignFenceFailure(ws.path, new Error("chmod denied"));

    expect(designFenceStartBlock(ws.id)).toBeNull();
  });

  it("clears the block only after a successful fence reconciliation", () => {
    recordDesignFenceFailure(ws.path, new Error("first failure"));
    clearDesignFenceFailure(ws.path);

    expect(designFenceStartBlock(ws.id)).toBeNull();
  });

  it("ignores malformed historical ACL health records", () => {
    recordDesignFenceFailure(ws.path, new Error("initial failure"));
    setWorkspaceMeta(ws.id, "design.fence.health.v1", "not-json");

    expect(designFenceStartBlock(ws.id)).toBeNull();
  });
});

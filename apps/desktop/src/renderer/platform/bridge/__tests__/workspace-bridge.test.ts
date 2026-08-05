import { describe, it, expect } from "vitest";
import {
  requestWorkspaceList,
  bridgeFileTree,
  bridgeGitStatus,
  bridgeGitChangeCounts,
  bridgeGitChangeLineCounts,
  bridgeGitDiff,
  bridgeGitFetch,
  bridgeGitLog,
  bridgeGitBranches,
  bridgeGitCommit,
  bridgeGitPull,
  bridgeGitPush,
  bridgeGitRebase,
  bridgeGitShow,
  bridgeGitStage,
  bridgeGhPrCreate,
  bridgeGhPrMarkReady,
  bridgeGhPrMerge,
  bridgeWorkspaceArchive,
  bridgeWorkspaceCreateFromBranchStatus,
  bridgeWorkspaceDelete,
  bridgeWorkspaceLifecycleStatus,
  bridgeWorkspaceRestore,
} from "../workspace-bridge";
import type { RuntimeClient } from "../ws-client";

/** Minimal RuntimeClient stand-in: request() returns a canned message and
 *  records the outgoing op so we can assert the wire shape. */
function fakeBridge(resp: unknown, seen: { op?: string; type?: string } = {}) {
  return {
    request: async (msg: { type: string; op?: string }) => {
      seen.type = msg.type;
      seen.op = msg.op;
      return resp;
    },
  } as unknown as RuntimeClient;
}

describe("requestWorkspaceList", () => {
  it("sends a workspace.list WORKSPACE_REQUEST and returns the workspaces", async () => {
    const seen: { op?: string; type?: string } = {};
    const workspaces = [
      { id: "a", path: "/root/.zeros/worktrees/repo/a" },
      { id: "b", path: "/root/.zeros/worktrees/repo/b" },
    ];
    const out = await requestWorkspaceList(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "workspace.list",
          result: { workspaces },
        },
        seen,
      ),
    );
    expect(seen.type).toBe("WORKSPACE_REQUEST");
    expect(seen.op).toBe("workspace.list");
    expect(out).toEqual(workspaces);
  });

  it("keeps design rows out of the coding-agent workspace resolver", async () => {
    const code = {
      id: "code",
      kind: "code" as const,
      path: "/root/zeros/workspaces/repo/code",
    };
    const design = {
      id: "design",
      kind: "design" as const,
      path: "/root/zeros/design workspaces/repo/design",
    };
    const out = await requestWorkspaceList(
      fakeBridge({
        type: "WORKSPACE_RESPONSE",
        op: "workspace.list",
        result: { workspaces: [code, design] },
      }),
    );
    expect(out).toEqual([code]);
  });

  it("returns [] when the result carries no workspaces array", async () => {
    const out = await requestWorkspaceList(
      fakeBridge({
        type: "WORKSPACE_RESPONSE",
        op: "workspace.list",
        result: {},
      }),
    );
    expect(out).toEqual([]);
  });

  it("throws with the engine message on a WORKSPACE_ERROR", async () => {
    await expect(
      requestWorkspaceList(
        fakeBridge({
          type: "WORKSPACE_ERROR",
          op: "workspace.list",
          code: "WORKSPACE_OP_FAILED",
          message: "engine exploded",
        }),
      ),
    ).rejects.toThrow("engine exploded");
  });
});

describe("workspace-bridge read ops", () => {
  it("bridgeFileTree sends file.tree and unwraps { files }", async () => {
    const seen: { op?: string } = {};
    const out = await bridgeFileTree(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "file.tree",
          result: { files: ["a", "b"] },
        },
        seen,
      ),
      "ws1",
      100,
    );
    expect(seen.op).toBe("file.tree");
    expect(out).toEqual(["a", "b"]);
  });

  it("bridgeGitStatus sends git.status and returns the result", async () => {
    const seen: { op?: string } = {};
    const status = {
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      conflictState: null,
    };
    const out = await bridgeGitStatus(
      fakeBridge(
        { type: "WORKSPACE_RESPONSE", op: "git.status", result: status },
        seen,
      ),
      "ws1",
    );
    expect(seen.op).toBe("git.status");
    expect(out).toEqual(status);
  });

  it("bridgeGitChangeCounts sends git.changeCounts and returns all four totals", async () => {
    const seen: { op?: string } = {};
    const counts = { all: 7, uncommitted: 7, staged: 5, unstaged: 5 };
    const out = await bridgeGitChangeCounts(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "git.changeCounts",
          result: counts,
        },
        seen,
      ),
      "ws1",
    );
    expect(seen.op).toBe("git.changeCounts");
    expect(out).toEqual(counts);
  });

  it("bridgeGitChangeLineCounts sends git.changeLineCounts and returns the pair", async () => {
    const seen: { op?: string } = {};
    const out = await bridgeGitChangeLineCounts(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "git.changeLineCounts",
          result: { additions: 1500, deletions: 240 },
        },
        seen,
      ),
      "ws1",
    );
    expect(seen.op).toBe("git.changeLineCounts");
    expect(out).toEqual({ additions: 1500, deletions: 240 });
  });

  it("reads an engine that predates git.changeLineCounts as no changes", async () => {
    // An older engine answers the unknown op with an empty result rather than
    // an error; that must not reach a tab as "+NaN".
    const out = await bridgeGitChangeLineCounts(
      fakeBridge({
        type: "WORKSPACE_RESPONSE",
        op: "git.changeLineCounts",
        result: {},
      }),
      "ws1",
    );
    expect(out).toEqual({ additions: 0, deletions: 0 });
  });

  it("bridgeGitDiff sends git.diff and returns hunks", async () => {
    const res = { hunks: [{ filePath: "a" }], patch: "p" };
    const out = await bridgeGitDiff(
      fakeBridge({ type: "WORKSPACE_RESPONSE", op: "git.diff", result: res }),
      { workspaceId: "ws1", filePath: "a", against: "HEAD" },
    );
    expect(out).toEqual(res);
  });

  it("bridgeGitCommit sends git.commit (a WRITE op) and returns the result", async () => {
    const seen: { op?: string } = {};
    const out = await bridgeGitCommit(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "git.commit",
          result: { sha: "abc", branch: "main" },
        },
        seen,
      ),
      { workspaceId: "ws1", message: "hi" },
    );
    expect(seen.op).toBe("git.commit");
    expect(out).toEqual({ sha: "abc", branch: "main" });
  });

  it("bridgeGitShow sends git.show and returns { files, patch }", async () => {
    const seen: { op?: string } = {};
    const res = { files: [{ path: "a" }], patch: "diff --git a/a b/a\n" };
    const out = await bridgeGitShow(
      fakeBridge(
        { type: "WORKSPACE_RESPONSE", op: "git.show", result: res },
        seen,
      ),
      { workspaceId: "ws1", sha: "deadbeef" },
    );
    expect(seen.op).toBe("git.show");
    expect(out).toEqual(res);
  });

  it("a WORKSPACE_ERROR (e.g. APPROVAL_DENIED) on a write rejects", async () => {
    await expect(
      bridgeGitCommit(
        fakeBridge({
          type: "WORKSPACE_ERROR",
          op: "git.commit",
          code: "APPROVAL_DENIED",
          message: "host denied",
        }),
        { workspaceId: "ws1", message: "x" },
      ),
    ).rejects.toThrow("host denied");
  });

  it("preserves a WORKSPACE_ERROR code and remediation", async () => {
    const failure = bridgeGitCommit(
      fakeBridge({
        type: "WORKSPACE_ERROR",
        op: "git.commit",
        code: "GIT_COMMAND_FAILED",
        message: "commit failed",
        remediation: "Resolve the index conflict first.",
      }),
      { workspaceId: "ws1", message: "x" },
    );
    await expect(failure).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
      remediation: "Resolve the index conflict first.",
    });
  });

  it("bridgeGitLog unwraps { commits }; bridgeGitBranches unwraps { branches }", async () => {
    const log = await bridgeGitLog(
      fakeBridge({
        type: "WORKSPACE_RESPONSE",
        op: "git.log",
        result: { commits: [{ sha: "a" }] },
      }),
      { workspaceId: "ws1", limit: 10 },
    );
    expect(log).toEqual([{ sha: "a" }]);
    const branches = await bridgeGitBranches(
      fakeBridge({
        type: "WORKSPACE_RESPONSE",
        op: "git.branches",
        result: { branches: [{ name: "main" }] },
      }),
      "ws1",
    );
    expect(branches).toEqual([{ name: "main" }]);
  });
});

describe("workspace archive / restore bridge", () => {
  it("gives permanent deletion the long lifecycle timeout", async () => {
    let timeoutMs: number | undefined;
    const bridge = {
      request: async (
        _msg: { type: string; op?: string },
        timeout?: number,
      ) => {
        timeoutMs = timeout;
        return {
          type: "WORKSPACE_RESPONSE",
          op: "workspace.delete",
          result: { ok: true },
        };
      },
    } as unknown as RuntimeClient;
    await bridgeWorkspaceDelete(bridge, {
      workspaceId: "ws1",
      includeBranch: false,
    });
    expect(timeoutMs).toBe(60_000);
  });

  it("bridgeWorkspaceLifecycleStatus sends the exact local recovery probe", async () => {
    const seen: { op?: string; type?: string } = {};
    const result = {
      active: true,
      operation: "archive" as const,
      phase: "prepared",
      startedAt: 123,
    };
    await expect(
      bridgeWorkspaceLifecycleStatus(
        fakeBridge(
          {
            type: "WORKSPACE_RESPONSE",
            op: "workspace.lifecycleStatus",
            result,
          },
          seen,
        ),
        "ws1",
      ),
    ).resolves.toEqual(result);
    expect(seen).toEqual({
      type: "WORKSPACE_REQUEST",
      op: "workspace.lifecycleStatus",
    });
  });

  it("bridgeWorkspaceCreateFromBranchStatus sends the exact repo+branch recovery probe", async () => {
    const seen: { op?: string; type?: string } = {};
    const result = {
      active: true,
      operation: "create" as const,
      phase: null,
      startedAt: 123,
      workspace: null,
    };
    await expect(
      bridgeWorkspaceCreateFromBranchStatus(
        fakeBridge(
          {
            type: "WORKSPACE_RESPONSE",
            op: "workspace.createFromBranchStatus",
            result,
          },
          seen,
        ),
        {
          repoRoot: "/repo",
          repoSlug: "owner/repo",
          branchName: "feature/a",
        },
      ),
    ).resolves.toEqual(result);
    expect(seen).toEqual({
      type: "WORKSPACE_REQUEST",
      op: "workspace.createFromBranchStatus",
    });
  });

  it("bridgeWorkspaceArchive sends workspace.archive with the args + returns the result", async () => {
    const seen: { op?: string; type?: string } = {};
    const out = await bridgeWorkspaceArchive(
      fakeBridge(
        {
          type: "WORKSPACE_RESPONSE",
          op: "workspace.archive",
          result: { archivedAt: 123, stashRef: "deadbeef" },
        },
        seen,
      ),
      { workspaceId: "ws1", stashUncommitted: true },
    );
    expect(seen.type).toBe("WORKSPACE_REQUEST");
    expect(seen.op).toBe("workspace.archive");
    expect(out).toEqual({ archivedAt: 123, stashRef: "deadbeef" });
  });

  it("bridgeWorkspaceRestore sends workspace.restore + returns adaptations/conflicts", async () => {
    const seen: { op?: string; type?: string } = {};
    const result = {
      restoredAt: 456,
      conflicts: ["a.txt"],
      path: "/wt/ws1-2",
      branch: "zeros/foo-restored",
      adaptations: [
        'The original folder was in use, so the workspace was restored to "ws1-2".',
      ],
    };
    const out = await bridgeWorkspaceRestore(
      fakeBridge(
        { type: "WORKSPACE_RESPONSE", op: "workspace.restore", result },
        seen,
      ),
      { workspaceId: "ws1" },
    );
    expect(seen.op).toBe("workspace.restore");
    expect(out).toEqual(result);
  });

  it("propagates a WORKSPACE_ERROR from archive", async () => {
    await expect(
      bridgeWorkspaceArchive(
        fakeBridge({
          type: "WORKSPACE_ERROR",
          op: "workspace.archive",
          code: "VALIDATION_FAILED",
          message: "adopted worktree can't be archived",
        }),
        { workspaceId: "ws1" },
      ),
    ).rejects.toThrow("adopted worktree can't be archived");
  });
});

describe("git/gh write timeouts", () => {
  /** Like fakeBridge, but also captures the timeout passed to request() so we
   *  can pin each write helper's budget. */
  function timeoutBridge(
    op: string,
    result: unknown,
    seen: { timeoutMs?: number },
  ): RuntimeClient {
    return {
      request: async (
        _msg: { type: string; op?: string },
        timeout?: number,
      ) => {
        seen.timeoutMs = timeout;
        return { type: "WORKSPACE_RESPONSE", op, result };
      },
    } as unknown as RuntimeClient;
  }

  // Network-bound writes (push/pull/fetch/rebase + PR create/ready/merge) used
  // to ride the 10s workspaceOp default: a slow GitHub merge rejected with
  // "Request timeout" → "Couldn't merge PR" even though the merge landed.
  it.each([
    [
      "git.push",
      (b: RuntimeClient) => bridgeGitPush(b, { workspaceId: "ws1" }),
    ],
    [
      "git.pull",
      (b: RuntimeClient) =>
        bridgeGitPull(b, { workspaceId: "ws1", strategy: "rebase" }),
    ],
    [
      "git.fetch",
      (b: RuntimeClient) => bridgeGitFetch(b, { workspaceId: "ws1" }),
    ],
    [
      "git.rebase",
      (b: RuntimeClient) =>
        bridgeGitRebase(b, { workspaceId: "ws1", ontoBranch: "main" }),
    ],
    [
      "gh.prCreate",
      (b: RuntimeClient) =>
        bridgeGhPrCreate(b, { workspaceId: "ws1", title: "t", body: "b" }),
    ],
    [
      "gh.prMarkReady",
      (b: RuntimeClient) =>
        bridgeGhPrMarkReady(b, { workspaceId: "ws1", prNumber: 7 }),
    ],
    [
      "gh.prMerge",
      (b: RuntimeClient) =>
        bridgeGhPrMerge(b, {
          workspaceId: "ws1",
          prNumber: 7,
          method: "squash",
        }),
    ],
  ] as const)("network-bound %s gets the 60s budget", async (op, run) => {
    const seen: { timeoutMs?: number } = {};
    await run(timeoutBridge(op, {}, seen));
    expect(seen.timeoutMs).toBe(60_000);
  });

  // Local index writes never touch the network, but a huge working tree or
  // hook-heavy repo can outlive the 10s default — 30s is plenty.
  it.each([
    [
      "git.commit",
      (b: RuntimeClient) =>
        bridgeGitCommit(b, { workspaceId: "ws1", message: "m" }),
    ],
    [
      "git.stage",
      (b: RuntimeClient) =>
        bridgeGitStage(b, { workspaceId: "ws1", paths: [] }),
    ],
  ] as const)("local %s gets the 30s budget", async (op, run) => {
    const seen: { timeoutMs?: number } = {};
    await run(timeoutBridge(op, { sha: "s", branch: "b" }, seen));
    expect(seen.timeoutMs).toBe(30_000);
  });
});

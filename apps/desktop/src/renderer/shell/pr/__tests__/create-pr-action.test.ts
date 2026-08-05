import { describe, expect, it, vi } from "vitest";

import {
  AutoCommitBlockedError,
  AutoCommitFailedError,
  buildPullRequestDraft,
  createPullRequestForWorkspace,
  GithubAccessError,
  isPrAccessBlocked,
} from "../create-pr-action";

// The gate the Create PR control consults before it does ANYTHING expensive —
// including handing the agent a brief, which spends a whole turn (review,
// commit, push, `gh pr create`) on the same brokered credential this describes.
describe("isPrAccessBlocked", () => {
  it("refuses only a definite verdict", () => {
    expect(isPrAccessBlocked({ state: "blocked", code: "NOT_AUTHENTICATED" })).toBe(
      true,
    );
    expect(isPrAccessBlocked({ state: "ok" })).toBe(false);
  });

  // Offline, rate-limited, no bridge, or a probe that threw: none of these are
  // evidence about access, and refusing on them would ground a PR that would
  // have worked.
  it("lets an indeterminate or absent probe through", () => {
    expect(isPrAccessBlocked({ state: "unknown" })).toBe(false);
    expect(isPrAccessBlocked(null)).toBe(false);
    expect(isPrAccessBlocked(undefined)).toBe(false);
  });
});

const CLEAN_STATUS = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  conflictState: null,
} as const;

/** A dependency set whose worktree is clean unless a test dirties it. */
function deps(over: Partial<Parameters<typeof createPullRequestForWorkspace>[0]> = {}) {
  return {
    changeCounts: async () => ({ uncommitted: 0 }),
    status: async () => ({ ...CLEAN_STATUS }),
    stage: vi.fn(async () => {}),
    commit: vi.fn(async () => ({ sha: "abc1234" })),
    log: async () => [{ message: "Committed work" }],
    create: vi.fn(async () => ({ number: 42 })),
    ...over,
  };
}

const INPUT = {
  workspaceId: "ws-1",
  branch: "feature/github-auth",
  draft: false,
} as const;

describe("Create PR direct action", () => {
  it("calls the native PR operation on the clean-worktree path", async () => {
    const create = vi.fn(async () => ({ number: 42 }));
    const stage = vi.fn(async () => {});
    const commit = vi.fn(async () => ({ sha: "abc1234" }));
    const outcome = await createPullRequestForWorkspace(
      deps({
        stage,
        commit,
        create,
        log: async () => [
          { message: "Add authenticated Git transport\n\nDetails" },
          { message: "Prepare GitHub settings" },
        ],
      }),
      INPUT,
    );

    expect(stage).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      title: "Prepare GitHub settings",
      body:
        "## Summary\n\n- Add authenticated Git transport\n- Prepare GitHub settings",
      draft: false,
    });
    expect(outcome).toEqual({ result: { number: 42 }, committed: null });
  });

  // The product contract this whole module exists for: a pull request can only
  // carry committed work, so the button COMMITS the pending work rather than
  // refusing and sending the user off to do it by hand.
  it("commits uncommitted work instead of refusing to open the PR", async () => {
    const stage = vi.fn(async () => {});
    const commit = vi.fn(
      async (_args: { workspaceId: string; message: string }) => ({
        sha: "abc1234",
      }),
    );
    const create = vi.fn(async () => ({ number: 7 }));
    const outcome = await createPullRequestForWorkspace(
      deps({
        changeCounts: async () => ({ uncommitted: 2 }),
        status: async () => ({
          ...CLEAN_STATUS,
          unstaged: [{ path: "src/a.ts" }],
          untracked: ["notes.md"],
        }),
        stage,
        commit,
        create,
        log: async () => [{ message: "Update a.ts and notes.md" }],
      }),
      INPUT,
    );

    expect(stage).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      paths: [".", ":(exclude).zeros"],
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0]!.message).toMatch(/^Update notes.md and a.ts/);
    expect(create).toHaveBeenCalledOnce();
    expect(outcome.committed).toEqual({
      files: 2,
      subject: "Update notes.md and a.ts",
    });
    expect(outcome.result).toEqual({ number: 7 });
  });

  // A branch with NOTHING committed is the case the old refusal made impossible:
  // the log is empty until the button's own commit lands.
  it("opens a PR for a branch whose only commit is the one it just made", async () => {
    const commits: Array<{ message: string }> = [];
    const create = vi.fn(async () => ({ number: 9 }));
    const outcome = await createPullRequestForWorkspace(
      deps({
        changeCounts: async () => ({ uncommitted: 1 }),
        status: async () => ({ ...CLEAN_STATUS, untracked: ["src/new.ts"] }),
        commit: vi.fn(async () => {
          commits.push({ message: "Update new.ts" });
          return { sha: "abc1234" };
        }),
        log: async () => [...commits],
        create,
      }),
      INPUT,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Update new.ts" }),
    );
    expect(outcome.committed?.files).toBe(1);
  });

  it("reports the commit the moment it lands, before the PR round trip", async () => {
    const order: string[] = [];
    const onCommitted = vi.fn(() => order.push("committed"));
    await createPullRequestForWorkspace(
      deps({
        changeCounts: async () => ({ uncommitted: 1 }),
        status: async () => ({ ...CLEAN_STATUS, untracked: ["src/new.ts"] }),
        create: vi.fn(async () => {
          order.push("create");
          return { number: 3 };
        }),
        onCommitted,
      }),
      INPUT,
    );
    expect(order).toEqual(["committed", "create"]);
    expect(onCommitted).toHaveBeenCalledWith({
      files: 1,
      subject: "Update new.ts",
    });
  });

  // Regression: a GitHub App connected to some OTHER repository must not send
  // the user's work into a commit for a pull request that can never open.
  it("reports blocked GitHub access instead of committing anything", async () => {
    const stage = vi.fn(async () => {});
    const commit = vi.fn(async () => ({ sha: "abc1234" }));
    const create = vi.fn();
    await expect(
      createPullRequestForWorkspace(
        deps({
          changeCounts: async () => ({ uncommitted: 3 }),
          status: async () => ({ ...CLEAN_STATUS, unstaged: [{ path: "a.ts" }] }),
          stage,
          commit,
          create,
          access: async () => ({
            state: "blocked" as const,
            connected: true,
            code: "GITHUB_REPO_NOT_INSTALLED",
            message: "This repository is not available to the connection.",
          }),
        }),
        INPUT,
      ),
    ).rejects.toBeInstanceOf(GithubAccessError);
    expect(stage).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // An offline or rate-limited probe is not evidence about access, so it must
  // never ground work that would have succeeded.
  it("treats an indeterminate or failed probe as no verdict", async () => {
    for (const access of [
      async () => ({ state: "unknown" as const }),
      async () => {
        throw new Error("probe exploded");
      },
    ]) {
      const create = vi.fn(async () => ({ number: 1 }));
      await createPullRequestForWorkspace(
        deps({
          changeCounts: async () => ({ uncommitted: 1 }),
          status: async () => ({ ...CLEAN_STATUS, unstaged: [{ path: "a.ts" }] }),
          create,
          access,
        }),
        INPUT,
      );
      expect(create).toHaveBeenCalledOnce();
    }
  });

  // The probe overlaps the create instead of gating it: awaiting it on a clean
  // worktree would add a GitHub round trip to the path that works.
  it("does not wait on the access probe when there is nothing uncommitted", async () => {
    const access = vi.fn(async () => ({ state: "ok" as const }));
    await createPullRequestForWorkspace(deps({ access }), INPUT);
    expect(access).not.toHaveBeenCalled();
  });

  it("refuses to commit a tree with unresolved conflicts", async () => {
    const commit = vi.fn();
    const create = vi.fn();
    await expect(
      createPullRequestForWorkspace(
        deps({
          changeCounts: async () => ({ uncommitted: 2 }),
          status: async () => ({
            ...CLEAN_STATUS,
            conflicted: [{ path: "src/a.ts" }],
            conflictState: "merge" as const,
          }),
          commit,
          create,
        }),
        INPUT,
      ),
    ).rejects.toBeInstanceOf(AutoCommitBlockedError);
    expect(commit).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // The counts and the sweep both skip `.zeros`, but they are read a moment
  // apart — and an agent can clean the tree in between. A commit with an empty
  // staged tree is the engine's VALIDATION_FAILED, not a reason to lose the PR.
  it("still opens the PR when the tree went clean before the commit ran", async () => {
    const create = vi.fn(async () => ({ number: 5 }));
    const outcome = await createPullRequestForWorkspace(
      deps({
        changeCounts: async () => ({ uncommitted: 1 }),
        status: async () => ({ ...CLEAN_STATUS, unstaged: [{ path: "a.ts" }] }),
        commit: vi.fn(async () => {
          throw {
            code: "VALIDATION_FAILED",
            message: "Nothing to commit — staged tree is empty",
          };
        }),
        create,
      }),
      INPUT,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(outcome.committed).toBeNull();
  });

  // Anything else the commit can fail with (a rejecting pre-commit hook, an
  // index lock, a missing git identity) is a real failure the user must see —
  // wrapped, because the engine's own sentence is the entire `git commit -m
  // <generated message>` argv and would be shown verbatim in a toast.
  it("wraps a genuine commit failure and never opens a PR without the work", async () => {
    const create = vi.fn();
    const reason = {
      code: "GIT_COMMAND_FAILED",
      message: "git commit -m Update a.ts\n\nCommitted by Zeros… failed",
    };
    await expect(
      createPullRequestForWorkspace(
        deps({
          changeCounts: async () => ({ uncommitted: 1 }),
          status: async () => ({ ...CLEAN_STATUS, unstaged: [{ path: "a.ts" }] }),
          commit: vi.fn(async () => {
            throw reason;
          }),
          create,
        }),
        INPUT,
      ),
    ).rejects.toMatchObject({ name: "AutoCommitFailedError", reason });
    expect(create).not.toHaveBeenCalled();
  });

  it("wraps a failed sweep the same way as a failed commit", async () => {
    const commit = vi.fn();
    await expect(
      createPullRequestForWorkspace(
        deps({
          changeCounts: async () => ({ uncommitted: 1 }),
          status: async () => ({ ...CLEAN_STATUS, unstaged: [{ path: "a.ts" }] }),
          stage: vi.fn(async () => {
            throw new Error("index.lock exists");
          }),
          commit,
        }),
        INPUT,
      ),
    ).rejects.toBeInstanceOf(AutoCommitFailedError);
    expect(commit).not.toHaveBeenCalled();
  });

  // Only `.zeros` was dirty: the count excludes it, so this cannot normally
  // happen — but the sweep must never commit a tree it has nothing visible for.
  it("skips the commit when every pending path is internal", async () => {
    const commit = vi.fn();
    const create = vi.fn(async () => ({ number: 2 }));
    const outcome = await createPullRequestForWorkspace(
      deps({
        changeCounts: async () => ({ uncommitted: 1 }),
        status: async () => ({
          ...CLEAN_STATUS,
          unstaged: [{ path: ".zeros/settings.toml" }],
        }),
        commit,
        create,
      }),
      INPUT,
    );
    expect(commit).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(outcome.committed).toBeNull();
  });

  it("derives a readable fallback title from the branch", () => {
    expect(buildPullRequestDraft([], "zeros/fix-github-auth")).toEqual({
      title: "Fix github auth",
      body: "## Summary\n\n- Fix github auth",
    });
  });

  // gh.prCreate validates `body` as a required non-empty string, so a blank
  // body is not a cosmetic detail — it fails the request.
  it("never produces an empty body the engine would reject", () => {
    for (const commits of [[], [{ message: "" }], [{ message: "\n\n" }]]) {
      expect(buildPullRequestDraft(commits, "wip").body.length).toBeGreaterThan(
        0,
      );
    }
  });
});

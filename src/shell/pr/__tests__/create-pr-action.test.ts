import { describe, expect, it, vi } from "vitest";

import {
  buildPullRequestDraft,
  createPullRequestFromCommittedChanges,
  GithubAccessError,
  isPrAccessBlocked,
  UncommittedPullRequestError,
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

describe("Create PR direct action", () => {
  it("calls the native PR operation on the default committed-changes path", async () => {
    const create = vi.fn(async () => ({ number: 42 }));
    const result = await createPullRequestFromCommittedChanges(
      {
        changeCounts: async () => ({ uncommitted: 0 }),
        log: async () => [
          { message: "Add authenticated Git transport\n\nDetails" },
          { message: "Prepare GitHub settings" },
        ],
        create,
      },
      {
        workspaceId: "ws-1",
        branch: "feature/github-auth",
        draft: false,
      },
    );

    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      title: "Prepare GitHub settings",
      body:
        "## Summary\n\n- Add authenticated Git transport\n- Prepare GitHub settings",
      draft: false,
    });
    expect(result).toEqual({ number: 42 });
  });

  it("refuses to omit uncommitted work from the pull request", async () => {
    const create = vi.fn();
    await expect(
      createPullRequestFromCommittedChanges(
        {
          changeCounts: async () => ({ uncommitted: 2 }),
          log: async () => [{ message: "Committed work" }],
          create,
        },
        {
          workspaceId: "ws-1",
          branch: "feature/github-auth",
          draft: false,
        },
      ),
    ).rejects.toBeInstanceOf(UncommittedPullRequestError);
    expect(create).not.toHaveBeenCalled();
  });

  // Regression: a GitHub App connected to some OTHER repository reported
  // "Commit changes before creating this pull request" for a dirty worktree.
  // Committing cannot help — the connection can't reach the repository at all —
  // so the user did the work and met a different error on the next click.
  it("reports blocked GitHub access instead of asking for a commit first", async () => {
    const create = vi.fn();
    await expect(
      createPullRequestFromCommittedChanges(
        {
          changeCounts: async () => ({ uncommitted: 3 }),
          log: async () => [{ message: "Committed work" }],
          create,
          access: async () => ({
            state: "blocked" as const,
            connected: true,
            code: "GITHUB_REPO_NOT_INSTALLED",
            message: "This repository is not available to the connection.",
          }),
        },
        { workspaceId: "ws-1", branch: "feature/x", draft: false },
      ),
    ).rejects.toBeInstanceOf(GithubAccessError);
    expect(create).not.toHaveBeenCalled();
  });

  it("still asks for a commit when GitHub access is fine", async () => {
    await expect(
      createPullRequestFromCommittedChanges(
        {
          changeCounts: async () => ({ uncommitted: 1 }),
          log: async () => [],
          create: vi.fn(),
          access: async () => ({ state: "ok" as const, connected: true }),
        },
        { workspaceId: "ws-1", branch: "feature/x", draft: false },
      ),
    ).rejects.toBeInstanceOf(UncommittedPullRequestError);
  });

  // An offline or rate-limited probe is not evidence about access, so it must
  // never replace the refusal the caller actually has evidence for.
  it("treats an indeterminate or failed probe as no verdict", async () => {
    for (const access of [
      async () => ({ state: "unknown" as const }),
      async () => {
        throw new Error("probe exploded");
      },
    ]) {
      await expect(
        createPullRequestFromCommittedChanges(
          {
            changeCounts: async () => ({ uncommitted: 1 }),
            log: async () => [],
            create: vi.fn(),
            access,
          },
          { workspaceId: "ws-1", branch: "feature/x", draft: false },
        ),
      ).rejects.toBeInstanceOf(UncommittedPullRequestError);
    }
  });

  // The probe overlaps the create instead of gating it: awaiting it on a clean
  // worktree would add a GitHub round trip to the path that works.
  it("does not wait on the access probe when there is nothing uncommitted", async () => {
    const access = vi.fn(async () => ({ state: "ok" as const }));
    await createPullRequestFromCommittedChanges(
      {
        changeCounts: async () => ({ uncommitted: 0 }),
        log: async () => [{ message: "Committed work" }],
        create: async () => ({ number: 7 }),
        access,
      },
      { workspaceId: "ws-1", branch: "feature/x", draft: false },
    );
    expect(access).not.toHaveBeenCalled();
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

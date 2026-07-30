import { describe, expect, it, vi } from "vitest";

import {
  buildPullRequestDraft,
  createPullRequestFromCommittedChanges,
  UncommittedPullRequestError,
} from "../create-pr-action";

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

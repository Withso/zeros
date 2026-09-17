import { describe, expect, it, vi } from "vitest";
import { buildPullRequestDraft, createPullRequestForWorkspace, GithubAccessError, isPrAccessBlocked } from "../create-pr-action";

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


const INPUT = { workspaceId: "ws-1", branch: "feature/github-auth", baseBranch: "main", draft: false };
function deps() {
  return {
    log: vi.fn(async () => [{ message: "Add feature" }, { message: "Prepare feature" }]),
    create: vi.fn(async () => ({ number: 42 })),
    // These traps prove that even an older caller cannot trigger auto-commit.
    changeCounts: vi.fn(async () => ({ uncommitted: 2 })),
    status: vi.fn(async () => ({ staged: ["Design/a.html"], unstaged: ["code.ts"] })),
    stage: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
  };
}

describe("Create PR direct action", () => {
  it("publishes existing commits without sweeping staged or unstaged work", async () => {
    const dependencies = deps();
    const outcome = await createPullRequestForWorkspace(dependencies, INPUT);
    expect(outcome).toEqual({ result: { number: 42 }, committed: null });
    expect(dependencies.log).toHaveBeenCalledWith({ workspaceId: "ws-1", limit: 50, base: "main" });
    expect(dependencies.create).toHaveBeenCalledWith({ workspaceId: "ws-1", title: "Prepare feature", body: "## Summary\n\n- Add feature\n- Prepare feature", draft: false });
    expect(dependencies.changeCounts).not.toHaveBeenCalled();
    expect(dependencies.status).not.toHaveBeenCalled();
    expect(dependencies.stage).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it("requires existing branch commits before creating a PR", async () => {
    const dependencies = deps();
    dependencies.log.mockResolvedValue([]);
    await expect(createPullRequestForWorkspace(dependencies, INPUT)).rejects.toThrow("no commits beyond its base");
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it("preserves the draft flag and surfaces a publication failure", async () => {
    const dependencies = deps();
    const failure = new Error("Push failed");
    dependencies.create.mockRejectedValue(failure);
    await expect(createPullRequestForWorkspace(dependencies, { ...INPUT, draft: true })).rejects.toBe(failure);
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ draft: true }));
    expect(dependencies.stage).not.toHaveBeenCalled();
  });
  it("stops on definite access denial before publication", async () => {
    const dependencies = deps();
    await expect(createPullRequestForWorkspace({ ...dependencies, access: async () => ({ state: "blocked" }) }, INPUT)).rejects.toBeInstanceOf(GithubAccessError);
    expect(dependencies.create).not.toHaveBeenCalled();
  });
  it.each(["unknown", "failure"])("lets %s access probes reach the authoritative operation", async (state) => {
    const dependencies = deps();
    await createPullRequestForWorkspace({ ...dependencies, access: async () => { if (state === "failure") throw new Error("Offline probe"); return { state: "unknown" }; } }, INPUT);
    expect(dependencies.create).toHaveBeenCalledOnce();
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

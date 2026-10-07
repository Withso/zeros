import { describe, expect, it, vi } from "vitest";
import { buildPullRequestDraft, createPullRequestForWorkspace, GithubAccessError, isPrAccessBlocked } from "../create-pr-action";
import { buildAutoCommitMessage, type WorktreeFacts } from "../pr-auto-commit";

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
    status: vi.fn(async (_workspaceId: string): Promise<WorktreeFacts> => clean()),
    diff: vi.fn(async (_args: unknown) => ({ hunks: [], files: [] as Array<{ path: string; oldPath?: string }> })),
    commit: vi.fn(async (_args: unknown) => ({ sha: "committed", branch: INPUT.branch })),
  };
}
const clean = (): WorktreeFacts => ({ staged: [], unstaged: [], untracked: [], conflicted: [], conflictState: null });
function dirty(dependencies: ReturnType<typeof deps>) {
  dependencies.status.mockResolvedValue({ ...clean(), staged: [{ path: "Design/a.html" }], unstaged: [{ path: "code.ts" }], untracked: ["new.ts", ".context/notes.md", ".zeros/settings.toml"] });
  dependencies.diff.mockResolvedValue({ hunks: [], files: [{ path: "Design/a.html" }, { path: "code.ts" }] });
}

describe("Create PR direct action", () => {
  it("publishes clean committed history without creating another commit", async () => {
    const dependencies = deps();
    const outcome = await createPullRequestForWorkspace(dependencies, INPUT);
    expect(outcome).toEqual({ result: { number: 42 }, committed: null });
    expect(dependencies.log).toHaveBeenCalledWith({ workspaceId: "ws-1", limit: 50, base: "main" });
    expect(dependencies.create).toHaveBeenCalledWith({ workspaceId: "ws-1", title: "Prepare feature", body: "## Summary\n\n- Add feature\n- Prepare feature", draft: false });
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
    expect(dependencies.commit).not.toHaveBeenCalled();
  });
  it("stops on definite access denial before publication", async () => {
    const dependencies = deps();
    await expect(createPullRequestForWorkspace({ ...dependencies, access: async () => ({ state: "blocked" }) }, INPUT)).rejects.toBeInstanceOf(GithubAccessError);
    expect(dependencies.create).not.toHaveBeenCalled();
    expect(dependencies.status).not.toHaveBeenCalled();
  });
  it.each(["main", "organization-local", "cloud://organization/workspace"])("commits pending Code and Design before publication for %s", async (workspaceId) => {
    const dependencies = deps();
    dirty(dependencies);
    const outcome = await createPullRequestForWorkspace(dependencies, { ...INPUT, workspaceId });
    const paths = ["Design/a.html", "code.ts", "new.ts"];
    const message = buildAutoCommitMessage(paths);
    expect(dependencies.status).toHaveBeenCalledWith(workspaceId);
    expect(dependencies.diff).toHaveBeenCalledWith({ workspaceId, mode: "worktree-vs-head", rawPatch: false, summaryLimit: 0 });
    expect(dependencies.commit).toHaveBeenCalledWith({ workspaceId, files: paths, message: `${message.subject}\n\n${message.body}` });
    expect(dependencies.commit.mock.invocationCallOrder[0]).toBeLessThan(dependencies.log.mock.invocationCallOrder[0]!);
    expect(dependencies.log.mock.invocationCallOrder[0]).toBeLessThan(dependencies.create.mock.invocationCallOrder[0]!);
    expect(outcome.committed).toEqual({ sha: "committed", branch: INPUT.branch });
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
  });
  it("can create a draft from dirty source with no previous branch commits", async () => {
    const dependencies = deps();
    dirty(dependencies);
    dependencies.log.mockImplementation(async () => dependencies.commit.mock.calls.length ? [{ message: "Update a.html and 2 more files" }] : []);
    await createPullRequestForWorkspace(dependencies, { ...INPUT, draft: true });
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Update a.html and 2 more files", draft: true }));
  });
  it("never commits net-empty staged-add/disk-delete work", async () => {
    const dependencies = deps();
    dependencies.status.mockResolvedValue({ ...clean(), staged: [{ path: "cancelled.ts" }], unstaged: [{ path: "cancelled.ts" }] });
    dependencies.log.mockResolvedValue([]);
    await expect(createPullRequestForWorkspace(dependencies, INPUT)).rejects.toThrow("no commits beyond its base");
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });
  it("includes both sides of a rename and excludes unrelated cancelled paths", async () => {
    const dependencies = deps();
    dependencies.status.mockResolvedValue({ ...clean(), staged: [{ path: "new.ts" }, { path: "cancelled.ts" }], unstaged: [{ path: "cancelled.ts" }] });
    dependencies.diff.mockResolvedValue({ hunks: [], files: [{ path: "new.ts", oldPath: "old.ts" }, { path: "deleted.ts" }] });
    await createPullRequestForWorkspace(dependencies, INPUT);
    expect(dependencies.commit).toHaveBeenCalledWith(expect.objectContaining({ files: ["deleted.ts", "new.ts", "old.ts"] }));
  });
  it.each(["conflicts", "merge", "rebase", "cherry-pick", "revert"] as const)("blocks %s before committing or publishing", async (state) => {
    const dependencies = deps();
    dependencies.status.mockResolvedValue({ ...clean(), conflicted: state === "conflicts" ? [{ path: "code.ts" }] : [], conflictState: state === "conflicts" ? null : state });
    await expect(createPullRequestForWorkspace(dependencies, INPUT)).rejects.toThrow(state === "conflicts" ? /conflict/i : state);
    expect(dependencies.commit).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });
  it("stops on commit failure and preserves the cause for dedicated remediation", async () => {
    const dependencies = deps();
    dirty(dependencies);
    const failure = Object.assign(new Error("git commit failed"), { remediation: "Workspace file permissions need repair." });
    dependencies.commit.mockRejectedValue(failure);
    await expect(createPullRequestForWorkspace(dependencies, INPUT)).rejects.toMatchObject({ failure });
    expect(dependencies.log).not.toHaveBeenCalled();
    expect(dependencies.create).not.toHaveBeenCalled();
  });
  it("retains the commit on push/PR failure and retries without making another", async () => {
    const dependencies = deps();
    dirty(dependencies);
    dependencies.commit.mockImplementation(async () => {
      dependencies.status.mockResolvedValue(clean());
      dependencies.diff.mockResolvedValue({ hunks: [], files: [] });
      return { sha: "retained", branch: INPUT.branch };
    });
    const failure = new Error("Push failed");
    dependencies.create.mockRejectedValueOnce(failure);
    await expect(createPullRequestForWorkspace(dependencies, INPUT)).rejects.toBe(failure);
    expect(await createPullRequestForWorkspace(dependencies, INPUT)).toMatchObject({ committed: null, result: { number: 42 } });
    expect(dependencies.commit).toHaveBeenCalledOnce();
    expect(dependencies.create).toHaveBeenCalledTimes(2);
  });
  it("pins the workspace while another owner is selected during a read", async () => {
    const dependencies = deps();
    let release!: (value: WorktreeFacts) => void;
    dependencies.status.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const input = { ...INPUT };
    const pending = createPullRequestForWorkspace(dependencies, input);
    await vi.waitFor(() => expect(dependencies.status).toHaveBeenCalledOnce());
    input.workspaceId = "cloud://another/workspace";
    input.branch = "other";
    release(clean());
    await pending;
    expect(dependencies.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: INPUT.workspaceId }));
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

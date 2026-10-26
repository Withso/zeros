// syncWorkspacePr detects a PR opened OUTSIDE the engine (agent `gh pr create`,
// terminal, github.com) and backfills the workspace row so the PR-status island
// can appear. Uses the same fake-Octokit + in-memory token-store seams as
// github.test.ts — no network.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteWorkspaceRow, insertWorkspace, reassignLocalWorkspaceOrganization } from "../state";

import {
  closeState,
  createPr,
  createWorkspace,
  getWorkspace,
  setOctokitFactoryForTesting,
  setPushForTesting,
  setStateRootForTesting,
  setTokenStoreForTesting,
  syncWorkspacePr,
  updateWorkspace,
} from "..";

const execFileAsync = promisify(execFile);

/** Minimal fake Octokit: records created PRs, serves them back via pulls.list
 *  (state-filtered) and pulls.create. Mirrors github.test.ts's shape. */
function makeOctokitMock(owner = "Acme", repo = "widgets") {
  // REST follows repository redirects, but never rewrites an owner-qualified
  // head filter. Model both so an old remote URL cannot make this test pass.
  const repository = { id: 123, name: repo, owner: { login: owner } };
  interface PrPayload {
    number: number;
    html_url: string;
    state: string;
    draft: boolean;
    title: string;
    body: string;
    user: { login: string };
    base: { ref: string };
    head: { ref: string; label: string; repo: { id: number } | null };
    created_at: string;
    updated_at: string;
    node_id: string;
    merged_at: string | null;
  }
  const prs = new Map<number, PrPayload>();
  let next = 100;
  const fake = {
    repos: {
      get: vi.fn(async () => ({ data: repository })),
    },
    users: {
      async getAuthenticated() {
        return { data: { login: "test-user" } };
      },
    },
    pulls: {
      async create(args: {
        owner: string;
        repo: string;
        title: string;
        body: string;
        head: string;
        base: string;
        draft: boolean;
      }) {
        const number = next++;
        const pr: PrPayload = {
          number,
          html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
          state: "open",
          draft: args.draft,
          title: args.title,
          body: args.body,
          user: { login: "test-user" },
          base: { ref: args.base },
          head: { ref: args.head, label: `${owner}:${args.head}`, repo: { id: repository.id } },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          node_id: `PR_${number}`,
          merged_at: null,
        };
        prs.set(number, pr);
        return { data: pr };
      },
      async list(args: { owner: string; repo: string; state?: string; head?: string; per_page?: number }) {
        const all = Array.from(prs.values()).reverse().filter((pr) => !args.head || pr.head.label === args.head);
        const data =
          !args.state || args.state === "all"
            ? all
            : all.filter((p) => p.state === args.state);
        return { data: data.slice(0, args.per_page ?? data.length) };
      },
      async get(args: { owner: string; repo: string; pull_number: number }) {
        return { data: prs.get(args.pull_number) };
      },
    },
  };
  /** Simulate an EXTERNAL merge (merged on github.com, not via our Merge
   *  button): flip the PR closed + stamp merged_at — the signal octoPrToPr reads
   *  (via the PR-detail get) to report state "merged". */
  function markMerged(number: number) {
    const pr = prs.get(number);
    if (pr) {
      pr.state = "closed";
      pr.merged_at = "2026-01-02T00:00:00Z";
    }
  }
  function markClosed(number: number) {
    const pr = prs.get(number);
    if (pr) {
      pr.state = "closed";
      pr.merged_at = null;
    }
  }
  return { octokit: fake, prs, markClosed, markMerged };
}

describe("syncWorkspacePr", () => {
  let workdir: string;
  let repoRoot: string;
  let workspaceId: string;
  let octokitMock: ReturnType<typeof makeOctokitMock>;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-prsync-"));
    repoRoot = path.join(workdir, "repo");
    setStateRootForTesting(path.join(workdir, "state"));
    await mkdir(repoRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
    await execFileAsync(
      "git",
      ["remote", "add", "origin", "git@github.com:Acme/widgets.git"],
      { cwd: repoRoot },
    );
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "README.md"), "# x\n");
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
    workspaceId = (await createWorkspace({ repoRoot })).workspaceId;

    setTokenStoreForTesting({
      async get() {
        return "gho_test";
      },
      async set() {},
      async clear() {},
    } as never);
    octokitMock = makeOctokitMock();
    setOctokitFactoryForTesting(() => octokitMock.octokit as never);
    setPushForTesting(async () => ({ remoteRef: "origin/test", ahead: 0, behind: 0 }));
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    setTokenStoreForTesting(null);
    setOctokitFactoryForTesting(null);
    setPushForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("returns null (and leaves the row null) when the branch has no PR", async () => {
    const result = await syncWorkspacePr(workspaceId);
    expect(result).toBeNull();
    expect(getWorkspace(workspaceId).prNumber).toBeNull();
  });

  it("detects + backfills a PR opened outside the engine", async () => {
    // Simulate a PR opened by the agent's own `gh pr create`: it exists on
    // GitHub (create it) but the engine never recorded it — so blank the row.
    const created = await createPr({
      workspaceId,
      title: "Add PR guide",
      body: "…",
    });
    updateWorkspace(workspaceId, {
      prNumber: null,
      prState: null,
      prUrl: null,
      status: "in-progress",
    });
    expect(getWorkspace(workspaceId).prNumber).toBeNull();

    const synced = await syncWorkspacePr(workspaceId);
    expect(synced?.number).toBe(created.number);
    const row = getWorkspace(workspaceId);
    expect(row.prNumber).toBe(created.number);
    expect(row.prUrl).toBe(created.url);
    expect(row.status).toBe("in-review");
  });

  it("is idempotent when the PR is already recorded", async () => {
    await createPr({ workspaceId, title: "t", body: "b" });
    const before = getWorkspace(workspaceId);
    const synced = await syncWorkspacePr(workspaceId);
    expect(synced?.number).toBe(before.prNumber);
    expect(getWorkspace(workspaceId).prNumber).toBe(before.prNumber);
  });

  it.each([
    ["NewOwner", "widgets"],
    ["Acme", "renamed-widgets"],
    ["NewOwner", "renamed-widgets"],
  ])("discovers a PR after the repository moves to %s/%s with the old remote retained", async (owner, repo) => {
    octokitMock = makeOctokitMock(owner, repo);
    setOctokitFactoryForTesting(() => octokitMock.octokit as never);
    const created = await createPr({ workspaceId, title: "Transferred repository", body: "" });
    updateWorkspace(workspaceId, { prNumber: null, prState: null, prUrl: null, status: "in-progress" });

    const list = vi.spyOn(octokitMock.octokit.pulls, "list");
    const synced = await syncWorkspacePr(workspaceId);

    expect(synced?.number).toBe(created.number);
    expect(getWorkspace(workspaceId)).toMatchObject({
      prNumber: created.number, prUrl: `https://github.com/${owner}/${repo}/pull/${created.number}`, status: "in-review",
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ owner, repo, head: `${owner}:${getWorkspace(workspaceId).branch}` }));
    // Discovery is an observation; it must not rewrite the user's Git remote.
    const remote = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
    expect(remote.stdout.trim()).toBe("git@github.com:Acme/widgets.git");
  });

  it.each(["fork", "other-branch", "deleted-repository"])("rejects a %s PR when GitHub ignores the head filter", async (kind) => {
    const created = await createPr({ workspaceId, title: "Unrelated PR", body: "" });
    updateWorkspace(workspaceId, { prNumber: null, prState: null, prUrl: null, status: "in-progress" });
    const unrelated = octokitMock.prs.get(created.number)!;
    if (kind === "other-branch") unrelated.head.ref = "unrelated-branch";
    else unrelated.head.repo = kind === "fork" ? { id: 456 } : null;
    vi.spyOn(octokitMock.octokit.pulls, "list").mockResolvedValue({ data: [unrelated] });

    expect(await syncWorkspacePr(workspaceId)).toBeNull();
    expect(getWorkspace(workspaceId)).toMatchObject({ prNumber: null, status: "in-progress" });
  });

  it("finds an open PR even when more than a page of newer closed PRs use the same branch", async () => {
    const open = await createPr({ workspaceId, title: "Still open", body: "" });
    for (let index = 0; index < 11; index++) {
      const closed = await createPr({ workspaceId, title: `Closed ${index}`, body: "" });
      octokitMock.markClosed(closed.number);
    }
    updateWorkspace(workspaceId, { prNumber: null, prState: null, prUrl: null });
    expect(await syncWorkspacePr(workspaceId)).toMatchObject({ number: open.number });
  });

  it("reconciles the recorded PR by number instead of replacing it with another PR on the branch", async () => {
    const recorded = await createPr({ workspaceId, title: "Recorded", body: "" });
    octokitMock.markMerged(recorded.number);
    await createPr({ workspaceId, title: "Newer", body: "" });
    updateWorkspace(workspaceId, { prNumber: recorded.number, prUrl: recorded.url, prState: "draft" });
    expect(await syncWorkspacePr(workspaceId)).toMatchObject({ number: recorded.number, state: "merged" });
    expect(getWorkspace(workspaceId).prNumber).toBe(recorded.number);
  });

  it("keeps a recorded PR readable after its head repository is deleted", async () => {
    const recorded = await createPr({ workspaceId, title: "Recorded", body: "" });
    octokitMock.prs.get(recorded.number)!.head.repo = null;
    octokitMock.markMerged(recorded.number);
    expect(await syncWorkspacePr(workspaceId)).toMatchObject({ number: recorded.number, state: "merged" });
  });

  it("keeps the recorded repository when a new remote has the same PR number", async () => {
    const recorded = await createPr({ workspaceId, title: "Recorded", body: "" });
    const original = octokitMock.prs.get(recorded.number)!;
    const get = vi.spyOn(octokitMock.octokit.pulls, "get").mockImplementation(async (args) => ({
      data: args.owner === "Acme" && args.repo === "widgets" ? original : {
        ...original, html_url: `https://github.com/other/repository/pull/${recorded.number}`,
        state: "closed", merged_at: "2026-01-02T00:00:00Z",
      },
    }));
    await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/other/repository.git"], { cwd: repoRoot });

    expect(await syncWorkspacePr(workspaceId)).toMatchObject({ number: recorded.number, url: recorded.url, state: "draft" });
    expect(get).toHaveBeenCalledWith({ owner: "Acme", repo: "widgets", pull_number: recorded.number });
    expect(getWorkspace(workspaceId)).toMatchObject({ prUrl: recorded.url, status: "in-review" });
  });

  it.each(["remote", "deletion"])("discards a held discovery after %s changes its target", async (change) => {
    const created = await createPr({ workspaceId, title: "Original remote", body: "" });
    updateWorkspace(workspaceId, { prNumber: null, prState: null, prUrl: null, status: "in-progress" });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(octokitMock.octokit.pulls, "list").mockImplementation(async () => {
      entered(); await held;
      return { data: [octokitMock.prs.get(created.number)!] };
    });
    const pending = syncWorkspacePr(workspaceId);
    await started;
    if (change === "deletion") deleteWorkspaceRow(workspaceId);
    else await execFileAsync("git", ["remote", "set-url", "origin", "https://github.com/other/repository.git"], { cwd: repoRoot });
    release();

    expect(await pending).toBeNull();
    if (change === "remote") expect(getWorkspace(workspaceId)).toMatchObject({ prNumber: null, status: "in-progress" });
  });

  it.each(["branch", "organizationId"] as const)("does not attach a held PR response after the workspace %s changes", async (field) => {
    if (field === "organizationId") {
      // Historical organization-local rows remain supported even though new
      // organization workspaces are now created in the cloud.
      const original = getWorkspace(workspaceId);
      deleteWorkspaceRow(workspaceId);
      insertWorkspace({ ...original, organizationId: "original" });
    }
    const created = await createPr({ workspaceId, title: "Original workspace", body: "" });
    updateWorkspace(workspaceId, { prNumber: null, prState: null, prUrl: null, status: "in-progress" });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(octokitMock.octokit.pulls, "list").mockImplementation(async () => {
      entered(); await held;
      return { data: [octokitMock.prs.get(created.number)!] };
    });
    const pending = syncWorkspacePr(workspaceId);
    await started;
    if (field === "organizationId") {
      expect(reassignLocalWorkspaceOrganization("original", "successor").changes).toBe(1);
    } else updateWorkspace(workspaceId, { branch: "successor" });
    release();
    expect(await pending).toBeNull();
    expect(getWorkspace(workspaceId)).toMatchObject({ [field]: "successor", prNumber: null, status: "in-progress" });
  });

  it("reports a failed GitHub lookup instead of confirming that no PR exists", async () => {
    vi.spyOn(octokitMock.octokit.pulls, "list").mockRejectedValue(Object.assign(new Error("Unavailable"), { status: 503 }));
    await expect(syncWorkspacePr(workspaceId)).rejects.toMatchObject({ code: "GITHUB_API_ERROR" });
    expect(getWorkspace(workspaceId).prNumber).toBeNull();
  });

  it("does not turn a failed merged-PR detail read into a closed PR", async () => {
    const created = await createPr({ workspaceId, title: "Merged", body: "" });
    octokitMock.markMerged(created.number);
    vi.spyOn(octokitMock.octokit.pulls, "get").mockRejectedValue(Object.assign(new Error("Unavailable"), { status: 503 }));
    await expect(syncWorkspacePr(workspaceId)).rejects.toMatchObject({ code: "GITHUB_API_ERROR" });
    expect(getWorkspace(workspaceId).prState).toBe("draft");
  });

  it("flips a workspace to done when its PR was merged externally", async () => {
    const created = await createPr({ workspaceId, title: "merge me", body: "" });
    expect(getWorkspace(workspaceId).status).toBe("in-review");
    // Merged on github.com, NOT via our Merge button — the engine never learned.
    octokitMock.markMerged(created.number);
    const synced = await syncWorkspacePr(workspaceId);
    expect(synced?.state).toBe("merged");
    const row = getWorkspace(workspaceId);
    expect(row.status).toBe("done");
    expect(row.prState).toBe("merged");
  });

  it("does not backfill a closed-unmerged PR onto an unrecorded workspace", async () => {
    const created = await createPr({ workspaceId, title: "closed", body: "" });
    updateWorkspace(workspaceId, {
      prNumber: null,
      prState: null,
      prUrl: null,
      status: "in-progress",
    });
    octokitMock.markClosed(created.number);

    const synced = await syncWorkspacePr(workspaceId);
    expect(synced).toBeNull();
    const row = getWorkspace(workspaceId);
    expect(row.prNumber).toBeNull();
    expect(row.prState).toBeNull();
    expect(row.status).toBe("in-progress");
  });

  it("does not resurrect a manually-cancelled workspace on external merge", async () => {
    const created = await createPr({ workspaceId, title: "x", body: "" });
    updateWorkspace(workspaceId, { status: "cancelled" });
    octokitMock.markMerged(created.number);
    await syncWorkspacePr(workspaceId);
    // The user's explicit cancel is sticky — auto-events never override it.
    expect(getWorkspace(workspaceId).status).toBe("cancelled");
  });
});

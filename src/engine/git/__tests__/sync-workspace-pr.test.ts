// syncWorkspacePr detects a PR opened OUTSIDE the engine (agent `gh pr create`,
// terminal, github.com) and backfills the workspace row so the PR-status island
// can appear. Uses the same fake-Octokit + in-memory token-store seams as
// github.test.ts — no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
function makeOctokitMock() {
  interface PrPayload {
    number: number;
    html_url: string;
    state: string;
    draft: boolean;
    title: string;
    body: string;
    user: { login: string };
    base: { ref: string };
    head: { ref: string };
    created_at: string;
    updated_at: string;
    node_id: string;
    merged_at: string | null;
  }
  const prs = new Map<number, PrPayload>();
  let next = 100;
  const fake = {
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
          html_url: `https://github.com/${args.owner}/${args.repo}/pull/${number}`,
          state: "open",
          draft: args.draft,
          title: args.title,
          body: args.body,
          user: { login: "test-user" },
          base: { ref: args.base },
          head: { ref: args.head },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          node_id: `PR_${number}`,
          merged_at: null,
        };
        prs.set(number, pr);
        return { data: pr };
      },
      async list(args: { owner: string; repo: string; state?: string }) {
        const all = Array.from(prs.values());
        const data =
          !args.state || args.state === "all"
            ? all
            : all.filter((p) => p.state === args.state);
        return { data };
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
  return { octokit: fake, markClosed, markMerged };
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

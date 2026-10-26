// Startup maintenance of archive recovery pins. Long-lived installs keep a
// saved snapshot for every workspace ever archived. Background maintenance must
// stay bounded and coexist with the user's new lifecycle actions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const gitCalls = vi.hoisted(() => ({
  argv: [] as string[][],
  afterList: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../git-exec", async (original) => {
  const actual = await original<typeof import("../git-exec")>();
  return {
    ...actual,
    runGit: async (...call: Parameters<typeof actual.runGit>) => {
      gitCalls.argv.push([...call[1]]);
      const result = await actual.runGit(...call);
      if (call[1][0] === "for-each-ref") {
        const afterList = gitCalls.afterList;
        gitCalls.afterList = undefined;
        await afterList?.();
      }
      return result;
    },
  };
});

import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  setStateRootForTesting,
} from "..";
import { deleteWorkspaceSnapshot, pruneOrphanArchiveSnapshots, pruneOrphanWorkspaceBranchOwnershipRefs } from "../worktree";
import { archiveSnapshotRef } from "../turns-git";
import { beginWorkspaceLifecycle, getWorkspaceById, insertWorkspace } from "../state";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd })).stdout.trim();

describe("archive snapshot pins at startup", () => {
  let workdir: string;
  let repoRoot: string;

  beforeEach(async () => {
    gitCalls.argv = [];
    gitCalls.afterList = undefined;
    workdir = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-archive-pins-")),
    );
    repoRoot = path.join(workdir, "repo");
    const remote = path.join(workdir, "remote");
    setStateRootForTesting(path.join(workdir, "state"));
    await mkdir(repoRoot, { recursive: true });
    await git(workdir, "init", "-q", "--bare", "-b", "main", remote);
    await git(repoRoot, "init", "-q", "-b", "main");
    await git(repoRoot, "remote", "add", "origin", remote);
    await git(repoRoot, "config", "user.email", "test@test");
    await git(repoRoot, "config", "user.name", "test");
    await writeFile(path.join(repoRoot, "README.md"), "# test\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "init");
    await git(repoRoot, "push", "-q", "-u", "origin", "main");
    await git(repoRoot, "remote", "set-head", "origin", "main");
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  async function archivedWorkspaces(count: number) {
    const archived: { workspaceId: string; snapshot: string }[] = [];
    for (let index = 0; index < count; index++) {
      const created = await createWorkspace({ repoRoot });
      await writeFile(path.join(created.path, "wip.txt"), `draft ${index}\n`);
      const result = await archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      });
      archived.push({
        workspaceId: created.workspaceId,
        snapshot: result.archiveSnapshot!,
      });
    }
    return archived;
  }

  it("checks existing pins with one ref listing per repository", async () => {
    const archived = await archivedWorkspaces(3);
    gitCalls.argv = [];

    await pruneOrphanArchiveSnapshots();

    expect(gitCalls.argv).toEqual([
      ["for-each-ref", "--format=%(refname)", "refs/zeros/archive/"],
    ]);
    for (const { workspaceId, snapshot } of archived) {
      expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(workspaceId))).toBe(
        snapshot,
      );
    }
  });

  it("repins only the snapshots whose ref is missing", async () => {
    const [kept, lost] = await archivedWorkspaces(2);
    await git(repoRoot, "update-ref", "-d", archiveSnapshotRef(lost!.workspaceId));
    gitCalls.argv = [];

    await pruneOrphanArchiveSnapshots();

    expect(gitCalls.argv.filter(([command]) => command === "update-ref")).toEqual([
      ["update-ref", "--no-deref", archiveSnapshotRef(lost!.workspaceId), lost!.snapshot, ""],
    ]);
    expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(lost!.workspaceId))).toBe(
      lost!.snapshot,
    );
    expect(await git(repoRoot, "rev-parse", archiveSnapshotRef(kept!.workspaceId))).toBe(
      kept!.snapshot,
    );
  });

  function holdListing() {
    let release!: () => void;
    let entered!: () => void;
    const listed = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    gitCalls.afterList = async () => { entered(); await held; };
    return { listed, release };
  }

  it("does not recreate a snapshot deleted while the repository listing was pending", async () => {
    const [saved] = await archivedWorkspaces(1);
    const ws = getWorkspaceById(saved!.workspaceId)!;
    await git(repoRoot, "update-ref", "-d", archiveSnapshotRef(ws.id));
    const held = holdListing();
    const maintenance = pruneOrphanArchiveSnapshots();
    try {
      await held.listed;
      await deleteWorkspaceSnapshot({ workspaceId: ws.id, archiveSnapshot: ws.archiveSnapshot!, archivedAt: ws.archivedAt! });
    } finally {
      held.release();
      await maintenance;
    }
    expect(await git(repoRoot, "for-each-ref", "--format=%(refname)", archiveSnapshotRef(ws.id))).toBe("");
  });

  it("checks both branch proof namespaces with one listing and preserves another instance's refs", async () => {
    const created = await createWorkspace({ repoRoot });
    for (const operation of ["create", "restore"]) {
      await git(repoRoot, "update-ref", `refs/zeros/${operation}/${created.workspaceId}`, "HEAD");
      await git(repoRoot, "update-ref", `refs/zeros/${operation}/ws_other-instance`, "HEAD");
    }
    gitCalls.argv = [];
    expect(await pruneOrphanWorkspaceBranchOwnershipRefs()).toBe(2);
    expect(gitCalls.argv.filter(([command]) => command === "for-each-ref")).toHaveLength(1);
    expect((await git(repoRoot, "for-each-ref", "--format=%(refname)", "refs/zeros/")).split("\n")).toEqual([
      "refs/zeros/create/ws_other-instance", "refs/zeros/restore/ws_other-instance",
    ]);
  });

  it("retains branch ownership when a lifecycle starts during the ref listing", async () => {
    const created = await createWorkspace({ repoRoot });
    const ref = `refs/zeros/restore/${created.workspaceId}`;
    await git(repoRoot, "update-ref", ref, "HEAD");
    const held = holdListing();
    const maintenance = pruneOrphanWorkspaceBranchOwnershipRefs();
    try {
      await held.listed;
      beginWorkspaceLifecycle({
        workspaceId: created.workspaceId, operation: "restore", phase: "prepared",
        sourcePath: created.path, targetPath: created.path,
        sourceBranch: created.branch, targetBranch: created.branch,
        createFrom: "main", archiveSnapshot: null, archivedHead: null,
        adaptations: [], payload: {}, includeBranch: true, startedAt: Date.now(),
      });
    } finally {
      held.release();
      await maintenance;
    }
    expect(await git(repoRoot, "rev-parse", ref)).toBe(await git(repoRoot, "rev-parse", "HEAD"));
  });

  it("retains a branch proof replaced after the ref listing", async () => {
    const created = await createWorkspace({ repoRoot });
    const ref = `refs/zeros/create/${created.workspaceId}`;
    await git(repoRoot, "update-ref", ref, "HEAD");
    const held = holdListing();
    const maintenance = pruneOrphanWorkspaceBranchOwnershipRefs();
    let replacement = "";
    try {
      await held.listed;
      await git(repoRoot, "commit", "-q", "--allow-empty", "-m", "next");
      replacement = await git(repoRoot, "rev-parse", "HEAD");
      await git(repoRoot, "update-ref", ref, replacement);
    } finally {
      held.release();
      await maintenance;
    }
    expect(await git(repoRoot, "rev-parse", ref)).toBe(replacement);
  });

  it("never follows a symbolic ownership proof into a user branch", async () => {
    const created = await createWorkspace({ repoRoot });
    const head = await git(repoRoot, "rev-parse", "HEAD");
    const ref = `refs/zeros/create/${created.workspaceId}`;
    await git(repoRoot, "symbolic-ref", ref, "refs/heads/main");
    await pruneOrphanWorkspaceBranchOwnershipRefs();
    expect(await git(repoRoot, "rev-parse", "refs/heads/main")).toBe(head);
  });

  it("does not create a user branch through a dangling symbolic archive pin", async () => {
    const [saved] = await archivedWorkspaces(1);
    const ref = archiveSnapshotRef(saved!.workspaceId);
    await git(repoRoot, "update-ref", "-d", ref);
    await git(repoRoot, "symbolic-ref", ref, "refs/heads/unrelated");
    await pruneOrphanArchiveSnapshots();
    expect(await git(repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads/unrelated")).toBe("");
    expect(await git(repoRoot, "rev-parse", ref)).toBe(saved!.snapshot);
  });

  it.each(["archive", "ownership"] as const)("stops %s maintenance after an aborted repository read", async (kind) => {
    const [saved] = await archivedWorkspaces(1);
    const ref = kind === "archive"
      ? archiveSnapshotRef(saved!.workspaceId)
      : `refs/zeros/create/${saved!.workspaceId}`;
    if (kind === "archive") await git(repoRoot, "update-ref", "-d", ref);
    else await git(repoRoot, "update-ref", ref, "HEAD");
    const held = holdListing();
    const abort = new AbortController();
    gitCalls.argv = [];
    const maintenance = kind === "archive"
      ? pruneOrphanArchiveSnapshots({ signal: abort.signal })
      : pruneOrphanWorkspaceBranchOwnershipRefs({ signal: abort.signal });
    await held.listed;
    abort.abort();
    held.release();
    await maintenance;
    expect(gitCalls.argv).toHaveLength(1);
    expect(gitCalls.argv[0][0]).toBe("for-each-ref");
  });

  it("never scans a cloud workspace through the Local checkout", async () => {
    insertWorkspace({
      id: "cloud-a", organizationId: "org-a", placement: "cloud",
      repoRoot, repoSlug: "repo", path: "cloud://org-a/cloud-a", branch: "main", baseBranch: "main",
      status: "in-progress", createdAt: 1, archivedAt: 2, archiveSnapshot: await git(repoRoot, "rev-parse", "HEAD"),
      stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
    });
    gitCalls.argv = [];
    await pruneOrphanArchiveSnapshots();
    await pruneOrphanWorkspaceBranchOwnershipRefs();
    expect(gitCalls.argv).toEqual([]);
  });
});

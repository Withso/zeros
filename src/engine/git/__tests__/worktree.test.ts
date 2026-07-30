// Integration test covering the acceptance criteria for Phase 1
// (roadmap 03a). Sets up a real temp repo with a remote, creates
// workspaces, archives + restores, deletes — asserting both the
// on-disk state and the DB.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
  readFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { worktreeSeedPath } from "../../db/paths";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveWorkspace,
  buildSetupCommandEnv,
  closeState,
  commit,
  createWorkspace,
  prepareWorkspaceCreate,
  getWorkspaceLifecycleStatus,
  reconcileInterruptedWorkspaceLifecycles,
  deleteWorkspace,
  getWorkspace,
  hasWorkspaceChanges,
  initRepoInPlace,
  listWorkspaces,
  restoreWorkspace,
  setStateRootForTesting,
  stagePaths,
  status,
  worktreesRoot,
  migrateWorktreesToNewRoot,
} from "..";
import { upsertRepoByRoot } from "../../db/projects";
import {
  upsertChat,
  getChat,
  rebindChatsFolder,
  type ChatRow,
} from "../../db/chats";
import {
  beginWorkspaceLifecycle,
  deleteWorkspaceRow,
  finishWorkspaceLifecycle,
  getWorkspaceLifecycle,
  updateWorkspace,
  updateWorkspaceLifecycleDetails,
  updateWorkspaceLifecyclePhase,
} from "../state";
import {
  pruneOrphanArchiveSnapshots,
  pruneOrphanWorkspaceBranchOwnershipRefs,
} from "../worktree";
import {
  archiveSnapshotRef,
  applyArchiveSnapshotOntoCurrent,
  restoreWorktreeFromSnapshot,
  snapshotWorkingTree,
} from "../turns-git";

const execFileAsync = promisify(execFile);

// Set up a working repo with a real LOCAL bare repo as `origin`, so the
// `git fetch` on the worktree-create path works offline (createWorkspace now
// bases new worktrees on `origin/<default>` after a fetch). We push `main` and
// record `origin/HEAD` (like a clone) so default-branch detection is
// deterministic across git versions. The repoSlug derives from the bare path —
// stable within a run; tests that need it read it off the workspace row.
async function initRepo(repoRoot: string, bareRemote: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", [
    "init",
    "-q",
    "--bare",
    "-b",
    "main",
    bareRemote,
  ]);
  await execFileAsync("git", ["remote", "add", "origin", bareRemote], {
    cwd: repoRoot,
  });
  // Required for `git commit` to work without global config.
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: repoRoot,
  });
  await writeFile(path.join(repoRoot, "README.md"), "# test\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
  await execFileAsync("git", ["push", "-q", "-u", "origin", "main"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["remote", "set-head", "origin", "main"], {
    cwd: repoRoot,
  });
}

describe("worktree lifecycle (integration)", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    // macOS exposes its temp root as /var/folders while Git reports the same
    // paths through the canonical /private/var/folders spelling. Derive every
    // fixture path from the real root so porcelain assertions remain exact
    // even after a tested worktree folder has been removed.
    workdir = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-wt-test-")),
    );
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepo(repoRoot, path.join(workdir, "remote"));
  });

  afterEach(async () => {
    closeState();
    setStateRootForTesting(null);
    try {
      await rm(workdir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("migrateWorktreesToNewRoot relocates worktrees (git move) + updates the registry", async () => {
    const ws = await createWorkspace({ repoRoot });
    const oldPath = ws.path;
    expect(oldPath.startsWith(worktreesRoot())).toBe(true);
    const newRoot = path.join(workdir, "visible-workspaces");

    const res = await migrateWorktreesToNewRoot(worktreesRoot(), newRoot);
    expect(res).toEqual({ moved: 1, failed: 0 });

    const newPath = path.join(newRoot, path.relative(worktreesRoot(), oldPath));
    expect(existsSync(newPath)).toBe(true); // moved on disk
    expect(existsSync(oldPath)).toBe(false); // source gone
    expect(getWorkspace(ws.workspaceId).path).toBe(newPath); // registry updated
    // git move kept the worktree pointers valid → git still operates there.
    const out = await execFileAsync("git", [
      "-C",
      newPath,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    expect(out.stdout.trim()).toBe("true");

    // Idempotent: the path is now outside the legacy root → a re-run is a no-op.
    const again = await migrateWorktreesToNewRoot(worktreesRoot(), newRoot);
    expect(again).toEqual({ moved: 0, failed: 0 });
  });

  it("relocation skips lifecycle-owned paths and never adopts an occupied destination", async () => {
    const pending = await createWorkspace({ repoRoot });
    const pendingRow = getWorkspace(pending.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: pendingRow.id,
      operation: "archive",
      phase: "prepared",
      sourcePath: pendingRow.path,
      targetPath: null,
      sourceBranch: pendingRow.branch,
      targetBranch: null,
      createFrom: null,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    const pendingRoot = path.join(workdir, "pending-destination");
    expect(
      await migrateWorktreesToNewRoot(worktreesRoot(), pendingRoot),
    ).toEqual({ moved: 0, failed: 0 });
    expect(getWorkspace(pendingRow.id).path).toBe(pendingRow.path);
    expect(existsSync(pendingRow.path)).toBe(true);

    // A separate clean row hits a destination another process already owns.
    const clean = await createWorkspace({ repoRoot });
    const cleanRow = getWorkspace(clean.workspaceId);
    const occupiedRoot = path.join(workdir, "occupied-destination");
    const occupiedPath = path.join(
      occupiedRoot,
      path.relative(worktreesRoot(), cleanRow.path),
    );
    await mkdir(occupiedPath, { recursive: true });
    await writeFile(path.join(occupiedPath, "FOREIGN.txt"), "keep\n");
    expect(
      await migrateWorktreesToNewRoot(worktreesRoot(), occupiedRoot),
    ).toEqual({ moved: 0, failed: 1 });
    expect(getWorkspace(cleanRow.id).path).toBe(cleanRow.path);
    expect(await readFile(path.join(occupiedPath, "FOREIGN.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  it("relocation repairs a crash after git moved the checkout but before the row update", async () => {
    const created = await createWorkspace({ repoRoot });
    const original = getWorkspace(created.workspaceId);
    const newRoot = path.join(workdir, "relocation-crash-destination");
    const newPath = path.join(
      newRoot,
      path.relative(worktreesRoot(), original.path),
    );
    await mkdir(path.dirname(newPath), { recursive: true });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "move",
      original.path,
      newPath,
    ]);
    expect(existsSync(original.path)).toBe(false);
    expect(getWorkspace(original.id).path).toBe(original.path);

    expect(await migrateWorktreesToNewRoot(worktreesRoot(), newRoot)).toEqual({
      moved: 1,
      failed: 0,
    });
    expect(getWorkspace(original.id).path).toBe(newPath);
    expect(existsSync(newPath)).toBe(true);
  });

  it("relocation preserves a foreign repository that replaced a stale source checkout", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    await rm(row.path, { recursive: true, force: true }); // keep stale Git registration
    await mkdir(row.path, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: row.path,
    });
    await writeFile(path.join(row.path, "FOREIGN.txt"), "keep\n");

    const destination = path.join(workdir, "safe-relocation-destination");
    expect(
      await migrateWorktreesToNewRoot(worktreesRoot(), destination),
    ).toEqual({ moved: 0, failed: 1 });
    expect(getWorkspace(row.id).path).toBe(row.path);
    expect(await readFile(path.join(row.path, "FOREIGN.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  it("prepareWorkspaceCreate reserves identity without leaking a folder; create completes at the same path", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    expect(prepared.workspaceId).toMatch(/^ws_[0-9a-f]{6}-/);
    expect(prepared.branch).toMatch(
      /^zeros\/[A-Z][a-z]{2,15}(?:-v[1-9][0-9]{0,2})?$/,
    );
    expect(prepared.path.startsWith(worktreesRoot())).toBe(true);
    // Prepare is metadata-only. A timed-out/disconnected caller cannot leak an
    // empty directory; the renderer may still use this final path while settling.
    expect(existsSync(prepared.path)).toBe(false);

    const created = await createWorkspace({
      repoRoot,
      repoSlug: prepared.repoSlug,
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
    });
    // Same identity end-to-end: the folder the renderer navigated to IS the
    // worktree the engine checked out, under the name it already showed.
    expect(created.workspaceId).toBe(prepared.workspaceId);
    expect(created.path).toBe(prepared.path);
    expect(created.branch).toBe(prepared.branch);
    const dotGit = await stat(path.join(created.path, ".git"));
    expect(dotGit.isFile()).toBe(true); // linked worktree checkout landed
    expect(getWorkspace(created.workspaceId).path).toBe(prepared.path);
    expect(getWorkspace(created.workspaceId).branch).toBe(prepared.branch);
  });

  // Workspace names are allocated colours with no random tail (2026-07-29).
  // prepare writes no row, so nothing in the DB/git/filesystem records that a
  // prepared name is spoken for — an in-process reservation covers the gap.
  it("two prepares before either create pick DIFFERENT names", async () => {
    const a = await prepareWorkspaceCreate({ repoRoot });
    const b = await prepareWorkspaceCreate({ repoRoot });
    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
    // Both are still usable: the second is not a degraded "-v1" fallback,
    // because 348 base colours are still free.
    expect(b.branch).toMatch(/^zeros\/[A-Z][a-z]{2,15}$/);
  });

  it("never re-uses a name across many prepares in one repo", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      seen.add((await prepareWorkspaceCreate({ repoRoot })).branch);
    }
    expect(seen.size).toBe(30);
  });

  it("does not reuse the name of an ARCHIVED workspace", async () => {
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: false,
    });
    // The row survives archiving, so the name stays claimed.
    for (let i = 0; i < 10; i++) {
      const prepared = await prepareWorkspaceCreate({ repoRoot });
      expect(prepared.branch).not.toBe(created.branch);
    }
  });

  it("single-flights duplicate prepared creates and exposes the rowless active phase", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    const input = {
      repoRoot,
      repoSlug: prepared.repoSlug,
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
    };

    const first = createWorkspace(input);
    expect(getWorkspaceLifecycleStatus(prepared.workspaceId)).toMatchObject({
      active: true,
      operation: "create",
      phase: null,
    });
    const second = createWorkspace(input);
    expect(second).toBe(first);

    const [a, b] = await Promise.all([first, second]);
    expect(b).toEqual(a);
    expect(getWorkspaceLifecycleStatus(prepared.workspaceId)).toEqual({
      active: false,
      operation: null,
      phase: null,
      startedAt: null,
    });
    await expect(
      execFileAsync("git", [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        `refs/zeros/create/${prepared.workspaceId}`,
      ]),
    ).rejects.toBeTruthy();
  });

  it("keeps a repository's human folder stable when a same-basename repo is registered later", async () => {
    const first = await createWorkspace({ repoRoot });
    const firstRow = getWorkspace(first.workspaceId);
    const firstDirectory = path.dirname(first.path);
    upsertRepoByRoot({ repoRoot, repoSlug: firstRow.repoSlug });

    const otherRoot = path.join(workdir, "other", path.basename(repoRoot));
    await mkdir(otherRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: otherRoot,
    });
    // Needs a commit like any real repo: prepareWorkspaceCreate rejects an
    // unborn HEAD. This fixture only exists to collide on folder basename.
    await execFileAsync("git", ["config", "user.email", "test@test"], {
      cwd: otherRoot,
    });
    await execFileAsync("git", ["config", "user.name", "test"], {
      cwd: otherRoot,
    });
    await execFileAsync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: otherRoot },
    );
    upsertRepoByRoot({ repoRoot: otherRoot, repoSlug: "same-name-other" });

    const sameOwner = await prepareWorkspaceCreate({
      repoRoot,
      repoSlug: firstRow.repoSlug,
    });
    expect(path.dirname(sameOwner.path)).toBe(firstDirectory);

    const collidingOwner = await prepareWorkspaceCreate({
      repoRoot: otherRoot,
      repoSlug: "same-name-other",
    });
    expect(path.basename(path.dirname(collidingOwner.path))).toBe(
      "same-name-other",
    );
  });

  it("does not perpetuate the legacy repoSlug/workspaceId folder layout", async () => {
    const first = await createWorkspace({ repoRoot });
    const row = getWorkspace(first.workspaceId);
    const legacyPath = path.join(worktreesRoot(), row.repoSlug, row.id);
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "move",
      row.path,
      legacyPath,
    ]);
    updateWorkspace(row.id, { path: legacyPath });

    const prepared = await prepareWorkspaceCreate({
      repoRoot,
      repoSlug: row.repoSlug,
    });
    expect(path.basename(path.dirname(prepared.path))).toBe(
      path.basename(repoRoot),
    );
    expect(path.basename(prepared.path)).not.toMatch(
      /^ws_[a-z0-9]{6}-[a-z0-9-]+$/,
    );
  });

  it("never claims an empty folder that appears after prepare", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    await mkdir(prepared.path, { recursive: true });

    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
        preparedBranch: prepared.branch,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    // The unrelated folder is untouched, no hidden row was published, and the
    // operation never created/deleted the prepared branch.
    expect((await stat(prepared.path)).isDirectory()).toBe(true);
    expect(() => getWorkspace(prepared.workspaceId)).toThrow(/not found/i);
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      prepared.branch,
    ]);
    expect(stdout.trim()).toBe("");
  });

  it("prepared create rejects a malformed prepared branch", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
        preparedBranch: "main", // arbitrary refs are never accepted
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("prepared create rejects a reserved name and a hostile prefix", async () => {
    // Settings → Git (2026-07-29) made the branch PREFIX optional, so the
    // shape gate can no longer lean on a mandatory `zeros/` namespace to keep
    // these out. "Main" matters most: on a case-insensitive filesystem
    // `refs/heads/Main` is the same loose ref as `main`.
    for (const preparedBranch of [
      "Main",
      "Master",
      "Release",
      "--upload-pack=x/Cream",
      "-Cream",
      "zeros/../../Cream",
      "a..b/Cream",
    ]) {
      const prepared = await prepareWorkspaceCreate({ repoRoot });
      await expect(
        createWorkspace({
          repoRoot,
          repoSlug: prepared.repoSlug,
          preparedId: prepared.workspaceId,
          preparedBranch,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("prepared create accepts an allocator name under any valid prefix", async () => {
    // The other half of the gate: a configured prefix must still round-trip.
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    const created = await createWorkspace({
      repoRoot,
      repoSlug: prepared.repoSlug,
      preparedId: prepared.workspaceId,
      preparedBranch: "jordan/Cream",
    });
    expect(created.branch).toBe("jordan/Cream");
  });

  it("prepared create never deletes a branch that appeared after prepare", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      prepared.branch,
      "main",
    ]);
    const before = (
      await execFileAsync("git", ["-C", repoRoot, "rev-parse", prepared.branch])
    ).stdout.trim();

    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
        preparedBranch: prepared.branch,
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_ALREADY_EXISTS" });

    const after = (
      await execFileAsync("git", ["-C", repoRoot, "rev-parse", prepared.branch])
    ).stdout.trim();
    expect(after).toBe(before);
    expect(existsSync(prepared.path)).toBe(false);
  });

  it("prepared create fails cleanly when the announced target is not empty", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    // Something occupied the final path between prepare and create.
    await mkdir(prepared.path, { recursive: true });
    await writeFile(path.join(prepared.path, "intruder.txt"), "x");
    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
        preparedBranch: prepared.branch,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // No half-created DB row.
    expect(listWorkspaces().some((w) => w.id === prepared.workspaceId)).toBe(
      false,
    );
  });

  it("startup rolls back a checkout whose create provisioning never completed", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    const optimisticChatId = "optimistic-create-chat";
    upsertChat({
      id: optimisticChatId,
      folder: row.path,
      agentId: "codex",
      agentName: "Codex",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Never published",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "update-ref",
      `refs/zeros/create/${row.id}`,
      row.branch,
    ]);
    beginWorkspaceLifecycle({
      workspaceId: row.id,
      operation: "create",
      phase: "worktree-created",
      sourcePath: row.path,
      targetPath: row.path,
      sourceBranch: row.branch,
      targetBranch: row.branch,
      createFrom: row.baseBranch,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: { seedFiles: true, optimisticChatId },
      includeBranch: true,
      startedAt: Date.now(),
    });
    expect(listWorkspaces().some((workspace) => workspace.id === row.id)).toBe(
      false,
    );

    expect(await reconcileInterruptedWorkspaceLifecycles()).toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(existsSync(row.path)).toBe(false);
    expect(listWorkspaces().some((workspace) => workspace.id === row.id)).toBe(
      false,
    );
    expect(getChat(optimisticChatId)).toBeNull();
    await expect(
      execFileAsync("git", [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        `refs/heads/${row.branch}`,
      ]),
    ).rejects.toBeTruthy();
  });

  it("retains create recovery state when a proven checkout survives without a Git registration", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: row.id,
      operation: "create",
      phase: "worktree-created",
      sourcePath: row.path,
      targetPath: row.path,
      sourceBranch: row.branch,
      targetBranch: row.branch,
      createFrom: row.baseBranch,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: { seedFiles: true },
      includeBranch: true,
      startedAt: Date.now(),
    });

    // Reproduce a partial external/unregister failure: the checkout directory
    // survives, but its common-dir registration is gone. Recovery must not
    // recursively delete the ambiguous occupant or discard its hidden journal.
    const dotGit = await readFile(path.join(row.path, ".git"), "utf8");
    const gitDir = dotGit.match(/^gitdir: (.+)$/m)?.[1];
    expect(gitDir).toBeTruthy();
    await rm(gitDir as string, { recursive: true, force: true });

    expect(await reconcileInterruptedWorkspaceLifecycles()).toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(existsSync(row.path)).toBe(true);
    expect(getWorkspace(row.id).id).toBe(row.id);
    expect(getWorkspaceLifecycleStatus(row.id)).toMatchObject({
      active: false,
      operation: "create",
      phase: "worktree-created",
    });
  });

  it("never publishes or removes a foreign repository that replaces a create target behind a stale registration", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "update-ref",
      `refs/zeros/create/${row.id}`,
      row.branch,
    ]);
    beginWorkspaceLifecycle({
      workspaceId: row.id,
      operation: "create",
      phase: "work-applied",
      sourcePath: row.path,
      targetPath: row.path,
      sourceBranch: row.branch,
      targetBranch: row.branch,
      createFrom: row.baseBranch,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: { seedFiles: true },
      includeBranch: true,
      startedAt: Date.now(),
    });

    // Leave the parent repository's registration stale, then put a genuinely
    // unrelated repository at the human-readable target. Recovery must verify
    // the folder's own Git identity before either publishing or removing it.
    await rm(row.path, { recursive: true, force: true });
    await mkdir(row.path, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: row.path,
    });
    await writeFile(path.join(row.path, "FOREIGN.txt"), "keep\n");

    expect(await reconcileInterruptedWorkspaceLifecycles()).toEqual({
      recovered: 0,
      failed: 1,
    });
    expect(listWorkspaces().some((workspace) => workspace.id === row.id)).toBe(
      false,
    );
    expect(getWorkspaceLifecycleStatus(row.id)).toMatchObject({
      operation: "create",
      phase: "work-applied",
    });
    expect(await readFile(path.join(row.path, "FOREIGN.txt"), "utf8")).toBe(
      "keep\n",
    );
  });

  it("startup publishes a fully provisioned create interrupted before its DB commit", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: row.id,
      operation: "create",
      phase: "work-applied",
      sourcePath: row.path,
      targetPath: row.path,
      sourceBranch: row.branch,
      targetBranch: row.branch,
      createFrom: row.baseBranch,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: { seedFiles: true },
      includeBranch: true,
      startedAt: Date.now(),
    });

    expect(await reconcileInterruptedWorkspaceLifecycles()).toEqual({
      recovered: 1,
      failed: 0,
    });
    expect(getWorkspace(row.id)).toMatchObject({
      id: row.id,
      path: row.path,
      present: true,
    });
  });

  it("prepared create rejects a malformed prepared id", async () => {
    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: "repo",
        preparedId: "../../escape",
        preparedBranch: "zeros/orchid-1234",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("prepared create rejects an incomplete identity pair", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    await expect(
      createWorkspace({
        repoRoot,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(existsSync(prepared.path)).toBe(false);
  });

  it("prepareWorkspaceCreate rejects a repo with no commits, before reserving anything", async () => {
    // Freshly `git init`'d, never committed — passes isRepo but has an unborn
    // HEAD, so there's no base commit for `git worktree add`. Rejecting in
    // PREPARE is what keeps the renderer from navigating to an announced path
    // and spawning a provisional chat it then has to roll back.
    const unborn = path.join(workdir, "unborn");
    await mkdir(unborn, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: unborn });
    await writeFile(path.join(unborn, "a.txt"), "hi\n");

    await expect(
      prepareWorkspaceCreate({ repoRoot: unborn }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("no commits yet"),
    });

    // The check runs before repoSlug derivation, so an origin-less local repo
    // gets the actionable message rather than "Could not read origin URL".
    await expect(
      prepareWorkspaceCreate({ repoRoot: unborn }),
    ).rejects.not.toMatchObject({ code: "NOT_A_REPO" });

    // Once it has a commit, prepare succeeds — same repo, nothing else changed.
    await execFileAsync("git", ["config", "user.email", "test@test"], {
      cwd: unborn,
    });
    await execFileAsync("git", ["config", "user.name", "test"], {
      cwd: unborn,
    });
    await execFileAsync("git", ["add", "-A"], { cwd: unborn });
    await execFileAsync("git", ["commit", "-q", "-m", "first"], {
      cwd: unborn,
    });
    const prepared = await prepareWorkspaceCreate({
      repoRoot: unborn,
      repoSlug: "unborn",
    });
    expect(prepared.workspaceId).toMatch(/^ws_[0-9a-f]{6}-/);
  });

  it("createWorkspace still rejects an unborn HEAD when prepare was skipped", async () => {
    // createWorkspace is callable without a prepare (relay/adopt/tests), so the
    // guard stays in both phases rather than moving.
    const unborn = path.join(workdir, "unborn-direct");
    await mkdir(unborn, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: unborn });

    await expect(
      createWorkspace({ repoRoot: unborn, repoSlug: "unborndirect" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("no commits yet"),
    });
  });

  it("Initialize Git makes an empty folder workspace-ready end to end", async () => {
    // The exact journey both guards point at: a folder that can't host a
    // workspace → Initialize Git → create succeeds. An EMPTY folder is the case
    // that used to dead-end, because `git commit` exits 1 on nothing-to-commit
    // and Initialize Git was the only remediation offered.
    const folder = path.join(workdir, "empty-project");
    await mkdir(folder, { recursive: true });

    await expect(
      prepareWorkspaceCreate({ repoRoot: folder }),
    ).rejects.toMatchObject({ code: "NOT_A_REPO" });

    await initRepoInPlace(folder);

    const prepared = await prepareWorkspaceCreate({
      repoRoot: folder,
      repoSlug: "emptyproject",
    });
    const created = await createWorkspace({
      repoRoot: folder,
      repoSlug: prepared.repoSlug,
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
    });
    expect(created.path).toBe(prepared.path);
    expect((await stat(path.join(created.path, ".git"))).isFile()).toBe(true);
  });

  it("early create failure leaves no announced-path folder", async () => {
    const prepared = await prepareWorkspaceCreate({ repoRoot });
    // Force an early failure: a repoRoot that is not a git repository.
    const notARepo = path.join(workdir, "not-a-repo");
    await mkdir(notARepo, { recursive: true });
    await expect(
      createWorkspace({
        repoRoot: notARepo,
        repoSlug: prepared.repoSlug,
        preparedId: prepared.workspaceId,
      }),
    ).rejects.toMatchObject({ code: "NOT_A_REPO" });
    // Prepare was metadata-only — no orphan folder.
    expect(existsSync(prepared.path)).toBe(false);
  });

  it("creates a workspace from main", async () => {
    const result = await createWorkspace({ repoRoot });
    expect(result.workspaceId).toMatch(/^ws_[0-9a-f]{6}-/);
    // Follow-up D: branch is zeros/<flower>-<hex> (e.g. zeros/orchid-9a2f).
    expect(result.branch).toMatch(
      /^zeros\/[A-Z][a-z]{2,15}(?:-v[1-9][0-9]{0,2})?$/,
    );
    expect(result.status).toBe("in-progress");

    // Folder should exist and be a git worktree.
    const folder = await stat(result.path);
    expect(folder.isDirectory()).toBe(true);
    const dotGit = path.join(result.path, ".git");
    const dotGitStat = await stat(dotGit);
    // Linked worktree: .git is a file pointing into the main repo.
    expect(dotGitStat.isFile()).toBe(true);

    // DB row should exist.
    const ws = getWorkspace(result.workspaceId);
    expect(ws.status).toBe("in-progress");
    expect(ws.repoRoot).toBe(repoRoot);
    expect(ws.path).toBe(result.path);

    // Crash-recovery seed lives in app-data, NOT in the worktree (.zeros retired).
    expect(existsSync(path.join(result.path, ".zeros"))).toBe(false);
    const seed = JSON.parse(
      await readFile(worktreeSeedPath(result.path), "utf8"),
    );
    expect(seed.id).toBe(result.workspaceId);
    expect(seed.repoRoot).toBe(repoRoot);

    // Human-readable layout:
    // <workspaces>/<repository basename>/<display branch>.
    expect(result.path.startsWith(worktreesRoot())).toBe(true);
    expect(path.basename(path.dirname(result.path))).toBe(
      path.basename(repoRoot),
    );
    expect(path.basename(result.path)).toBe(
      result.branch.replace(/^zeros\//, ""),
    );
  });

  it("hasWorkspaceChanges: false when clean + no commits, true when dirty or committed", async () => {
    const created = await createWorkspace({ repoRoot });
    // Fresh worktree: HEAD == base, clean tree → nothing worth a PR.
    expect(await hasWorkspaceChanges(created.workspaceId)).toBe(false);
    // Uncommitted file → dirty tree → has changes.
    await writeFile(path.join(created.path, "new.txt"), "hi\n");
    expect(await hasWorkspaceChanges(created.workspaceId)).toBe(true);
    // Commit it → clean tree again, but a commit on top of base → still changes.
    await stagePaths({ workspaceId: created.workspaceId, paths: ["new.txt"] });
    await commit({ workspaceId: created.workspaceId, message: "add new.txt" });
    expect(await hasWorkspaceChanges(created.workspaceId)).toBe(true);
  });

  it("hasWorkspaceChanges ignores a staged add removed from disk (empty net AD diff)", async () => {
    const created = await createWorkspace({ repoRoot });
    const added = path.join(created.path, "cancelled.txt");
    await writeFile(added, "temporary\n");
    await stagePaths({
      workspaceId: created.workspaceId,
      paths: ["cancelled.txt"],
    });
    await rm(added);

    // The index still contains A and the worktree contains D, but HEAD and the
    // current filesystem are identical. There is nothing to show in All
    // Changes and nothing to submit in a PR.
    expect(await hasWorkspaceChanges(created.workspaceId)).toBe(false);
  });

  it("fetches + bases a new worktree on the latest origin/<default>, not stale local main", async () => {
    // Advance origin/main from a SECOND clone so repoRoot's local main AND its
    // cached origin/main are both behind — only a fetch sees the new tip.
    const other = path.join(workdir, "other");
    await execFileAsync("git", [
      "clone",
      "-q",
      path.join(workdir, "remote"),
      other,
    ]);
    await execFileAsync("git", ["-C", other, "config", "user.email", "o@o"]);
    await execFileAsync("git", ["-C", other, "config", "user.name", "o"]);
    await writeFile(path.join(other, "remote-only.txt"), "from origin\n");
    await execFileAsync("git", ["-C", other, "add", "."]);
    await execFileAsync("git", ["-C", other, "commit", "-q", "-m", "ahead"]);
    await execFileAsync("git", ["-C", other, "push", "-q", "origin", "main"]);
    const remoteTip = (
      await execFileAsync("git", ["-C", other, "rev-parse", "HEAD"])
    ).stdout.trim();

    const localHead = (
      await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(localHead).not.toBe(remoteTip); // repoRoot is behind the remote

    const ws = await createWorkspace({ repoRoot });
    const wtHead = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(wtHead).toBe(remoteTip); // fetched the new tip and forked from it
    expect(wtHead).not.toBe(localHead); // NOT the stale local checkout
    expect(existsSync(path.join(ws.path, "remote-only.txt"))).toBe(true);
    // Persisted baseBranch is the plain branch name, never "origin/main".
    expect(getWorkspace(ws.workspaceId).baseBranch).toBe("main");
  });

  it("falls back to the local branch when the repo has no remote", async () => {
    await execFileAsync("git", ["-C", repoRoot, "remote", "remove", "origin"]);
    const localHead = (
      await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"])
    ).stdout.trim();
    // repoSlug must be explicit now (no origin URL to derive it from).
    const ws = await createWorkspace({ repoRoot, repoSlug: "local-only" });
    const wtHead = (
      await execFileAsync("git", ["-C", ws.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(wtHead).toBe(localHead); // local main, no fetch
    expect(getWorkspace(ws.workspaceId).baseBranch).toBe("main");
  });

  it("Local main: status() resolves a registered repo ROOT to a trunk workspace (no row)", async () => {
    // The trunk has no workspace row — register the repo root so isKnownRepoRoot
    // trusts it, then run a read op against the root directly.
    upsertRepoByRoot({ repoRoot, repoSlug: "test-sample" });
    await writeFile(path.join(repoRoot, "trunk-change.txt"), "x\n");
    const s = await status(repoRoot);
    expect(s.untracked).toContain("trunk-change.txt");
  });

  it("Local main: WRITE ops run against a registered repo ROOT (trunk is editable, not read-only)", async () => {
    // Main used to reject writes with TRUNK_READ_ONLY. It's now a first-class
    // editable workspace — stage + commit directly on the trunk root works.
    upsertRepoByRoot({ repoRoot, repoSlug: "test-sample" });
    await writeFile(path.join(repoRoot, "trunk-edit.txt"), "hello\n");
    await stagePaths({ workspaceId: repoRoot, paths: ["trunk-edit.txt"] });
    const res = await commit({
      workspaceId: repoRoot,
      message: "trunk commit",
    });
    expect(res.sha).toMatch(/^[0-9a-f]{7,40}$/);
    // The commit actually landed on the trunk's HEAD…
    const log = await execFileAsync("git", [
      "-C",
      repoRoot,
      "log",
      "-1",
      "--format=%s",
    ]);
    expect(log.stdout.trim()).toBe("trunk commit");
    // …and the file is no longer dirty.
    const s = await status(repoRoot);
    expect(s.untracked).not.toContain("trunk-edit.txt");
  });

  it("read ops throw for an unregistered path (no trunk fallback)", async () => {
    await expect(status(path.join(workdir, "nope"))).rejects.toThrow();
  });

  it("creates 3 workspaces from the same base with distinct branches", async () => {
    const a = await createWorkspace({ repoRoot });
    const b = await createWorkspace({ repoRoot });
    const c = await createWorkspace({ repoRoot });

    expect(new Set([a.branch, b.branch, c.branch]).size).toBe(3);
    expect(new Set([a.workspaceId, b.workspaceId, c.workspaceId]).size).toBe(3);

    const listed = listWorkspaces();
    expect(listed.map((w) => w.id).sort()).toEqual(
      [a.workspaceId, b.workspaceId, c.workspaceId].sort(),
    );
  });

  it("uses the prompt hint in the workspace identity", async () => {
    const result = await createWorkspace({
      repoRoot,
      prompt: "Add Canvas Zoom support",
    });
    expect(result.workspaceId).toMatch(/add-canvas-zoom-support/);
  });

  it("archives a workspace with uncommitted changes (folder gone, branch kept, archive_snapshot stored)", async () => {
    const created = await createWorkspace({ repoRoot });
    // Make some uncommitted changes (tracked edit + untracked file).
    await writeFile(
      path.join(created.path, "scratch.txt"),
      "uncommitted edit\n",
    );
    await writeFile(path.join(created.path, "README.md"), "# changed\n");

    const result = await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // v17: archive captures a durable snapshot (no git stash).
    expect(result.stashRef).toBeNull();
    expect(result.archiveSnapshot).toMatch(/^[0-9a-f]{40,64}$/);

    // Folder should be gone.
    let exists = true;
    try {
      await stat(created.path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // Branch still exists on the ref store.
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      created.branch,
    ]);
    expect(stdout.includes(created.branch)).toBe(true);

    // The durable archive snapshot ref exists, pointing at the captured commit.
    const { stdout: refSha } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      `refs/zeros/archive/${created.workspaceId}`,
    ]);
    expect(refSha.trim()).toBe(result.archiveSnapshot);

    // DB row reflects archived state — archived is the `archivedAt` flag now;
    // lifecycle `status` is preserved across archive (orthogonal).
    const ws = getWorkspace(created.workspaceId);
    expect(ws.archivedAt).not.toBeNull();
    expect(ws.status).toBe("in-progress");
    expect(ws.stashRef).toBeNull();
    expect(ws.archiveSnapshot).toBe(result.archiveSnapshot);
  });

  it("awaits exact watcher retirement before moving an archived checkout", async () => {
    const created = await createWorkspace({ repoRoot });
    const order: string[] = [];

    await archiveWorkspace(
      {
        workspaceId: created.workspaceId,
        stashUncommitted: false,
      },
      undefined,
      async (workspaceId, worktreePath) => {
        expect(workspaceId).toBe(created.workspaceId);
        expect(worktreePath).toBe(created.path);
        expect(existsSync(worktreePath)).toBe(true);
        order.push("suspended");
        return {
          resume() {
            order.push("resumed");
          },
          retire() {
            expect(existsSync(worktreePath)).toBe(false);
            order.push("retired");
          },
        };
      },
    );

    expect(order).toEqual(["suspended", "retired"]);
    expect(getWorkspace(created.workspaceId).archivedAt).not.toBeNull();
  });

  it("never archives or deletes across a separately registered nested repository", async () => {
    const created = await createWorkspace({ repoRoot });
    const nestedRoot = path.join(created.path, "nested-project");
    await mkdir(nestedRoot, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: nestedRoot,
    });
    upsertRepoByRoot({ repoRoot: nestedRoot, repoSlug: "nested-project" });

    await expect(
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      deleteWorkspace({
        workspaceId: created.workspaceId,
        includeBranch: false,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(existsSync(nestedRoot)).toBe(true);
    expect(getWorkspace(created.workspaceId).archivedAt).toBeNull();
  });

  it("recovers the exact crash seam: directory removed while the DB row is still live", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "WIP.txt"), "must survive\n");
    const snapshot = await snapshotWorkingTree(
      created.path,
      archiveSnapshotRef(created.workspaceId),
    );
    expect(snapshot).toBeTruthy();
    const archivedHead = (
      await execFileAsync("git", ["-C", repoRoot, "rev-parse", created.branch])
    ).stdout.trim();
    beginWorkspaceLifecycle(
      {
        workspaceId: created.workspaceId,
        operation: "archive",
        phase: "worktree-removed",
        sourcePath: created.path,
        targetPath: null,
        sourceBranch: created.branch,
        targetBranch: null,
        createFrom: null,
        archiveSnapshot: snapshot,
        archivedHead,
        adaptations: [],
        payload: {},
        includeBranch: false,
        startedAt: Date.now(),
      },
      { archiveSnapshot: snapshot, archivedHead },
    );
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      created.path,
    ]);

    // This is the field failure: folder gone, archived_at not committed yet.
    expect(getWorkspace(created.workspaceId).archivedAt).toBeNull();
    expect(existsSync(created.path)).toBe(false);
    // Retention must fail closed while the lifecycle intent owns the ref.
    expect(await pruneOrphanArchiveSnapshots()).toBe(0);
    expect(
      (
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "rev-parse",
          archiveSnapshotRef(created.workspaceId),
        ])
      ).stdout.trim(),
    ).toBe(snapshot);

    const recovery = await reconcileInterruptedWorkspaceLifecycles();
    expect(recovery).toEqual({ recovered: 1, failed: 0 });
    const archived = getWorkspace(created.workspaceId);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.archiveSnapshot).toBe(snapshot);

    await restoreWorkspace(created.workspaceId);
    expect(await readFile(path.join(created.path, "WIP.txt"), "utf8")).toBe(
      "must survive\n",
    );
  });

  it("shares concurrent archive clicks as one engine operation", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "race.txt"), "one snapshot\n");
    const [first, second] = await Promise.all([
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ]);
    expect(second.archivedAt).toBe(first.archivedAt);
    expect(second.archiveSnapshot).toBe(first.archiveSnapshot);
    expect(listWorkspaces({ archived: true })).toHaveLength(1);
  });

  it("refuses to archive a worktree whose folder was deleted out-of-band (WORKTREE_MISSING, row untouched)", async () => {
    const created = await createWorkspace({ repoRoot });

    // Simulate an external `rm -rf` / Finder-trash of the worktree folder: the
    // DB row survives, the checkout does not.
    await rm(created.path, { recursive: true, force: true });

    // The presence stamp flips to false on both list + get.
    const listed = listWorkspaces().find((w) => w.id === created.workspaceId);
    expect(listed?.present).toBe(false);
    expect(getWorkspace(created.workspaceId).present).toBe(false);

    // Archiving is REFUSED with the structured code, not silently "succeeded" —
    // otherwise a later restore fabricates a phantom worktree with the same name.
    await expect(
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toMatchObject({ code: "WORKTREE_MISSING" });

    // The row is left exactly as it was — never flipped to archived, so the
    // renderer's "Delete permanently" is the only path forward.
    const ws = getWorkspace(created.workspaceId);
    expect(ws.archivedAt).toBeNull();
    expect(ws.archiveSnapshot ?? null).toBeNull();
  });

  it("never archives or removes a foreign repository that replaced a stale workspace path", async () => {
    const created = await createWorkspace({ repoRoot });
    // Remove only the directory, deliberately leaving the parent repository's
    // worktree registration behind. Path+branch registration alone therefore
    // still looks valid — the folder's own common Git dir must disprove it.
    await rm(created.path, { recursive: true, force: true });

    // Another tool/user claims the same human-readable folder before the stale
    // renderer row refreshes. Make it a real repository so a path-only archive
    // implementation could successfully snapshot it before deleting it.
    await mkdir(created.path, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: created.path,
    });
    await writeFile(path.join(created.path, "FOREIGN.txt"), "do not remove\n");

    await expect(
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(path.join(created.path, "FOREIGN.txt"), "utf8")).toBe(
      "do not remove\n",
    );
    expect(getWorkspace(created.workspaceId).archivedAt).toBeNull();

    // Explicit deletion removes only the stale Zeros record. The disproved
    // checkout ownership also suppresses branch deletion.
    await deleteWorkspace({
      workspaceId: created.workspaceId,
      includeBranch: true,
    });
    expect(await readFile(path.join(created.path, "FOREIGN.txt"), "utf8")).toBe(
      "do not remove\n",
    );
    expect(() => getWorkspace(created.workspaceId)).toThrow(/not found/i);
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      created.branch,
    ]);
    expect(stdout).toContain(created.branch);
  });

  it("restores an archived workspace (folder back, branch checked out, stashed changes re-applied)", async () => {
    const created = await createWorkspace({ repoRoot });
    // Tracked-change so stash captures something.
    await writeFile(path.join(created.path, "README.md"), "# changed\n");

    const archived = await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    expect(archived.archiveSnapshot).toBeTruthy();

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.restoredAt).toBeGreaterThan(0);
    expect(restored.conflicts).toEqual([]);

    // Folder back.
    const folder = await stat(created.path);
    expect(folder.isDirectory()).toBe(true);

    // Uncommitted change re-applied from the snapshot.
    const readme = await readFile(path.join(created.path, "README.md"), "utf8");
    expect(readme).toBe("# changed\n");

    // DB state reset; archive ref + snapshot OID cleared. Restore is the inverse
    // of archive: `archivedAt` clears and `status` is preserved (was in-progress).
    const ws = getWorkspace(created.workspaceId);
    expect(ws.status).toBe("in-progress");
    expect(ws.stashRef).toBeNull();
    expect(ws.archiveSnapshot).toBeNull();
    expect(ws.archivedAt).toBeNull();
    const refGone = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/zeros/archive/${created.workspaceId}`,
    ])
      .then(() => false)
      .catch(() => true);
    expect(refGone).toBe(true);
  });

  it("restoring one workspace never prunes another missing worktree registration", async () => {
    const otherInstance = await createWorkspace({ repoRoot });
    const restorable = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: restorable.workspaceId,
      stashUncommitted: true,
    });
    await rm(otherInstance.path, { recursive: true, force: true });

    await restoreWorkspace(restorable.workspaceId);

    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(stdout).toContain(`worktree ${otherInstance.path}\n`);
    expect(getWorkspace(otherInstance.workspaceId).present).toBe(false);
    expect(getWorkspace(restorable.workspaceId).present).toBe(true);
  });

  it("finishes a restore interrupted after work was applied but before the DB commit", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "resume.txt"), "recovered\n");
    const archived = await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const row = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: created.workspaceId,
      operation: "restore",
      phase: "prepared",
      sourcePath: row.path,
      targetPath: row.path,
      sourceBranch: row.branch,
      targetBranch: row.branch,
      createFrom: null,
      archiveSnapshot: archived.archiveSnapshot,
      archivedHead: row.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      row.path,
      row.branch,
    ]);
    const applied = await restoreWorktreeFromSnapshot(
      row.path,
      archived.archiveSnapshot as string,
    );
    expect(applied).toBe(true);
    updateWorkspaceLifecycleDetails(created.workspaceId, {
      phase: "work-applied",
      adaptations: [],
      payload: { conflicts: [] },
    });

    // Archived remains truthful until startup recovery commits the inverse.
    expect(getWorkspace(created.workspaceId).archivedAt).not.toBeNull();
    const recovery = await reconcileInterruptedWorkspaceLifecycles();
    expect(recovery).toEqual({ recovered: 1, failed: 0 });
    expect(getWorkspace(created.workspaceId).archivedAt).toBeNull();
    expect(await readFile(path.join(row.path, "resume.txt"), "utf8")).toBe(
      "recovered\n",
    );
  });

  it("retains the archived row, checkout, and journal when its snapshot cannot be applied", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "WIP.txt"), "must not vanish\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // Simulate damaged external Git metadata without deleting the real recovery
    // ref. Restore must fail closed instead of finalizing at committed state.
    updateWorkspace(created.workspaceId, {
      archiveSnapshot: "f".repeat(40),
    });

    await expect(restoreWorkspace(created.workspaceId)).rejects.toMatchObject({
      code: "STASH_FAILED",
    });
    const retained = getWorkspace(created.workspaceId);
    expect(retained.archivedAt).not.toBeNull();
    expect(existsSync(retained.path)).toBe(true);
    expect(getWorkspaceLifecycleStatus(retained.id)).toMatchObject({
      active: false,
      operation: "restore",
      phase: "worktree-created",
    });
    expect(
      (
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "rev-parse",
          archiveSnapshotRef(created.workspaceId),
        ])
      ).stdout.trim(),
    ).toMatch(/^[0-9a-f]{40}$/);
  });

  it("round-trips an UNTRACKED file through archive→restore (snapshot, not stash)", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(
      path.join(created.path, "new-untracked.txt"),
      "fresh work\n",
    );

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await restoreWorkspace(created.workspaceId);

    // The untracked file (gitignore-respecting `add -A` keeps it) comes back.
    expect(
      await readFile(path.join(created.path, "new-untracked.txt"), "utf8"),
    ).toBe("fresh work\n");
  });

  it("round-trips a BINARY uncommitted file (tree snapshot is binary-safe)", async () => {
    const created = await createWorkspace({ repoRoot });
    const bytes = Buffer.from([0, 1, 2, 3, 255, 254, 0, 42, 128, 7]);
    await writeFile(path.join(created.path, "blob.bin"), bytes);

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await restoreWorkspace(created.workspaceId);

    const got = await readFile(path.join(created.path, "blob.bin"));
    expect(got.equals(bytes)).toBe(true);
  });

  it("round-trips a modified ignored files-to-copy file", async () => {
    await writeFile(path.join(repoRoot, ".gitignore"), ".env*\n");
    await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "ignore env",
    ]);
    await execFileAsync("git", ["-C", repoRoot, "push", "-q"]);
    await writeFile(path.join(repoRoot, ".env.local"), "source=value\n");

    const created = await createWorkspace({ repoRoot });
    expect(await readFile(path.join(created.path, ".env.local"), "utf8")).toBe(
      "source=value\n",
    );
    await writeFile(
      path.join(created.path, ".env.local"),
      "workspace=custom\n",
    );

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await restoreWorkspace(created.workspaceId);

    expect(await readFile(path.join(created.path, ".env.local"), "utf8")).toBe(
      "workspace=custom\n",
    );
  });

  it("round-trips an ignored include file created only inside the workspace", async () => {
    await writeFile(path.join(repoRoot, ".gitignore"), ".env*\n");
    await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "ignore workspace env",
    ]);
    await execFileAsync("git", ["-C", repoRoot, "push", "-q"]);

    const created = await createWorkspace({ repoRoot });
    const workspaceOnly = path.join(created.path, ".env.workspace-only");
    await writeFile(workspaceOnly, "workspace-only=secret\n");
    expect(existsSync(path.join(repoRoot, ".env.workspace-only"))).toBe(false);

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await restoreWorkspace(created.workspaceId);

    expect(await readFile(workspaceOnly, "utf8")).toBe(
      "workspace-only=secret\n",
    );
  });

  it("retries restore idempotently after WIP applied but before its phase write", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "retry.txt"), "durable WIP\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const archived = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: archived.id,
      operation: "restore",
      phase: "prepared",
      sourcePath: archived.path,
      targetPath: archived.path,
      sourceBranch: archived.branch,
      targetBranch: archived.branch,
      createFrom: null,
      archiveSnapshot: archived.archiveSnapshot ?? null,
      archivedHead: archived.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      archived.path,
      archived.branch,
    ]);
    updateWorkspaceLifecyclePhase(archived.id, "worktree-created");
    expect(
      await applyArchiveSnapshotOntoCurrent(
        archived.path,
        archived.archiveSnapshot as string,
        archived.archivedHead as string,
      ),
    ).toBe("applied");
    expect(await readFile(path.join(archived.path, "retry.txt"), "utf8")).toBe(
      "durable WIP\n",
    );
    // Also emulate the narrower crash between `git apply --index` and its
    // cleanup reset: the recovered WIP is present but still staged.
    await execFileAsync("git", ["-C", archived.path, "add", "-A"]);
    await expect(
      execFileAsync("git", [
        "-C",
        archived.path,
        "diff",
        "--cached",
        "--quiet",
      ]),
    ).rejects.toBeTruthy();

    // Simulate the crash: the checkout contains WIP but the durable phase still
    // says worktree-created. Recovery must detect the already-applied delta,
    // preserve it, and restore archive's unstaged-WIP contract.
    const recovery = await reconcileInterruptedWorkspaceLifecycles();
    expect(recovery).toEqual({ recovered: 1, failed: 0 });
    expect(await readFile(path.join(archived.path, "retry.txt"), "utf8")).toBe(
      "durable WIP\n",
    );
    await expect(
      execFileAsync("git", [
        "-C",
        archived.path,
        "diff",
        "--cached",
        "--quiet",
      ]),
    ).resolves.toBeTruthy();
    expect(getWorkspace(archived.id).archivedAt).toBeNull();
  });

  it("restores WIP onto a branch that advanced while archived", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "wip.txt"), "saved WIP\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });

    const other = path.join(workdir, "advanced-branch");
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      other,
      created.branch,
    ]);
    await writeFile(path.join(other, "advanced.txt"), "new commit\n");
    await execFileAsync("git", ["-C", other, "add", "advanced.txt"]);
    await execFileAsync("git", [
      "-C",
      other,
      "commit",
      "-q",
      "-m",
      "advance while archived",
    ]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      other,
    ]);

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.conflicts).toEqual([]);
    expect(
      await readFile(path.join(restored.path, "advanced.txt"), "utf8"),
    ).toBe("new commit\n");
    expect(await readFile(path.join(restored.path, "wip.txt"), "utf8")).toBe(
      "saved WIP\n",
    );
  });

  it("surfaces a conflict when archived WIP overlaps a later branch commit", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "README.md"), "archived WIP\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });

    const other = path.join(workdir, "conflicting-branch");
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      other,
      created.branch,
    ]);
    await writeFile(path.join(other, "README.md"), "later commit\n");
    await execFileAsync("git", ["-C", other, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      other,
      "commit",
      "-q",
      "-m",
      "conflict while archived",
    ]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      other,
    ]);

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.conflicts).toContain("README.md");
    const contents = await readFile(
      path.join(restored.path, "README.md"),
      "utf8",
    );
    expect(contents).toContain("archived WIP");
    expect(contents).toContain("later commit");
  });

  it("refuses to remove a dirty worktree when its Git admin entry prevents a durable snapshot", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "scratch.txt"), "x\n");
    // Simulate the real orphaning: another tool's `git worktree prune`/`gc`
    // removed git's admin entry while the folder stayed on disk. `git worktree
    // remove` then dies with "is not a working tree".
    const adminDir = path.join(
      repoRoot,
      ".git",
      "worktrees",
      path.basename(created.path),
    );
    await rm(adminDir, { recursive: true, force: true });

    // Without a usable gitdir we cannot prove the dirty file was checkpointed.
    // Preserve the folder + live row instead of silently deleting user work.
    await expect(
      archiveWorkspace({
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(existsSync(created.path)).toBe(true);
    expect(getWorkspace(created.workspaceId).archivedAt).toBeNull();
  });

  it("cleans up the archive snapshot ref on hard-delete", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "README.md"), "# changed\n");
    const { archiveSnapshot } = await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    expect(archiveSnapshot).toBeTruthy();

    await deleteWorkspace({
      workspaceId: created.workspaceId,
      includeBranch: false,
    });
    const refGone = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/zeros/archive/${created.workspaceId}`,
    ])
      .then(() => false)
      .catch(() => true);
    expect(refGone).toBe(true);
  });

  it("pruneOrphanArchiveSnapshots drops a ref whose workspace row is gone", async () => {
    const a = await createWorkspace({ repoRoot });
    const row = getWorkspace(a.workspaceId);
    upsertRepoByRoot({ repoRoot, repoSlug: row.repoSlug });
    await writeFile(path.join(a.path, "README.md"), "# changed\n");
    await archiveWorkspace({
      workspaceId: a.workspaceId,
      stashUncommitted: true,
    });
    // Delete a's ROW out-of-band (NOT via deleteWorkspace), orphaning its ref.
    deleteWorkspaceRow(a.workspaceId);

    const dropped = await pruneOrphanArchiveSnapshots();
    expect(dropped).toBeGreaterThanOrEqual(1);
    const refAfter = await execFileAsync("git", [
      "-C",
      repoRoot,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/zeros/archive/${a.workspaceId}`,
    ])
      .then(() => "present")
      .catch(() => "");
    expect(refAfter).toBe("");
  });

  it("prunes stale create/restore branch ownership proofs after publication", async () => {
    const created = await createWorkspace({ repoRoot });
    const pending = await createWorkspace({ repoRoot });
    for (const operation of ["create", "restore"]) {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "update-ref",
        `refs/zeros/${operation}/${created.workspaceId}`,
        "HEAD",
      ]);
    }
    beginWorkspaceLifecycle({
      workspaceId: pending.workspaceId,
      operation: "create",
      phase: "branch-created",
      sourcePath: pending.path,
      targetPath: pending.path,
      sourceBranch: pending.branch,
      targetBranch: pending.branch,
      createFrom: "main",
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: {},
      includeBranch: true,
      startedAt: Date.now(),
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "update-ref",
      `refs/zeros/create/${pending.workspaceId}`,
      pending.branch,
    ]);

    expect(await pruneOrphanWorkspaceBranchOwnershipRefs()).toBe(2);
    for (const operation of ["create", "restore"]) {
      await expect(
        execFileAsync("git", [
          "-C",
          repoRoot,
          "show-ref",
          "--verify",
          `refs/zeros/${operation}/${created.workspaceId}`,
        ]),
      ).rejects.toBeTruthy();
    }
    await expect(
      execFileAsync("git", [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        `refs/zeros/create/${pending.workspaceId}`,
      ]),
    ).resolves.toBeTruthy();
  });

  it("legacy archive (stash_ref only, no archive_snapshot) still restores", async () => {
    const created = await createWorkspace({ repoRoot });
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.email",
      "t@t",
    ]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.name",
      "t",
    ]);
    await writeFile(path.join(created.path, "README.md"), "# legacy\n");
    // Emulate the OLD (pre-v17) archive: a real stash + worktree removal, then a
    // row carrying ONLY stash_ref (no archive_snapshot).
    await execFileAsync("git", [
      "-C",
      created.path,
      "stash",
      "push",
      "--include-untracked",
      "-m",
      `zeros-archive:${created.workspaceId}`,
    ]);
    const stashSha = (
      await execFileAsync("git", ["-C", created.path, "rev-parse", "stash@{0}"])
    ).stdout.trim();
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      created.path,
    ]);
    updateWorkspace(created.workspaceId, {
      // Legacy stash-based archive: archived is now the `archivedAt` flag; status
      // is preserved across archive/restore (orthogonal).
      archivedAt: Date.now(),
      stashRef: stashSha,
    });

    const restored = await restoreWorkspace(created.workspaceId);
    expect(existsSync(restored.path)).toBe(true);
    expect(await readFile(path.join(created.path, "README.md"), "utf8")).toBe(
      "# legacy\n",
    );
    expect(getWorkspace(created.workspaceId).status).toBe("in-progress");
  });

  // ── Option B: "always succeeds" restore (adapts instead of failing) ──

  it("restore preserves a non-worktree folder that occupies the original path", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "README.md"), "# changed\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // A non-empty, non-registered folder may be unrelated user data. Restore
    // must never infer that it is disposable merely because it occupies the
    // workspace's former path.
    await mkdir(created.path, { recursive: true });
    await writeFile(path.join(created.path, "unrelated.txt"), "keep me\n");

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.path).toBe(`${created.path}-2`);
    expect(getWorkspace(created.workspaceId).path).toBe(restored.path);
    expect(restored.adaptations.join(" ")).toContain("without changing");
    const { stdout } = await execFileAsync("git", [
      "-C",
      restored.path,
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    expect(stdout.trim()).toBe("true");
    expect(
      await readFile(path.join(created.path, "unrelated.txt"), "utf8"),
    ).toBe("keep me\n");
    expect(await readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "# changed\n",
    );
  });

  it("restore preserves an empty folder that occupies the original path", async () => {
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await mkdir(created.path, { recursive: true });

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.path).toBe(`${created.path}-2`);
    expect((await stat(created.path)).isDirectory()).toBe(true);
    expect(existsSync(path.join(restored.path, ".git"))).toBe(true);
  });

  it("restore preserves a folder that appears after its target was journaled", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "README.md"), "# changed\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const archived = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: archived.id,
      operation: "restore",
      phase: "prepared",
      sourcePath: archived.path,
      targetPath: archived.path,
      sourceBranch: archived.branch,
      targetBranch: archived.branch,
      createFrom: null,
      archiveSnapshot: archived.archiveSnapshot ?? null,
      archivedHead: archived.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });

    // This is the TOCTOU seam: target selection is durable, then another
    // process creates a plain folder before restore mutates Git.
    await mkdir(archived.path, { recursive: true });
    await writeFile(path.join(archived.path, "external.txt"), "untouched\n");

    const restored = await restoreWorkspace(archived.id);
    expect(restored.path).toBe(`${archived.path}-2`);
    expect(
      await readFile(path.join(archived.path, "external.txt"), "utf8"),
    ).toBe("untouched\n");
    expect(await readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "# changed\n",
    );
  });

  it("forks a fresh path AND rebinds chats when a LIVE worktree holds the original path", async () => {
    const created = await createWorkspace({ repoRoot });
    // A chat anchored at the worktree folder — what a real agent chat looks like.
    // (No resolver wired in this test → workspace_id stays null; we assert the
    // load-bearing part: the chat's FOLDER follows the worktree to its new path,
    // which is what keeps its agent spawns from failing the cwd-exists gate.)
    const chat: ChatRow = {
      id: "chat_rebind",
      folder: created.path,
      agentId: "codex",
      agentName: "Codex",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "rebind me",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    };
    upsertChat(chat);
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // Occupy the EXACT original path with a DIFFERENT live, registered worktree.
    await execFileAsync("git", ["-C", repoRoot, "branch", "squatter-branch"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      created.path,
      "squatter-branch",
    ]);

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.path).not.toBe(created.path); // forked to a fresh sibling
    expect(restored.adaptations.length).toBeGreaterThan(0);
    expect(existsSync(restored.path)).toBe(true);
    // The chat FOLLOWED the worktree to its new path — without this its agent
    // would spawn against the old (squatter-owned) folder and fail.
    expect(getChat("chat_rebind")?.folder).toBe(restored.path);
    expect(getChat("chat_rebind")?.updatedAt).toBeGreaterThan(chat.updatedAt);
    // The squatter worktree is left intact at the original path.
    expect(existsSync(path.join(created.path, ".git"))).toBe(true);
  });

  it("commits an adapted chat rebind and workspace publication atomically", async () => {
    const created = await createWorkspace({ repoRoot });
    const workspace = getWorkspace(created.workspaceId);
    const targetPath = `${workspace.path}-restored`;
    const chat: ChatRow = {
      id: "chat_atomic_rebind",
      folder: workspace.path,
      agentId: null,
      agentName: null,
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "atomic rebind",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    };
    upsertChat(chat);
    beginWorkspaceLifecycle({
      workspaceId: workspace.id,
      operation: "restore",
      phase: "work-applied",
      sourcePath: workspace.path,
      targetPath,
      sourceBranch: workspace.branch,
      targetBranch: workspace.branch,
      createFrom: null,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });

    expect(() =>
      finishWorkspaceLifecycle(workspace.id, { path: targetPath }, () => {
        rebindChatsFolder(workspace.path, targetPath, workspace.id);
        throw new Error("simulated stop before publication");
      }),
    ).toThrow("simulated stop");

    expect(getChat(chat.id)?.folder).toBe(workspace.path);
    expect(getWorkspace(workspace.id).path).toBe(workspace.path);
    expect(getWorkspaceLifecycle(workspace.id)?.phase).toBe("work-applied");
  });

  it("restore forks a new branch when the original is checked out elsewhere", async () => {
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // Check the archived branch out in a separate worktree — git won't let the
    // same branch be checked out twice, so restore must fork.
    const otherWt = path.join(workdir, "other-wt");
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      otherWt,
      created.branch,
    ]);

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.adaptations.length).toBeGreaterThan(0);
    expect(restored.branch).not.toBe(created.branch);
    expect(restored.branch).toContain("restored");
    expect(existsSync(restored.path)).toBe(true);
    // DB reflects the new branch, and the worktree is actually on it.
    expect(getWorkspace(created.workspaceId).branch).toBe(restored.branch);
    const { stdout } = await execFileAsync("git", [
      "-C",
      restored.path,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(stdout.trim()).toBe(restored.branch);
    // The original branch still exists, checked out at the other worktree.
    const { stdout: branches } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      created.branch,
    ]);
    expect(branches.includes(created.branch)).toBe(true);
  });

  it("re-adapts when the source branch is checked out after restore was journaled", async () => {
    const created = await createWorkspace({ repoRoot });
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const archived = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: archived.id,
      operation: "restore",
      phase: "prepared",
      sourcePath: archived.path,
      targetPath: archived.path,
      sourceBranch: archived.branch,
      targetBranch: archived.branch,
      createFrom: null,
      archiveSnapshot: archived.archiveSnapshot ?? null,
      archivedHead: archived.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    const other = path.join(workdir, "late-branch-owner");
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "add",
      other,
      archived.branch,
    ]);

    const restored = await restoreWorkspace(archived.id);
    expect(restored.branch).not.toBe(archived.branch);
    expect(restored.branch).toContain("restored");
    expect(restored.adaptations.join(" ")).toContain(
      "became checked out elsewhere",
    );
    expect(existsSync(path.join(other, ".git"))).toBe(true);
  });

  it("does not adopt an unrelated branch that appears after a missing-branch restore was journaled", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "saved-commit.txt"), "saved\n");
    await execFileAsync("git", ["-C", created.path, "add", "saved-commit.txt"]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "saved branch tip",
    ]);
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const archived = getWorkspace(created.workspaceId);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      archived.branch,
    ]);
    beginWorkspaceLifecycle({
      workspaceId: archived.id,
      operation: "restore",
      phase: "prepared",
      sourcePath: archived.path,
      targetPath: archived.path,
      sourceBranch: archived.branch,
      targetBranch: archived.branch,
      createFrom: archived.archivedHead ?? null,
      archiveSnapshot: archived.archiveSnapshot ?? null,
      archivedHead: archived.archivedHead ?? null,
      adaptations: [
        `Branch "${archived.branch}" was missing, so it was scheduled for recreation.`,
      ],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    // Another process takes the original name at main after the durable choice.
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      archived.branch,
      "main",
    ]);

    const restored = await restoreWorkspace(archived.id);
    expect(restored.branch).not.toBe(archived.branch);
    expect(restored.branch).toContain("restored");
    expect(
      await readFile(path.join(restored.path, "saved-commit.txt"), "utf8"),
    ).toBe("saved\n");
    expect(restored.adaptations.join(" ")).toContain("became occupied");
  });

  it("resumes a restore-owned branch created before its phase write", async () => {
    const created = await createWorkspace({ repoRoot });
    await writeFile(path.join(created.path, "saved.txt"), "saved\n");
    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    const archived = getWorkspace(created.workspaceId);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      archived.branch,
    ]);
    beginWorkspaceLifecycle({
      workspaceId: archived.id,
      operation: "restore",
      phase: "prepared",
      sourcePath: archived.path,
      targetPath: archived.path,
      sourceBranch: archived.branch,
      targetBranch: archived.branch,
      createFrom: archived.archivedHead ?? null,
      archiveSnapshot: archived.archiveSnapshot ?? null,
      archivedHead: archived.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    // Exact crash seam: the branch+proof transaction committed, but SQLite
    // still says prepared and no worktree was added yet.
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      archived.branch,
      archived.archivedHead as string,
    ]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "update-ref",
      `refs/zeros/restore/${archived.id}`,
      archived.archivedHead as string,
    ]);

    const restored = await restoreWorkspace(archived.id);
    expect(restored.branch).toBe(archived.branch);
    expect(restored.adaptations.join(" ")).not.toContain("became occupied");
    expect(await readFile(path.join(restored.path, "saved.txt"), "utf8")).toBe(
      "saved\n",
    );
  });

  it("restore recreates a deleted branch from the saved commit anchor", async () => {
    const created = await createWorkspace({ repoRoot });
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.email",
      "t@t",
    ]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.name",
      "t",
    ]);
    // Commit work so the branch has a distinct tip we can verify is recovered.
    await writeFile(path.join(created.path, "feature.txt"), "feature work\n");
    await execFileAsync("git", ["-C", created.path, "add", "."]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "commit",
      "-q",
      "-m",
      "feature commit",
    ]);
    const { stdout: tipBefore } = await execFileAsync("git", [
      "-C",
      created.path,
      "rev-parse",
      "HEAD",
    ]);

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    // archived_head must hold the branch tip we captured at archive time.
    expect(getWorkspace(created.workspaceId).archivedHead).toBe(
      tipBefore.trim(),
    );
    // Delete the branch out-of-band (external `git branch -D`).
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      created.branch,
    ]);

    const restored = await restoreWorkspace(created.workspaceId);
    expect(restored.adaptations.some((a) => a.includes("missing"))).toBe(true);
    expect(existsSync(restored.path)).toBe(true);
    // Branch recreated at the exact archived tip → the committed file is back.
    expect(existsSync(path.join(restored.path, "feature.txt"))).toBe(true);
    const { stdout: tipAfter } = await execFileAsync("git", [
      "-C",
      restored.path,
      "rev-parse",
      "HEAD",
    ]);
    expect(tipAfter.trim()).toBe(tipBefore.trim());
    expect(getWorkspace(created.workspaceId).status).toBe("in-progress");
    await expect(
      execFileAsync("git", [
        "-C",
        repoRoot,
        "show-ref",
        "--verify",
        `refs/zeros/restore/${created.workspaceId}`,
      ]),
    ).rejects.toBeTruthy();
  });

  it("keeps the deleted branch anchor reachable through aggressive git gc", async () => {
    const created = await createWorkspace({ repoRoot });
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.email",
      "t@t",
    ]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "config",
      "user.name",
      "t",
    ]);
    await writeFile(path.join(created.path, "pinned.txt"), "keep commit\n");
    await execFileAsync("git", ["-C", created.path, "add", "pinned.txt"]);
    await execFileAsync("git", [
      "-C",
      created.path,
      "commit",
      "-q",
      "-m",
      "archive-only tip",
    ]);
    const tip = (
      await execFileAsync("git", ["-C", created.path, "rev-parse", "HEAD"])
    ).stdout.trim();

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "-D",
      created.branch,
    ]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "reflog",
      "expire",
      "--expire=now",
      "--all",
    ]);
    await execFileAsync("git", ["-C", repoRoot, "gc", "--prune=now"]);

    const restored = await restoreWorkspace(created.workspaceId);
    const restoredTip = (
      await execFileAsync("git", ["-C", restored.path, "rev-parse", "HEAD"])
    ).stdout.trim();
    expect(restoredTip).toBe(tip);
    expect(await readFile(path.join(restored.path, "pinned.txt"), "utf8")).toBe(
      "keep commit\n",
    );
  });

  it("deletes a workspace and optionally its branch", async () => {
    const created = await createWorkspace({ repoRoot });
    await deleteWorkspace({
      workspaceId: created.workspaceId,
      includeBranch: true,
    });
    // DB row gone.
    expect(() => getWorkspace(created.workspaceId)).toThrowError(
      /WORKSPACE_NOT_FOUND|not found/,
    );
    // Branch gone.
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      created.branch,
    ]);
    expect(stdout.trim()).toBe("");
  });

  it("delete with includeBranch=false keeps the branch", async () => {
    const created = await createWorkspace({ repoRoot });
    await deleteWorkspace({
      workspaceId: created.workspaceId,
      includeBranch: false,
    });
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      created.branch,
    ]);
    expect(stdout.includes(created.branch)).toBe(true);
  });

  it("deleting one missing workspace never prunes another missing worktree registration", async () => {
    const target = await createWorkspace({ repoRoot });
    const otherInstance = await createWorkspace({ repoRoot });
    await rm(target.path, { recursive: true, force: true });
    await rm(otherInstance.path, { recursive: true, force: true });

    await deleteWorkspace({
      workspaceId: target.workspaceId,
      includeBranch: false,
    });

    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "list",
      "--porcelain",
    ]);
    expect(stdout).not.toContain(`worktree ${target.path}\n`);
    expect(stdout).toContain(`worktree ${otherInstance.path}\n`);
    expect(getWorkspace(otherInstance.workspaceId).present).toBe(false);
    expect(() => getWorkspace(target.workspaceId)).toThrow(/not found/i);
  });

  it("finishes a delete interrupted after worktree removal", async () => {
    const created = await createWorkspace({ repoRoot });
    const row = getWorkspace(created.workspaceId);
    beginWorkspaceLifecycle({
      workspaceId: row.id,
      operation: "delete",
      phase: "prepared",
      sourcePath: row.path,
      targetPath: null,
      sourceBranch: row.branch,
      targetBranch: null,
      createFrom: null,
      archiveSnapshot: null,
      archivedHead: null,
      adaptations: [],
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    });
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "worktree",
      "remove",
      "--force",
      row.path,
    ]);
    updateWorkspaceLifecyclePhase(row.id, "worktree-removed");

    const recovery = await reconcileInterruptedWorkspaceLifecycles();
    expect(recovery).toEqual({ recovered: 1, failed: 0 });
    expect(() => getWorkspace(row.id)).toThrow(/not found/i);
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      row.branch,
    ]);
    expect(stdout).toContain(row.branch);
  });

  it("removing a repo deletes its worktrees but never touches the source", async () => {
    // Mirrors the destructive core of the "Remove repository" flow: delete
    // EVERY Zeros worktree for a repo (includeBranch:false), and assert the
    // source checkout is left 100% intact — the user's "very important" rule.
    const a = await createWorkspace({ repoRoot });
    const b = await createWorkspace({ repoRoot });
    const slug = getWorkspace(a.workspaceId).repoSlug;

    // A user-authored file in the SOURCE repo that must survive untouched.
    const precious = path.join(repoRoot, "PRECIOUS.txt");
    await writeFile(precious, "do not delete me\n");

    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    // Worktrees live OUTSIDE the source tree (under the Zeros workspaces root).
    expect(a.path.startsWith(worktreesRoot())).toBe(true);
    expect(a.path.startsWith(repoRoot)).toBe(false);

    // Remove every worktree, exactly as the renderer's removal loop does.
    for (const ws of listWorkspaces({ repoSlug: slug })) {
      await deleteWorkspace({ workspaceId: ws.id, includeBranch: false });
    }

    // Worktree folders + DB rows are gone.
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(false);
    expect(listWorkspaces({ repoSlug: slug })).toHaveLength(0);
    expect(() => getWorkspace(a.workspaceId)).toThrowError(
      /WORKSPACE_NOT_FOUND|not found/,
    );

    // The SOURCE checkout is completely untouched: the folder, its .git, the
    // original README, and the user's file all survive with content intact.
    expect(existsSync(repoRoot)).toBe(true);
    expect(existsSync(path.join(repoRoot, ".git"))).toBe(true);
    expect(await readFile(path.join(repoRoot, "README.md"), "utf8")).toBe(
      "# test\n",
    );
    expect(await readFile(precious, "utf8")).toBe("do not delete me\n");

    // includeBranch:false → the source repo's branches are left in place too.
    const { stdout } = await execFileAsync("git", [
      "-C",
      repoRoot,
      "branch",
      "--list",
      a.branch,
    ]);
    expect(stdout.includes(a.branch)).toBe(true);
  });

  it("resolves a setup script for background run + builds a scrubbed ZEROS_* env", async () => {
    const scriptPath = path.join(repoRoot, "setup-test.sh");
    await writeFile(scriptPath, "#!/usr/bin/env bash\necho hi\n", {
      mode: 0o755,
    });
    await execFileAsync("git", ["-C", repoRoot, "add", "setup-test.sh"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "add setup",
    ]);

    const created = await createWorkspace({
      repoRoot,
      setupScript: "setup-test.sh",
    });
    // Setup runs in the BACKGROUND now — create returns the resolved command
    // (the quoted script path) and marks the row "running"; it does NOT run the
    // script synchronously.
    expect(created.setupCommand).toContain("setup-test.sh");
    expect(getWorkspace(created.workspaceId).setupState).toBe("running");

    // The setup PTY env carries the ZEROS_* context + a real-terminal TERM, and
    // scrubs host secrets (H6) — the property the old synchronous test covered.
    process.env.ZEROS_TEST_SECRET = "leak-me";
    try {
      const env = await buildSetupCommandEnv({
        workspaceId: created.workspaceId,
        worktreePath: created.path,
        repoRoot,
        baseBranch: "main",
      });
      expect(env.ZEROS_WORKSPACE_ID).toBe(created.workspaceId);
      expect(env.ZEROS_WORKTREE_PATH).toBe(created.path);
      expect(env.ZEROS_REPO_ROOT).toBe(repoRoot);
      expect(env.ZEROS_BASE_BRANCH).toBe("main");
      expect(env.TERM).toBe("xterm-256color");
      expect(env.ZEROS_TEST_SECRET).toBeUndefined(); // scrubbed
    } finally {
      delete process.env.ZEROS_TEST_SECRET;
    }
  });

  it("a failing setup script does NOT roll the workspace back (background, non-fatal)", async () => {
    const scriptPath = path.join(repoRoot, "fail.sh");
    await writeFile(scriptPath, "#!/usr/bin/env bash\nexit 17\n", {
      mode: 0o755,
    });
    await execFileAsync("git", ["-C", repoRoot, "add", "fail.sh"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "add fail",
    ]);

    // A setup that would fail no longer aborts create — the worktree is kept and
    // the failure surfaces in the Setup tab (Rerun available).
    const created = await createWorkspace({ repoRoot, setupScript: "fail.sh" });
    expect(created.setupCommand).toContain("fail.sh");
    expect(listWorkspaces().length).toBe(1);
  });

  it("a failing copyPaths STILL rolls the workspace back (explicit, fatal)", async () => {
    // File provisioning the caller explicitly requested is still fatal: a
    // missing copyPaths source tears the half-created worktree + row down.
    await expect(
      createWorkspace({ repoRoot, copyPaths: ["definitely-missing.env"] }),
    ).rejects.toThrow();
    expect(listWorkspaces()).toEqual([]);
  });

  it("copyPaths survives archive even when it is outside current files-to-copy settings", async () => {
    await writeFile(path.join(repoRoot, ".gitignore"), "runtime.secret\n");
    await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
    await execFileAsync("git", [
      "-C",
      repoRoot,
      "commit",
      "-q",
      "-m",
      "ignore explicit runtime secret",
    ]);
    await execFileAsync("git", ["-C", repoRoot, "push", "-q"]);
    await writeFile(path.join(repoRoot, "runtime.secret"), "source=value\n");
    const created = await createWorkspace({
      repoRoot,
      copyPaths: ["runtime.secret"],
    });
    expect(
      await readFile(path.join(created.path, "runtime.secret"), "utf8"),
    ).toBe("source=value\n");
    await writeFile(
      path.join(created.path, "runtime.secret"),
      "workspace=custom\n",
    );

    await archiveWorkspace({
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await restoreWorkspace(created.workspaceId);

    expect(
      await readFile(path.join(created.path, "runtime.secret"), "utf8"),
    ).toBe("workspace=custom\n");
  });

  it("stamps present:false when the worktree folder is gone, true when it exists", async () => {
    const created = await createWorkspace({ repoRoot });

    // Freshly created — folder on disk, so both read paths see it present.
    expect(getWorkspace(created.workspaceId).present).toBe(true);
    expect(
      listWorkspaces().find((w) => w.id === created.workspaceId)?.present,
    ).toBe(true);

    // Out-of-band wipe (rm -rf / Finder trash / a parallel tool) that
    // does NOT go through deleteWorkspace — the DB row survives but the
    // folder is gone. This is exactly what `present` exists to surface.
    await rm(created.path, { recursive: true, force: true });

    expect(getWorkspace(created.workspaceId).present).toBe(false);
    expect(
      listWorkspaces().find((w) => w.id === created.workspaceId)?.present,
    ).toBe(false);
  });

  // ── Settings → Git: the branch name prefix ──────────────────────────────
  //
  // End-to-end rather than unit, because the whole point of these is that the
  // setting reaches `git branch` intact: the join rule, the fallbacks, and the
  // one shape that used to break creation outright.
  describe("branch name prefix", () => {
    /** Write the repo layer — it outranks the user layer, so these don't
     *  depend on whatever ~/.zeros/settings.toml the test machine has. */
    async function setPrefix(toml: string): Promise<void> {
      await mkdir(path.join(repoRoot, ".zeros"), { recursive: true });
      await writeFile(
        path.join(repoRoot, ".zeros", "settings.toml"),
        `[git]\n${toml}\n`,
      );
    }

    it("joins a custom prefix with exactly one slash", async () => {
      await setPrefix('branch_prefix_type = "custom"\nbranch_prefix = "hello"');
      const ws = await createWorkspace({ repoRoot });
      // The bug this pins: a bare `hello` used to be spliced in verbatim and
      // produced the flat `helloCream`, which nobody reads as a namespace.
      expect(ws.branch).toMatch(/^hello\/[A-Z][a-z]+/);
    });

    it("treats `hello`, `hello/` and `/hello/` as the same setting", async () => {
      for (const typed of ["hello", "hello/", "/hello/"]) {
        await setPrefix(
          `branch_prefix_type = "custom"\nbranch_prefix = "${typed}"`,
        );
        const ws = await createWorkspace({ repoRoot });
        expect(ws.branch, `for ${typed}`).toMatch(/^hello\/[A-Z][a-z]+/);
      }
    });

    it("supports a multi-segment namespace", async () => {
      await setPrefix(
        'branch_prefix_type = "custom"\nbranch_prefix = "team/squad"',
      );
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^team\/squad\/[A-Z][a-z]+/);
    });

    it("creates a bare branch for `none`, with no dangling separator", async () => {
      await setPrefix('branch_prefix_type = "none"');
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^[A-Z][a-z]+/);
      expect(ws.branch).not.toContain("/");
    });

    it("falls back to the default when the prefix is unusable", async () => {
      // A bad setting must degrade the NAME, never block creation.
      await setPrefix(
        'branch_prefix_type = "custom"\nbranch_prefix = "--upload-pack=evil"',
      );
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^zeros\//);
    });

    it("falls back when the namespace already exists as a branch", async () => {
      // Git stores loose refs as files, so `refs/heads/hello` being a file
      // makes `refs/heads/hello/Cream` impossible to create. Without the D/F
      // check this configuration failed EVERY workspace create with git's
      // "cannot lock ref … exists", from a setting made once, elsewhere.
      await execFileAsync("git", ["branch", "hello"], { cwd: repoRoot });
      await setPrefix('branch_prefix_type = "custom"\nbranch_prefix = "hello"');
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^zeros\//);
    });

    it("falls back through a blocked namespace in a parent segment", async () => {
      // `refs/heads/team` blocks `refs/heads/team/squad/Cream` just as surely
      // as `refs/heads/team/squad` would.
      await execFileAsync("git", ["branch", "team"], { cwd: repoRoot });
      await setPrefix(
        'branch_prefix_type = "custom"\nbranch_prefix = "team/squad"',
      );
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^zeros\//);
    });

    it("drops to no prefix when even the default namespace is blocked", async () => {
      await execFileAsync("git", ["branch", "hello"], { cwd: repoRoot });
      await execFileAsync("git", ["branch", "zeros"], { cwd: repoRoot });
      await setPrefix('branch_prefix_type = "custom"\nbranch_prefix = "hello"');
      const ws = await createWorkspace({ repoRoot });
      expect(ws.branch).toMatch(/^[A-Z][a-z]+/);
      expect(ws.branch).not.toContain("/");
    });

    it("does not hand out a colour buried in someone else's ref path", async () => {
      // `refs/heads/<X>/Cream/wip` makes `refs/heads/<X>/Cream` a DIRECTORY, so
      // reusing `Cream` cannot create the ref — git fails with "cannot lock
      // ref". branchDisplayName can't see it (a `wip` tail isn't allocator-
      // shaped, so it returns the whole ref), which is why the used-name scan
      // reserves an allocator name found in ANY path component.
      await execFileAsync("git", ["branch", "hello/Cream/wip"], {
        cwd: repoRoot,
      });
      await setPrefix('branch_prefix_type = "custom"\nbranch_prefix = "hello"');
      for (let i = 0; i < 6; i += 1) {
        const ws = await createWorkspace({ repoRoot });
        expect(ws.branch).not.toBe("hello/Cream");
      }
    });

    it("does not hand out a bare colour that already has children", async () => {
      // Same conflict from the other direction: with no prefix the branch IS
      // the bare name, so an unrelated `refs/heads/Bone/wip` blocks `Bone`.
      await execFileAsync("git", ["branch", "Bone/wip"], { cwd: repoRoot });
      await setPrefix('branch_prefix_type = "none"');
      for (let i = 0; i < 6; i += 1) {
        const ws = await createWorkspace({ repoRoot });
        expect(ws.branch).not.toBe("Bone");
      }
    });

    it("names the checkout folder after the workspace, not the namespace", async () => {
      await setPrefix(
        'branch_prefix_type = "custom"\nbranch_prefix = "team/squad"',
      );
      const ws = await createWorkspace({ repoRoot });
      // A prefix must not nest the worktree or leak into its folder name —
      // the whole namespace lives in the ref, and the directory stays flat.
      expect(path.basename(ws.path)).toBe(ws.branch.split("/").pop());
    });
  });
});

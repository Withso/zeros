// Phase 5 cross-tool interop. Tests build fixture repos with worktrees
// that mimic other tools' markers, then assert the origin detection.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { worktreeSeedPath } from "../../db/paths";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  adoptExistingWorktree,
  archiveWorkspace,
  closeState,
  createWorkspace,
  createWorkspaceFromBranch,
  deleteWorkspace,
  getCreateWorkspaceFromBranchStatus,
  listAllBranches,
  listWorkspaces,
  restoreWorkspace,
  setStateRootForTesting,
  worktreesRoot,
} from "..";

const execFileAsync = promisify(execFile);

async function initRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "https://github.com/Acme/example.git"],
    { cwd: repoRoot },
  );
  await execFileAsync("git", ["config", "user.email", "t@t"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, "README.md"), "# init\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

describe("cross-tool interop", () => {
  let workdir: string;
  let repoRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-xtool-test-"));
    repoRoot = path.join(workdir, "repo");
    stateRoot = path.join(workdir, "state");
    setStateRootForTesting(stateRoot);
    await initRepo(repoRoot);
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

  describe("listAllBranches", () => {
    it("detects zeros origin from .zeros/workspace.json marker", async () => {
      const created = await createWorkspace({ repoRoot });
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const zerosOnes = branches.filter((b) => b.origin === "zeros");
      expect(zerosOnes.find((b) => b.name === created.branch)).toBeDefined();
    });

    it("detects cursor origin from .cursor/worktrees.json marker", async () => {
      // Fake a Cursor-style worktree.
      const cursorWt = path.join(workdir, "cursor-wt");
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "-b",
        "cursor/feature-x",
        cursorWt,
      ]);
      await mkdir(path.join(cursorWt, ".cursor"), { recursive: true });
      await writeFile(
        path.join(cursorWt, ".cursor", "worktrees.json"),
        JSON.stringify({}),
      );
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "cursor/feature-x");
      expect(found).toBeDefined();
      expect(found?.origin).toBe("cursor");
      expect(found?.isCheckedOut).toBe(true);
    });

    it("detects superset origin from .superset/config.json marker", async () => {
      const supersetWt = path.join(workdir, "superset-wt");
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "-b",
        "ss-feature",
        supersetWt,
      ]);
      await mkdir(path.join(supersetWt, ".superset"), { recursive: true });
      await writeFile(
        path.join(supersetWt, ".superset", "config.json"),
        JSON.stringify({}),
      );
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "ss-feature");
      expect(found?.origin).toBe("superset");
    });

    it("detects cursor branch by prefix when no marker", async () => {
      // Create a branch but no worktree — naming heuristic fallback.
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "branch",
        "cursor/orphan-feature",
      ]);
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "cursor/orphan-feature");
      expect(found?.origin).toBe("cursor");
      expect(found?.isCheckedOut).toBe(false);
    });

    it("detects conductor branch by city-name heuristic", async () => {
      await execFileAsync("git", ["-C", repoRoot, "branch", "delhi"]);
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "delhi");
      expect(found?.origin).toBe("conductor");
    });

    it("falls back to unknown for branches with no signal", async () => {
      await execFileAsync("git", ["-C", repoRoot, "branch", "random-feature"]);
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "random-feature");
      expect(found?.origin).toBe("unknown");
    });

    it("reports tipSha + lastCommitDate", async () => {
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      expect(branches.length).toBeGreaterThan(0);
      for (const b of branches) {
        expect(b.tipSha).toMatch(/^[0-9a-f]{40}$/);
        expect(b.lastCommitDate).toBeGreaterThan(0);
      }
    });
  });

  describe("createWorkspaceFromBranch", () => {
    it("uses the registered slug for a local-only repository with no remote", async () => {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "remote",
        "remove",
        "origin",
      ]);
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "branch",
        "feature/local-only",
      ]);

      const result = await createWorkspaceFromBranch({
        repoRoot,
        repoSlug: "local-repository",
        branchName: "feature/local-only",
      });

      expect(
        listWorkspaces().find(
          (workspace) => workspace.id === result.workspaceId,
        ),
      ).toMatchObject({
        repoSlug: "local-repository",
        branch: "feature/local-only",
        present: true,
      });
    });

    it("creates a workspace adopting an existing branch", async () => {
      // First create a branch directly in the root repo (simulating a
      // branch made by another tool).
      await execFileAsync("git", ["-C", repoRoot, "branch", "cursor/adopt-me"]);
      const result = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "cursor/adopt-me",
      });
      expect(result.workspaceId).toMatch(/^ws_[0-9a-f]{6}-/);
      expect(result.branch).toBe("cursor/adopt-me");
      // The seed lives in app-data now (not the worktree); listing detects us
      // via the registry below.
      expect(existsSync(path.join(result.path, ".zeros"))).toBe(false);
      const seed = JSON.parse(
        await readFile(worktreeSeedPath(result.path), "utf8"),
      );
      expect(seed.branch).toBe("cursor/adopt-me");
      // Listed via the cross-tool listing it should now appear as zeros.
      const branches = await listAllBranches({
        repoSlug: "acme-example",
        repoRoot,
      });
      const found = branches.find((b) => b.name === "cursor/adopt-me");
      expect(found?.origin).toBe("zeros"); // marker file flips ownership
    });

    it("single-flights concurrent opens of the same branch", async () => {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "branch",
        "feature/open-once",
      ]);
      const options = {
        repoRoot,
        branchName: "feature/open-once",
      };
      const first = createWorkspaceFromBranch(options);
      expect(
        getCreateWorkspaceFromBranchStatus({
          ...options,
          repoSlug: "acme-example",
        }),
      ).toMatchObject({
        active: true,
        operation: "create",
      });
      const second = createWorkspaceFromBranch({
        ...options,
        prNumber: 77,
        prUrl: "https://github.com/Acme/example/pull/77",
      });
      expect(second).toBe(first);

      const [a, b] = await Promise.all([first, second]);
      expect(b).toEqual(a);
      expect(
        getCreateWorkspaceFromBranchStatus({
          ...options,
          repoSlug: "acme-example",
        }),
      ).toMatchObject({
        active: false,
        operation: null,
        phase: null,
        workspace: { id: a.workspaceId, path: a.path },
      });
      expect(
        listWorkspaces().filter(
          (workspace) => workspace.branch === options.branchName,
        ),
      ).toHaveLength(1);
      expect(
        listWorkspaces().find(
          (workspace) => workspace.branch === options.branchName,
        ),
      ).toMatchObject({
        status: "in-review",
        prNumber: 77,
        prUrl: "https://github.com/Acme/example/pull/77",
      });
    });

    it("attaches an existing PR (prNumber/prUrl/status) when opening it", async () => {
      // Opening a PR by its head branch should link the PR so the Review tab
      // loads it (and a "Create draft PR" can't fire a duplicate that 422s).
      await execFileAsync("git", ["-C", repoRoot, "branch", "feature/with-pr"]);
      const result = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "feature/with-pr",
        prNumber: 42,
        prUrl: "https://github.com/Acme/example/pull/42",
      });
      const ws = listWorkspaces().find((w) => w.id === result.workspaceId);
      expect(ws?.prNumber).toBe(42);
      expect(ws?.prUrl).toBe("https://github.com/Acme/example/pull/42");
      expect(ws?.status).toBe("in-review");
    });

    it("does not reuse an archived workspace path for a branch with the same sanitized name", async () => {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "branch",
        "feature/path-name",
      ]);
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "branch",
        "feature-path-name",
      ]);
      const archivedOwner = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "feature/path-name",
      });
      await archiveWorkspace({
        workspaceId: archivedOwner.workspaceId,
        stashUncommitted: true,
      });

      const next = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "feature-path-name",
      });
      expect(next.path).toBe(`${archivedOwner.path}-2`);
      await archiveWorkspace({
        workspaceId: next.workspaceId,
        stashUncommitted: true,
      });
      await mkdir(archivedOwner.path, { recursive: true });
      await writeFile(path.join(archivedOwner.path, "FOREIGN.txt"), "keep\n");

      const restored = await restoreWorkspace(archivedOwner.workspaceId);
      expect(restored.path).toBe(`${archivedOwner.path}-3`);
      expect(
        await readFile(path.join(archivedOwner.path, "FOREIGN.txt"), "utf8"),
      ).toBe("keep\n");
    });

    it("seeds gitignored config files from the main checkout (files-to-copy parity)", async () => {
      // Isolate the user settings layer so the default .env* patterns apply.
      const userDir = path.join(workdir, "user-settings");
      await mkdir(userDir, { recursive: true });
      process.env.ZEROS_USER_SETTINGS_DIR = userDir;
      try {
        await writeFile(path.join(repoRoot, ".gitignore"), ".env*\n");
        await writeFile(path.join(repoRoot, ".env"), "root-secret\n");
        await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "commit",
          "-q",
          "-m",
          "ignore env",
        ]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "branch",
          "feature/needs-env",
        ]);
        const result = await createWorkspaceFromBranch({
          repoRoot,
          branchName: "feature/needs-env",
        });
        // The from-branch worktree gets the main checkout's .env — a PR
        // workspace must not start without the user's configured seeds.
        expect(await readFile(path.join(result.path, ".env"), "utf8")).toBe(
          "root-secret\n",
        );
      } finally {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      }
    });

    it("does not clobber a file the branch itself committed at a seed path", async () => {
      const userDir = path.join(workdir, "user-settings2");
      await mkdir(userDir, { recursive: true });
      process.env.ZEROS_USER_SETTINGS_DIR = userDir;
      try {
        // The branch COMMITS a .env (bad practice, but it exists in the wild);
        // main's checkout has a DIFFERENT gitignored .env. The branch's own
        // committed file must win in its worktree.
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "checkout",
          "-q",
          "-b",
          "feature/own-env",
        ]);
        await writeFile(path.join(repoRoot, ".env"), "branch-committed\n");
        await execFileAsync("git", ["-C", repoRoot, "add", "-f", ".env"]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "commit",
          "-q",
          "-m",
          "commit env",
        ]);
        await execFileAsync("git", ["-C", repoRoot, "checkout", "-q", "main"]);
        await writeFile(path.join(repoRoot, ".gitignore"), ".env*\n");
        await writeFile(path.join(repoRoot, ".env"), "main-local\n");
        await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "commit",
          "-q",
          "-m",
          "ignore env",
        ]);
        const result = await createWorkspaceFromBranch({
          repoRoot,
          branchName: "feature/own-env",
        });
        expect(await readFile(path.join(result.path, ".env"), "utf8")).toBe(
          "branch-committed\n",
        );
      } finally {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      }
    });

    it("skips seeding when seedFiles:false (remote-client parity)", async () => {
      const userDir = path.join(workdir, "user-settings3");
      await mkdir(userDir, { recursive: true });
      process.env.ZEROS_USER_SETTINGS_DIR = userDir;
      try {
        await writeFile(path.join(repoRoot, ".gitignore"), ".env*\n");
        await writeFile(path.join(repoRoot, ".env"), "root-secret\n");
        await execFileAsync("git", ["-C", repoRoot, "add", ".gitignore"]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "commit",
          "-q",
          "-m",
          "ignore env",
        ]);
        await execFileAsync("git", [
          "-C",
          repoRoot,
          "branch",
          "feature/remote-open",
        ]);
        const result = await createWorkspaceFromBranch({
          repoRoot,
          branchName: "feature/remote-open",
          seedFiles: false,
        });
        expect(existsSync(path.join(result.path, ".env"))).toBe(false);
      } finally {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      }
    });

    it("creates a workspace from a city-named branch", async () => {
      await execFileAsync("git", ["-C", repoRoot, "branch", "tokyo"]);
      const result = await createWorkspaceFromBranch({
        repoRoot,
        branchName: "tokyo",
        sourceTool: "conductor",
      });
      expect(result.branch).toBe("tokyo");
      // Seed is in app-data now (not the worktree); listing detects us via the
      // registry. Verify the seed exists there and no .zeros in the worktree.
      expect(existsSync(path.join(result.path, ".zeros"))).toBe(false);
      const seed = JSON.parse(
        await readFile(worktreeSeedPath(result.path), "utf8"),
      );
      expect(seed.branch).toBe("tokyo");
    });

    it("throws BRANCH_IN_USE when the branch is already checked out elsewhere", async () => {
      const otherWt = path.join(workdir, "other");
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "-b",
        "held-by-other",
        otherWt,
      ]);
      await expect(
        createWorkspaceFromBranch({
          repoRoot,
          branchName: "held-by-other",
        }),
      ).rejects.toMatchObject({ code: "BRANCH_IN_USE" });
    });

    it("rejects non-existent branches", async () => {
      await expect(
        createWorkspaceFromBranch({
          repoRoot,
          branchName: "does-not-exist",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("adoptExistingWorktree", () => {
    // A linked worktree created by another tool. Adoption is stamped durably;
    // location alone is never treated as ownership.
    async function addExternalWorktree(
      branch: string,
      dir: string,
    ): Promise<string> {
      await execFileAsync("git", [
        "-C",
        repoRoot,
        "worktree",
        "add",
        "-b",
        branch,
        dir,
      ]);
      return dir;
    }

    it("adopts an external worktree in place (DB row points at the real path)", async () => {
      const wt = await addExternalWorktree(
        "feature/ext",
        path.join(workdir, "ext-adopt"),
      );
      const res = await adoptExistingWorktree({
        repoRoot,
        worktreePath: wt,
        branchName: "feature/ext",
        repoSlug: "acme-example",
      });
      expect(res.workspaceId).toMatch(/^ws_[0-9a-f]{6}-/);
      expect(res.branch).toBe("feature/ext");
      expect(res.path).toBe(wt);
      // The registered row points at the EXTERNAL path, status active.
      const row = listWorkspaces({}).find((w) => w.path === wt);
      expect(row).toBeDefined();
      expect(row?.status).toBe("in-progress");
      // Crash-recovery seed is written to app-data, NOT a .zeros/ in the worktree.
      expect(existsSync(path.join(wt, ".zeros"))).toBe(false);
      expect(existsSync(worktreeSeedPath(wt))).toBe(true);
    });

    it("is idempotent and single-flighted on the worktree path", async () => {
      const wt = await addExternalWorktree(
        "feature/idem",
        path.join(workdir, "ext-idem"),
      );
      const opts = {
        repoRoot,
        worktreePath: wt,
        branchName: "feature/idem",
        repoSlug: "acme-example",
      };
      const first = adoptExistingWorktree(opts);
      const second = adoptExistingWorktree(opts);
      expect(second).toBe(first);
      const [a, concurrent] = await Promise.all([first, second]);
      expect(concurrent).toEqual(a);
      const b = await adoptExistingWorktree(opts);
      expect(b.workspaceId).toBe(a.workspaceId);
      // Exactly one row for that path — no duplicate insert on re-adopt.
      expect(listWorkspaces({}).filter((w) => w.path === wt)).toHaveLength(1);
    });

    it("refuses a second workspace for an already-adopted branch", async () => {
      const wt = await addExternalWorktree(
        "feature/dup",
        path.join(workdir, "ext-dup-a"),
      );
      await adoptExistingWorktree({
        repoRoot,
        worktreePath: wt,
        branchName: "feature/dup",
        repoSlug: "acme-example",
      });
      // A different (existing) path but the same branch → branch-collision guard.
      const other = path.join(workdir, "ext-dup-b");
      await mkdir(other, { recursive: true });
      await expect(
        adoptExistingWorktree({
          repoRoot,
          worktreePath: other,
          branchName: "feature/dup",
          repoSlug: "acme-example",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ALREADY_EXISTS" });
    });

    it("rejects a worktree path that no longer exists", async () => {
      await expect(
        adoptExistingWorktree({
          repoRoot,
          worktreePath: path.join(workdir, "does-not-exist"),
          branchName: "feature/ghost",
          repoSlug: "acme-example",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("rejects a stale adoption path that is not this repository's worktree", async () => {
      const unrelated = path.join(workdir, "unrelated-folder");
      await mkdir(unrelated, { recursive: true });
      await expect(
        adoptExistingWorktree({
          repoRoot,
          worktreePath: unrelated,
          branchName: "feature/stale",
          repoSlug: "acme-example",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(listWorkspaces({}).some((w) => w.path === unrelated)).toBe(false);
    });

    it("rejects a stale picker branch after the external worktree changes", async () => {
      const wt = await addExternalWorktree(
        "feature/current",
        path.join(workdir, "ext-branch-changed"),
      );
      await expect(
        adoptExistingWorktree({
          repoRoot,
          worktreePath: wt,
          branchName: "feature/previous",
          repoSlug: "acme-example",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(listWorkspaces({}).some((w) => w.path === wt)).toBe(false);
    });

    it("refuses to ARCHIVE an adopted worktree, leaving the folder intact", async () => {
      const wt = await addExternalWorktree(
        "feature/arch",
        path.join(workdir, "ext-arch"),
      );
      const res = await adoptExistingWorktree({
        repoRoot,
        worktreePath: wt,
        branchName: "feature/arch",
        repoSlug: "acme-example",
      });
      // The guard must fire BEFORE the stash+remove path that would delete the
      // user's external worktree.
      await expect(
        archiveWorkspace({
          workspaceId: res.workspaceId,
          stashUncommitted: true,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(existsSync(wt)).toBe(true);
    });

    it("REMOVE drops the row but keeps the external folder + branch (the ~/qa/r1-wt guard)", async () => {
      const wt = await addExternalWorktree(
        "feature/keep",
        path.join(workdir, "ext-keep"),
      );
      // A user file in the adopted worktree must survive removal.
      await writeFile(path.join(wt, "user-file.txt"), "keep me\n");
      const res = await adoptExistingWorktree({
        repoRoot,
        worktreePath: wt,
        branchName: "feature/keep",
        repoSlug: "acme-example",
      });
      await deleteWorkspace({
        workspaceId: res.workspaceId,
        includeBranch: false,
      });
      // DB row gone…
      expect(listWorkspaces({}).find((w) => w.path === wt)).toBeUndefined();
      // …but the on-disk worktree, the user's file, and the branch all survive.
      expect(existsSync(wt)).toBe(true);
      expect(existsSync(path.join(wt, "user-file.txt"))).toBe(true);
      await expect(
        execFileAsync("git", [
          "-C",
          repoRoot,
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/feature/keep",
        ]),
      ).resolves.toBeDefined();
    });

    it("keeps an adopted folder and branch even when another tool placed it under Zeros' root", async () => {
      const managedParent = path.join(worktreesRoot(), "foreign-owner");
      await mkdir(managedParent, { recursive: true });
      const wt = await addExternalWorktree(
        "feature/inside-managed-root",
        path.join(managedParent, "inside"),
      );
      await writeFile(path.join(wt, "FOREIGN.txt"), "keep\n");
      const adopted = await adoptExistingWorktree({
        repoRoot,
        worktreePath: wt,
        branchName: "feature/inside-managed-root",
        repoSlug: "acme-example",
      });

      await expect(
        archiveWorkspace({
          workspaceId: adopted.workspaceId,
          stashUncommitted: true,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await deleteWorkspace({
        workspaceId: adopted.workspaceId,
        includeBranch: true,
      });

      expect(await readFile(path.join(wt, "FOREIGN.txt"), "utf8")).toBe(
        "keep\n",
      );
      await expect(
        execFileAsync("git", [
          "-C",
          repoRoot,
          "show-ref",
          "--verify",
          "refs/heads/feature/inside-managed-root",
        ]),
      ).resolves.toBeTruthy();
    });
  });
});

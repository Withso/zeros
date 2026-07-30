// Late seed pass — the guaranteed background completion of a seed scan that
// was cut short (cold-disk timeout / git error) or overflowed the sync copy
// cap at create time. Contract under test:
//   • rescan mode re-enumerates unbounded and seeds everything configured,
//   • deferred mode copies exactly the known remainder,
//   • an existing worktree file is NEVER clobbered,
//   • explicit copyPaths are left alone,
//   • a deleted worktree ends the pass without error,
//   • whenSeedingSettled resolves (immediately when nothing is pending).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { scheduleLateSeedPass, whenSeedingSettled } from "../worktree";

const execFileAsync = promisify(execFile);

let workdir: string;
let repoRoot: string;
let worktreePath: string;
let userDir: string;

async function initRepo(gitignore: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "t@t"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoRoot });
  await writeFile(path.join(repoRoot, ".gitignore"), gitignore);
  await writeFile(path.join(repoRoot, "README.md"), "# init\n");
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });
}

beforeEach(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), "zeros-lsp-"));
  repoRoot = path.join(workdir, "repo");
  worktreePath = path.join(workdir, "wt");
  userDir = path.join(workdir, "user");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(userDir, { recursive: true });
  // Isolate the user settings layer (resolveFilesToCopy reads it in rescan).
  process.env.ZEROS_USER_SETTINGS_DIR = userDir;
});

afterEach(async () => {
  delete process.env.ZEROS_USER_SETTINGS_DIR;
  await rm(workdir, { recursive: true, force: true });
});

describe("scheduleLateSeedPass", () => {
  it("rescan mode seeds every configured match into the worktree", async () => {
    await initRepo(".env*\n");
    await writeFile(path.join(repoRoot, ".env"), "root\n");
    await mkdir(path.join(repoRoot, "packages", "app"), { recursive: true });
    await writeFile(path.join(repoRoot, "packages/app/.env"), "nested\n");
    scheduleLateSeedPass({
      workspaceId: "ws_test_rescan",
      repoRoot,
      worktreePath,
      rescan: true,
      deferred: [],
      explicit: new Set(),
    });
    await whenSeedingSettled("ws_test_rescan");
    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe(
      "root\n",
    );
    expect(
      await readFile(path.join(worktreePath, "packages/app/.env"), "utf8"),
    ).toBe("nested\n");
  });

  it("never clobbers a file that already exists in the worktree", async () => {
    await initRepo(".env*\n");
    await writeFile(path.join(repoRoot, ".env"), "repo-version\n");
    await writeFile(path.join(repoRoot, ".env.local"), "local\n");
    // The sync pass (or the agent) already put a .env in the worktree.
    await writeFile(path.join(worktreePath, ".env"), "worktree-version\n");
    scheduleLateSeedPass({
      workspaceId: "ws_test_noclobber",
      repoRoot,
      worktreePath,
      rescan: true,
      deferred: [],
      explicit: new Set(),
    });
    await whenSeedingSettled("ws_test_noclobber");
    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe(
      "worktree-version\n",
    );
    expect(await readFile(path.join(worktreePath, ".env.local"), "utf8")).toBe(
      "local\n",
    );
  });

  it("deferred mode copies exactly the known remainder, minus explicit paths", async () => {
    await initRepo("*.secret\n");
    await writeFile(path.join(repoRoot, "a.secret"), "a\n");
    await writeFile(path.join(repoRoot, "b.secret"), "b\n");
    await writeFile(path.join(repoRoot, "c.secret"), "c\n");
    scheduleLateSeedPass({
      workspaceId: "ws_test_deferred",
      repoRoot,
      worktreePath,
      rescan: false,
      deferred: ["a.secret", "b.secret"],
      explicit: new Set(["b.secret"]), // explicitly provisioned elsewhere
    });
    await whenSeedingSettled("ws_test_deferred");
    expect(existsSync(path.join(worktreePath, "a.secret"))).toBe(true);
    expect(existsSync(path.join(worktreePath, "b.secret"))).toBe(false);
    expect(existsSync(path.join(worktreePath, "c.secret"))).toBe(false); // not in the list
  });

  it("ends cleanly when the worktree was deleted mid-pass", async () => {
    await initRepo(".env*\n");
    await writeFile(path.join(repoRoot, ".env"), "x\n");
    await rm(worktreePath, { recursive: true, force: true });
    scheduleLateSeedPass({
      workspaceId: "ws_test_deleted",
      repoRoot,
      worktreePath,
      rescan: true,
      deferred: [],
      explicit: new Set(),
    });
    await expect(
      whenSeedingSettled("ws_test_deleted"),
    ).resolves.toBeUndefined();
  });

  it("whenSeedingSettled resolves immediately when nothing is pending", async () => {
    await expect(whenSeedingSettled("ws_never_seen")).resolves.toBeUndefined();
  });

  it("a rescan that ALSO comes up short is logged at error level, not as a no-op", async () => {
    // The one case where seeding genuinely did not happen used to log
    // "copied 0 file(s)" — indistinguishable from a healthy workspace whose
    // patterns matched nothing. `repoRoot` is not a git repo, so the rescan's
    // `git ls-files` fails and complete comes back false.
    await mkdir(repoRoot, { recursive: true });
    const errors: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void errors.push(String(a[0])));
    try {
      scheduleLateSeedPass({
        workspaceId: "ws_test_rescan_failed",
        repoRoot,
        worktreePath,
        rescan: true,
        deferred: [],
        explicit: new Set(),
      });
      await whenSeedingSettled("ws_test_rescan_failed");
    } finally {
      spy.mockRestore();
    }
    expect(errors.some((e) => e.includes("rescan did not complete"))).toBe(
      true,
    );
  });

  it("the rescan is BOUNDED — an unbounded one would hang whenSeedingSettled forever", async () => {
    // whenSeedingSettled gates the setup command and every run-on-create
    // action, so a `git ls-files` that never returns (a wedged network mount)
    // is a workspace that silently never starts. The pass must always settle.
    await initRepo(".env*\n");
    await writeFile(path.join(repoRoot, ".env"), "root\n");
    scheduleLateSeedPass({
      workspaceId: "ws_test_bounded",
      repoRoot,
      worktreePath,
      rescan: true,
      deferred: [],
      explicit: new Set(),
    });
    await expect(
      Promise.race([
        whenSeedingSettled("ws_test_bounded").then(() => "settled"),
        new Promise((r) => setTimeout(() => r("hung"), 15_000)),
      ]),
    ).resolves.toBe("settled");
    expect(existsSync(path.join(worktreePath, ".env"))).toBe(true);
  });

  it("a missing seed source file is skipped without failing the pass", async () => {
    await initRepo("*.secret\n");
    await writeFile(path.join(repoRoot, "real.secret"), "r\n");
    scheduleLateSeedPass({
      workspaceId: "ws_test_missing_src",
      repoRoot,
      worktreePath,
      rescan: false,
      deferred: ["vanished.secret", "real.secret"],
      explicit: new Set(),
    });
    await whenSeedingSettled("ws_test_missing_src");
    expect(existsSync(path.join(worktreePath, "real.secret"))).toBe(true);
    expect(existsSync(path.join(worktreePath, "vanished.secret"))).toBe(false);
  });
});

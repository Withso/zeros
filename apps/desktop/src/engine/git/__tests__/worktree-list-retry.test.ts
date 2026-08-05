// `git worktree list --porcelain` is retried on transient failure.
//
// `git worktree add` writes `.git/worktrees/<name>/` in stages, so a concurrent
// `worktree list` can read a half-written admin entry and exit non-zero — a race
// inside Git itself. `readManagedWorktreeRegistration` asks for that listing with
// `strict: true`, which turned the blip into a hard GitError and failed the
// archive (and randomly blocked releases via the lifecycle suite).
//
// The race is timing-dependent and cannot be reproduced on demand, so these
// tests substitute a `git` shim on PATH that fails a controlled number of
// `worktree list --porcelain` invocations and then delegates to the real binary.
// That makes both the recovery and the give-up boundary deterministic.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveWorkspace,
  closeState,
  createWorkspace,
  getWorkspace,
  setStateRootForTesting,
} from "..";
import { resetFetchFreshness } from "../default-branch";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("git worktree list retry", () => {
  let workdir: string;
  let repoRoot: string;
  let shimDir: string;
  let budgetFile: string;
  let logFile: string;
  let realGit: string;
  let originalPath: string | undefined;

  /** Arm the shim: the next `n` `worktree list --porcelain` calls fail. */
  const armFailures = async (n: number): Promise<void> => {
    await writeFile(budgetFile, String(n));
  };

  /** How many times the shim actually injected a failure. */
  const injectedFailures = async (): Promise<number> => {
    if (!existsSync(logFile)) return 0;
    const raw = await readFile(logFile, "utf8");
    return raw.split("\n").filter((l) => l.trim() !== "").length;
  };

  beforeEach(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), "zeros-wt-list-retry-"));
    repoRoot = path.join(workdir, "repo");
    shimDir = path.join(workdir, "bin");
    budgetFile = path.join(workdir, "fail-budget");
    logFile = path.join(workdir, "fail-log");
    setStateRootForTesting(path.join(workdir, "state"));

    const { stdout } = await execFileAsync("which", ["git"]);
    realGit = stdout.trim();

    await mkdir(repoRoot, { recursive: true });
    await git(repoRoot, "init", "-q", "-b", "main");
    await git(repoRoot, "config", "user.email", "test@zeros.local");
    await git(repoRoot, "config", "user.name", "Zeros Test");
    await writeFile(path.join(repoRoot, "base.txt"), "main\n");
    await git(repoRoot, "add", ".");
    await git(repoRoot, "commit", "-q", "-m", "main tip");

    // Fails only `worktree list --porcelain`, only while the budget file holds a
    // positive count, and delegates everything else to the real binary. stderr
    // mimics the real half-written-admin-entry read so nothing downstream can
    // pattern-match its way to a different code path.
    await mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await writeFile(
      shim,
      `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ]; then
  BUDGET=$(cat ${JSON.stringify(budgetFile)} 2>/dev/null || echo 0)
  if [ "$BUDGET" -gt 0 ] 2>/dev/null; then
    echo $((BUDGET - 1)) > ${JSON.stringify(budgetFile)}
    echo injected >> ${JSON.stringify(logFile)}
    echo "fatal: could not read '.git/worktrees/pending/gitdir': No such file or directory" >&2
    exit 128
  fi
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    await chmod(shim, 0o755);

    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${originalPath ?? ""}`;
    resetFetchFreshness();
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    closeState();
    setStateRootForTesting(null);
    resetFetchFreshness();
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  });

  it("recovers when the listing fails transiently during archive", async () => {
    const ws = await createWorkspace({ repoRoot, repoSlug: "retry-repo" });

    // Three consecutive failures is the whole backoff budget — the fourth
    // attempt succeeds. Arm AFTER create so only the archive path is affected.
    await armFailures(3);
    await archiveWorkspace({
      workspaceId: ws.workspaceId,
      stashUncommitted: true,
    });

    expect(await injectedFailures()).toBe(3);
    expect(getWorkspace(ws.workspaceId)).toMatchObject({
      archivedAt: expect.any(Number),
    });
  });

  it("gives up once the retry budget is exhausted", async () => {
    const ws = await createWorkspace({ repoRoot, repoSlug: "retry-repo" });

    // One more failure than the backoff tolerates: the error must surface rather
    // than the loop spinning forever.
    await armFailures(4);
    await expect(
      archiveWorkspace({
        workspaceId: ws.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toThrow(/Couldn't verify ownership of workspace directory/);

    expect(await injectedFailures()).toBe(4);
    expect(getWorkspace(ws.workspaceId).archivedAt).toBeFalsy();
  });
});

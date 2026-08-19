import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { runGit } from "../../git/git-exec";

export interface CanonicalGitRepository {
  readonly workspaceRoot: string;
  readonly gitEntry: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly objectDir: string;
}

function absoluteFrom(base: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(base, value);
}

async function revParse(workspaceRoot: string, ...args: string[]): Promise<string> {
  return (
    await runGit(workspaceRoot, ["rev-parse", ...args], {
      timeoutMs: 10_000,
      maxBufferBytes: 256 * 1024,
    })
  ).stdout.trim();
}

/** Resolve the physical repository that owns `cwd`, which may be a worktree
 * subdirectory. Ambient GIT_* values, aliases, and executable configuration
 * are excluded by the engine Git runner. */
export async function resolveCanonicalGitRepository(
  cwd: string,
): Promise<CanonicalGitRepository | null> {
  try {
    if ((await revParse(cwd, "--is-inside-work-tree")) !== "true") {
      return null;
    }
  } catch {
    return null;
  }

  const canonicalCwd = realpathSync(cwd);
  const top = realpathSync(await revParse(canonicalCwd, "--show-toplevel"));
  const gitDir = realpathSync(
    await revParse(canonicalCwd, "--absolute-git-dir"),
  );
  const commonDir = realpathSync(
    absoluteFrom(
      canonicalCwd,
      await revParse(canonicalCwd, "--git-common-dir"),
    ),
  );
  const objectDir = realpathSync(path.join(commonDir, "objects"));
  const gitEntry = path.join(top, ".git");
  if (!existsSync(gitEntry)) {
    throw new Error("Git worktree metadata entry is missing");
  }
  return {
    workspaceRoot: top,
    gitEntry,
    gitDir,
    commonDir,
    objectDir,
  };
}

/** Resolve only the canonical metadata needed to register one exact worktree
 * owner. A subdirectory or nested repository is not interchangeable with the
 * requested owner. */
export async function discoverCanonicalGitRepository(
  workspaceRoot: string,
): Promise<CanonicalGitRepository | null> {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const repository = await resolveCanonicalGitRepository(canonicalWorkspace);
  if (repository && repository.workspaceRoot !== canonicalWorkspace) {
    throw new Error("ZSR Git workspace root does not match Git's top level");
  }
  return repository;
}

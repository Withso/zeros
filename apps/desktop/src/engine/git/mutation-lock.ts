import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const mutationFlights = new Map<string, Promise<void>>();

interface WorkspaceMutationAdmission {
  active: boolean;
}

const workspaceMutationAdmissions = new AsyncLocalStorage<
  ReadonlyMap<string, WorkspaceMutationAdmission>
>();

async function workspaceMutationKey(workspacePath: string): Promise<string> {
  const resolved = path.resolve(workspacePath);
  try {
    return `worktree:${await realpath(resolved)}`;
  } catch {
    return `worktree:${resolved}`;
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

/** Resolve the repository-global ref/stash namespace without invoking Git while
 * an app mutation is already admitted. Linked worktrees point at a per-worktree
 * gitdir whose `commondir` resolves to the shared repository `.git` directory. */
async function repositoryMutationKey(
  workspacePath: string,
): Promise<string | null> {
  const workspace = path.resolve(workspacePath);
  const dotGit = path.join(workspace, ".git");
  let gitDir: string;
  try {
    const dotGitStat = await lstat(dotGit);
    if (dotGitStat.isDirectory()) {
      gitDir = dotGit;
    } else if (dotGitStat.isFile()) {
      const pointer = await readFile(dotGit, "utf8");
      const match = /^gitdir:\s*(.+?)\s*$/im.exec(pointer);
      if (!match?.[1]) return null;
      gitDir = path.resolve(workspace, match[1]);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  let commonDir = gitDir;
  try {
    const relativeCommonDir = (await readFile(
      path.join(gitDir, "commondir"),
      "utf8",
    )).trim();
    if (relativeCommonDir) commonDir = path.resolve(gitDir, relativeCommonDir);
  } catch {
    // A primary worktree's .git directory is already the common directory.
  }
  return `repository:${await canonicalPath(commonDir)}`;
}

async function withMutationKey<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const inherited = workspaceMutationAdmissions.getStore();
  if (inherited?.get(key)?.active) return run();

  const previous = mutationFlights.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => turn);
  mutationFlights.set(key, queued);
  await previous;
  const admission: WorkspaceMutationAdmission = { active: true };
  const admissions = new Map(inherited);
  admissions.set(key, admission);
  try {
    return await workspaceMutationAdmissions.run(admissions, run);
  } finally {
    admission.active = false;
    release();
    if (mutationFlights.get(key) === queued) mutationFlights.delete(key);
  }
}

/** Serialize app-owned mutations that can change either a live Design draft or
 * the same worktree's Git checkout/index/refs. A single re-entrant lane avoids
 * the former Git→Design / Design→Git lock inversion. Different worktrees stay
 * independent, and ordinary Code editing/building/testing stays outside it.
 *
 * The active bit matters for detached async work: AsyncLocalStorage context can
 * outlive the callback that created it, but an operation spawned and forgotten
 * must not retain authority after its admitted parent has released the lane. */
export async function withWorkspaceMutation<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = await workspaceMutationKey(workspacePath);
  return withMutationKey(key, run);
}

/** Git-facing name retained at call sites to make the mutation authority
 * obvious. It first owns the exact worktree, then the repository-global ref and
 * stash namespace shared by linked worktrees. This fixed order keeps separate
 * checkouts independently editable while preventing two app-owned history
 * mutations from racing the same branch tip. */
export async function withWorkspaceGitMutation<T>(
  workspacePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const [worktreeKey, repositoryKey] = await Promise.all([
    workspaceMutationKey(workspacePath),
    repositoryMutationKey(workspacePath),
  ]);
  return withMutationKey(worktreeKey, () =>
    repositoryKey ? withMutationKey(repositoryKey, run) : run(),
  );
}

// "Fetch submodules" (workspace-submodules-v1): after a new checkout, each planned submodule is brought to its
// commit the way the project build fetches it (control-plane cloud/submodules.ts submoduleFetchLines): HTTPS
// only, its own Git directory under the checkout's .git/modules/<digest>, no hooks, no recursion, no symlink in
// its path, and only into an empty folder or the submodule already planned there. For a private one Git asks the
// broker for that repository's token by name (credential.useHttpPath); the control plane mints it read-only, and
// a pre-push hook says so in a sentence. A public one (GitHub's answer at create) is fetched with no credential:
// Git runs without askpass, broker, helper or prompt, so it can't ask. A submodule that fails is skipped with its
// own submodules; the checkout goes on.
// A checkout whose branch was already there (a restore, or a later start on the same disk) passes onlyMissing:
// only a submodule still missing is fetched, i.e. its folder a real, empty directory (what a restore's read-tree
// leaves for a gitlink) with no .git in it and its planned Git directory absent. Any other is left exactly as it
// is, with no Git command run in it: a folder that is absent (the person may have removed it), non-empty, holding a
// .git, or whose Git directory exists. A nested one is fetched only into its parent's planned Git directory.
import { chmod, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkoutGit } from "./checkout";
import type { WorkerConfig } from "./scope";

export type WorkerSubmodule = NonNullable<WorkerConfig["workspace"]["submodules"]>[number];
/** kept: left as it was found (onlyMissing), neither fetched nor skipped. */
export type SubmoduleOutcome = { path: string; fetched: boolean; kept?: true };
export type FetchSubmodulesOptions = { onlyMissing?: boolean };
export const SUBMODULE_PUSH_REFUSED = "Pushing from a submodule isn't available in cloud workspaces yet. Push it from your own computer.";
const FETCH_TIMEOUT_MS = 15 * 60_000;
const SAFE = ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "core.hooksPath=/dev/null"];
const NO_CREDENTIAL = ["-c", "credential.helper=", "-c", "core.askPass="];
// Characters Git (and HFS+) ignore when comparing a path component with ".git".
const IGNORED = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

/** The control plane checked these; the worker checks again before any of them reaches Git or the disk. */
function safe(entry: WorkerSubmodule): boolean {
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(entry.repository) || entry.repository.split("/").some(part => /^\.+$/.test(part))) return false;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(entry.commit) || !/^modules\/[0-9a-f]{64}(?:\/modules\/[0-9a-f]{64}){0,2}$/.test(entry.gitDir)) return false;
  // eslint-disable-next-line no-control-regex
  if (!entry.path || entry.path.length > 1024 || entry.path.startsWith("/") || /[\u0000-\u001f\u007f\\:]/.test(entry.path)) return false;
  return entry.path.split("/").every(part => {
    if (!part || part === "." || part === "..") return false;
    const folded = part.replace(IGNORED, "").toLowerCase().replace(/[. ]+$/, "");
    return folded !== ".git" && !/^git~\d+$/.test(folded);
  });
}

const kind = (path: string) => lstat(path).then(stat => stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file",
  (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "none" as const; throw error; });

async function fetchOne(root: string, entry: WorkerSubmodule, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const target = join(root, entry.path), gitDir = join(root, ".git", entry.gitDir);
  const network = entry.public ? { credentials: false as const } : {}, hardened = entry.public ? [...SAFE, ...NO_CREDENTIAL] : SAFE;
  // Every component a real directory under the checkout: a symlink anywhere resolves elsewhere.
  if (await realpath(target).catch(() => null) !== target || await kind(join(root, ".git")) !== "dir") return false;
  const [link, directory] = await Promise.all([kind(join(target, ".git")), kind(gitDir)]);
  if (link !== "none" || directory !== "none") {
    // Already there (a fork of the project's build): only its own planned Git directory, moved to the plan.
    if (link !== "file" || directory !== "dir" || await realpath(gitDir) !== gitDir) return false;
    const current = await checkoutGit(target, environment)(["rev-parse", "--absolute-git-dir"]).then(value => value.trim(), () => "");
    if (current !== gitDir) return false;
  } else {
    if ((await readdir(target)).length) return false;
    await mkdir(dirname(gitDir), { recursive: true });
    if (await realpath(dirname(gitDir)) !== dirname(gitDir)) return false;
    await checkoutGit(root, environment, FETCH_TIMEOUT_MS, network)([...hardened, "clone", "--quiet", "--no-checkout", "--no-recurse-submodules", "--template=",
      `--separate-git-dir=${gitDir}`, "--", `https://github.com/${entry.repository}.git`, target]);
  }
  const run = checkoutGit(target, environment, FETCH_TIMEOUT_MS);
  const present = await run(["cat-file", "-e", `${entry.commit}^{commit}`]).then(() => true, () => false);
  if (!present) await checkoutGit(target, environment, FETCH_TIMEOUT_MS, network)([...hardened, "fetch", "--quiet", "--no-recurse-submodules", "origin", entry.commit]);
  await run([...SAFE, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", entry.commit]);
  await mkdir(join(gitDir, "hooks"), { recursive: true });
  const hook = join(gitDir, "hooks", "pre-push");
  await writeFile(hook, `#!/bin/sh\necho '${SUBMODULE_PUSH_REFUSED.replace(/'/g, "'\\''")}' >&2\nexit 1\n`);
  await chmod(hook, 0o755);
  return true;
}

/** Still missing: a real, empty folder with no .git, and no planned Git directory. Only reads the disk. */
async function missing(root: string, entry: WorkerSubmodule): Promise<boolean> {
  const target = join(root, entry.path), gitDir = join(root, ".git", entry.gitDir);
  if (await realpath(target).catch(() => null) !== target || await kind(join(root, ".git")) !== "dir") return false;
  if (await kind(join(target, ".git")) !== "none" || await kind(gitDir) !== "none" || (await readdir(target)).length) return false;
  // A nested one's Git directory lives in its parent's: never created for a parent that isn't the planned one.
  const parent = dirname(dirname(gitDir));
  return entry.gitDir.split("/").length === 2 || await realpath(parent).catch(() => null) === parent && await kind(parent) === "dir";
}

/** One checkout's planned submodules, parents first (the plan's order). Never throws: each is fetched or skipped
 * (or, with onlyMissing, kept as it is unless still missing; a child of one fetched in this pass as without it). */
export async function fetchPlannedSubmodules(checkoutPath: string, entries: readonly WorkerSubmodule[], environment: NodeJS.ProcessEnv = {},
  options: FetchSubmodulesOptions = {}): Promise<SubmoduleOutcome[]> {
  if (!entries.length) return [];
  const root = await realpath(checkoutPath).catch(() => null);
  const outcomes: SubmoduleOutcome[] = [], failed: string[] = [], fetchedNow: string[] = [];
  const under = (entry: WorkerSubmodule, parents: readonly string[]) => parents.some(parent => entry.path.startsWith(`${parent}/`));
  for (const entry of entries) {
    if (options.onlyMissing && root !== null && safe(entry) && !under(entry, failed) && !under(entry, fetchedNow)
      && !await missing(root, entry).catch(() => false)) {
      outcomes.push({ path: entry.path, fetched: false, kept: true });
      continue;
    }
    const fetched = root !== null && safe(entry) && !under(entry, failed)
      && await fetchOne(root, entry, environment).catch(() => false);
    if (!fetched) failed.push(entry.path);
    else fetchedNow.push(entry.path);
    outcomes.push({ path: entry.path, fetched });
  }
  return outcomes;
}

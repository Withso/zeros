// "Fetch submodules" (workspace-submodules-v1): after a new checkout, each planned submodule is brought to its
// commit the way the project build fetches it (control-plane cloud/submodules.ts submoduleFetchLines): HTTPS
// only, its own Git directory under the checkout's .git/modules/<digest>, no hooks, no recursion, no symlink in
// its path, and only into an empty folder or the submodule already planned there. For a private one Git asks the
// broker for that repository's token by name (credential.useHttpPath); the control plane mints it read-only, and
// a pre-push hook says so in a sentence. A public one (GitHub's answer at create) is fetched with no credential:
// Git runs without askpass, broker, helper or prompt, so it can't ask. A submodule that fails is skipped with its
// own submodules; the checkout goes on.
import { chmod, lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkoutGit } from "./checkout";
import type { WorkerConfig } from "./scope";

export type WorkerSubmodule = NonNullable<WorkerConfig["workspace"]["submodules"]>[number];
export type SubmoduleOutcome = { path: string; fetched: boolean };
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

/** One checkout's planned submodules, parents first (the plan's order). Never throws: each is fetched or skipped. */
export async function fetchPlannedSubmodules(checkoutPath: string, entries: readonly WorkerSubmodule[], environment: NodeJS.ProcessEnv = {}): Promise<SubmoduleOutcome[]> {
  if (!entries.length) return [];
  const root = await realpath(checkoutPath).catch(() => null);
  const outcomes: SubmoduleOutcome[] = [], failed: string[] = [];
  for (const entry of entries) {
    const fetched = root !== null && safe(entry) && !failed.some(parent => entry.path.startsWith(`${parent}/`))
      && await fetchOne(root, entry, environment).catch(() => false);
    if (!fetched) failed.push(entry.path);
    outcomes.push({ path: entry.path, fetched });
  }
  return outcomes;
}

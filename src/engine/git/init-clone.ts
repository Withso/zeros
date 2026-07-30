// Repository creation / adoption — `git init` and `git clone`.
//
// Both surfaces are driven by the Phase 1A "Add repository" menu in
// Column 1: Quick start (init a new repo from a template), and Open
// GitHub project (clone from URL). The renderer calls these via the
// `workspace_init_repo` and `workspace_clone` IPC commands.
//
// We deliberately do NOT auto-create a Zeros workspace (worktree) on
// top of the new repo HERE. The IPC simply produces the repoRoot.
// Keeps the responsibilities split: init/clone is "make a repo",
// workspace_create is "make a worktree".
//
// 2026-07-28: the renderer now forks that first worktree itself, right
// after registering the project — see openFirstWorkspace in
// src/shell/add-project-provider.tsx. So adding a repo DOES land the
// user in a workspace; it just isn't this layer's job to arrange, and
// this layer stays usable for a repo that should not get one.

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors";
import { classifyGitTransportError, runGit } from "./git-exec";

/** Templates available in the Quick Start dialog. v1 ships only "empty"
 *  — adding Next.js / gstack later means dropping a tarball into a
 *  `templates/` folder and adding a copy-step here. */
export type InitTemplate = "empty";

export interface InitRepoOptions {
  /** Bare project name — must be a valid directory name (no slashes). */
  name: string;
  /** Absolute path to the parent directory that will contain the new
   *  project. The new repo lives at `<parentFolder>/<name>`. */
  parentFolder: string;
  /** Template to lay down. v1 = "empty". */
  template?: InitTemplate;
  /** Initial commit message. Defaults to "initial commit" so the repo
   *  has an HEAD pointing at something on day one — without an initial
   *  commit, lots of downstream operations (worktree add, branch list,
   *  etc.) fail on an "unborn" branch. */
  initialCommitMessage?: string;
}

export interface InitRepoResult {
  /** Absolute path of the newly created repo (= `<parentFolder>/<name>`). */
  repoRoot: string;
  /** SHA of the initial commit so the renderer can show "initialized". */
  initialSha: string;
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** Validate a user-supplied project name. Strict — no slashes (those
 *  would let the user create the repo outside the picked parent), no
 *  spaces (Mac filesystem accepts them but shells get confused), no
 *  dot-prefix (Finder hides dot-dirs by default). */
function validateName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Project name is required.",
    });
  }
  if (!NAME_RE.test(name)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Project name can only contain letters, digits, dot, underscore, and hyphen — max 64 chars.",
    });
  }
  if (name.startsWith(".")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Project name can't start with a dot.",
    });
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function initRepo(opts: InitRepoOptions): Promise<InitRepoResult> {
  validateName(opts.name);
  if (
    !opts.parentFolder ||
    typeof opts.parentFolder !== "string" ||
    !opts.parentFolder.startsWith("/")
  ) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "parentFolder must be an absolute path.",
    });
  }
  const repoRoot = path.join(opts.parentFolder, opts.name);
  if (await pathExists(repoRoot)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `A folder already exists at ${repoRoot}.`,
      remediation:
        "Pick a different name or remove the existing folder before initializing.",
    });
  }
  await mkdir(repoRoot, { recursive: true });
  // Use `-b main` so we don't end up on the historical `master` default
  // and have to rename on the first push.
  await runGit(repoRoot, ["init", "-q", "-b", "main"]);
  // Lay down the template. v1 = just a README so HEAD has something
  // committable. Future templates can copy from a `templates/<id>/`
  // skeleton checked into the Zeros repo.
  if ((opts.template ?? "empty") === "empty") {
    await writeFile(
      path.join(repoRoot, "README.md"),
      `# ${opts.name}\n\nCreated with Zeros.\n`,
      "utf8",
    );
  }
  // Stage + commit. We isolate user.email / user.name to the local
  // repo config so we don't depend on the user having global git
  // identity set — common gotcha for fresh installs.
  await runGit(repoRoot, ["config", "user.email", "noreply@zeros.design"]);
  await runGit(repoRoot, ["config", "user.name", "Zeros"]);
  await runGit(repoRoot, ["add", "-A"]);
  const message = opts.initialCommitMessage ?? "initial commit";
  await runGit(repoRoot, ["commit", "-q", "-m", message]);
  const { stdout } = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  return { repoRoot, initialSha: stdout.trim() };
}

// ── clone ────────────────────────────────────────────────

export interface CloneRepoOptions {
  /** Remote URL (ssh or https). */
  url: string;
  /** Parent directory the clone lives under — the new repo ends up at
   *  `<parentFolder>/<derived-name>`. The derived name is the URL's
   *  trailing path segment with `.git` stripped. */
  parentFolder: string;
  /** Override the derived directory name. Optional. */
  directoryName?: string;
}

export interface CloneRepoResult {
  repoRoot: string;
  /** The default branch after clone (whatever HEAD points to). */
  defaultBranch: string;
}

const URL_RE = /^(?:[A-Za-z0-9_-]+@|https?:\/\/)/;

function deriveCloneDirName(url: string): string {
  // ssh-style: git@host:owner/repo(.git)?
  const sshMatch = url.match(/^[^@]+@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const tail = sshMatch[1];
    const last = tail.split("/").filter(Boolean).pop();
    if (last) return last;
  }
  // https://host/...path/repo(.git)?
  const httpMatch = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpMatch) {
    const tail = httpMatch[1];
    const last = tail.split("/").filter(Boolean).pop();
    if (last) return last;
  }
  // Fallback — last path segment of whatever was passed.
  return url.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "repo";
}

export async function cloneRepo(opts: CloneRepoOptions): Promise<CloneRepoResult> {
  if (!opts.url || !URL_RE.test(opts.url)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Repository URL must start with https:// or use ssh form (git@host:owner/repo).",
    });
  }
  if (!opts.parentFolder || !opts.parentFolder.startsWith("/")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "parentFolder must be an absolute path.",
    });
  }
  const dirName = opts.directoryName?.trim() || deriveCloneDirName(opts.url);
  validateName(dirName);
  const repoRoot = path.join(opts.parentFolder, dirName);
  if (await pathExists(repoRoot)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `A folder already exists at ${repoRoot}.`,
      remediation:
        "Pick a different name (or remove the existing folder) before cloning.",
    });
  }
  await mkdir(opts.parentFolder, { recursive: true });
  await runGit(opts.parentFolder, ["clone", opts.url, dirName], {
    timeoutMs: 120_000,
    mapErrorCode: (stderr) => {
      const transportError = classifyGitTransportError(stderr);
      if (transportError) return transportError;
      if (/repository .* not found|not a valid repository/i.test(stderr)) {
        return "VALIDATION_FAILED";
      }
      return "GIT_COMMAND_FAILED";
    },
  });
  // Read the resulting branch (whatever the upstream's HEAD pointed at).
  let defaultBranch = "main";
  try {
    const { stdout } = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    defaultBranch = stdout.trim() || "main";
  } catch {
    // Empty repo with no HEAD — fall through to "main".
  }
  return { repoRoot, defaultBranch };
}

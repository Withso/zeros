// ──────────────────────────────────────────────────────────
// IPC commands: git/workspace — DB-FREE remnant (single-writer)
// ──────────────────────────────────────────────────────────
//
// The DB-touching git + workspace IPC handlers were MOVED onto the engine
// bridge in the single-writer migration (src/native/git.ts → workspace/
// service.ts handle()), so Electron main no longer opens zeros.db. Only the
// handlers that touch NO database remain here, on the host filesystem:
//
//   • git_list_files          — list files in a cwd (`git ls-files`), backs the
//                               composer @-mention picker.
//   • workspace_init_repo     — `git init` a fresh repo (Quick Start dialog).
//   • workspace_clone         — clone a remote URL (Open GitHub project dialog).
//   • workspace_inspect_folder — probe a picked folder (Add local project).
//
// None call getWorkspace / open the DB; they shell out to git or read the FS.
// ──────────────────────────────────────────────────────────

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  cloneRepo,
  initRepo,
  isGitError,
  isRepo,
  listWorkspaceFiles,
  readOriginUrl,
  type DetectedTool,
} from "../../../src/engine/git";
import type { CommandHandler } from "../router";

// ── Argument validation helpers ──────────────────────────

function requireString(
  args: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${context}: missing required string '${key}'`);
  }
  return v;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Normalize errors at the IPC boundary: preserve a structured GitError as-is
 *  (the router serializes via toJSON()); wrap anything else so the renderer at
 *  least gets a message. */
function rethrow(err: unknown): never {
  if (isGitError(err)) throw err;
  if (err instanceof Error) throw err;
  throw new Error(String(err));
}

// ── git_list_files ────────────────────────────────────────
// Backs the composer @-mention picker. Takes a raw cwd (not a workspace id)
// since the picker runs against the active chat's folder. Never throws on a
// non-repo cwd — the engine returns [] and the picker degrades to selection-only.

export const gitListFiles: CommandHandler = async (args) => {
  const cwd = requireString(args, "cwd", "git_list_files");
  const limit = optionalNumber(args, "limit");
  try {
    return { files: await listWorkspaceFiles(cwd, limit) };
  } catch (err) {
    rethrow(err);
  }
};

// ── workspace_init_repo ───────────────────────────────────
// Quick Start dialog. Creates a fresh git repo with an initial commit so
// subsequent worktree_add / branch_list calls don't trip on an unborn HEAD.

export const workspaceInitRepo: CommandHandler = async (args) => {
  const cmd = "workspace_init_repo";
  const name = requireString(args, "name", cmd);
  const parentFolder = requireString(args, "parentFolder", cmd);
  const template = optionalString(args, "template") as "empty" | undefined;
  const initialCommitMessage = optionalString(args, "initialCommitMessage");
  try {
    return await initRepo({
      name,
      parentFolder,
      template,
      initialCommitMessage,
    });
  } catch (err) {
    rethrow(err);
  }
};

// ── workspace_clone ───────────────────────────────────────
// Open GitHub project dialog. Clones a remote repo to
// <parentFolder>/<derived-name>.

export const workspaceClone: CommandHandler = async (args) => {
  const cmd = "workspace_clone";
  const url = requireString(args, "url", cmd);
  const parentFolder = requireString(args, "parentFolder", cmd);
  const directoryName = optionalString(args, "directoryName");
  try {
    return await cloneRepo({ url, parentFolder, directoryName });
  } catch (err) {
    rethrow(err);
  }
};

// ── workspace_inspect_folder ─────────────────────────────
// "Add local project" dialog. Inspects a picked folder to decide which dialog
// to show: not a repo (fail gently) / primary checkout / linked worktree. A
// linked worktree's `.git` is a *file* (`gitdir: <abs>`); combined with the
// branch-name prefix / known tool markers we pick the right label.

interface InspectFolderResult {
  isRepo: boolean;
  /** True when .git is a file pointing into another repo's gitdir
   *  (linked worktree). False when .git is a directory (primary
   *  checkout) or absent (not a repo). */
  isWorktree: boolean;
  /** Resolved origin URL when readable. Null otherwise. */
  originUrl: string | null;
  /** Current branch the worktree has checked out, when resolvable. */
  branch: string | null;
  /** Best-effort source-tool detection. */
  sourceTool: DetectedTool;
  /** Absolute path of the repo's PRIMARY checkout (the main working tree).
   *  For a linked worktree this is the parent repo (the directory whose `.git`
   *  the worktree shares); for a primary checkout it's the folder itself. Null
   *  when not a repo or unresolvable. "Add local project" registers the project
   *  at THIS path (so Local main is the real trunk) while adopting the picked
   *  worktree as a workspace. */
  mainRoot: string | null;
  /** True when HEAD resolves to a commit. False for a non-repo OR a repo with
   *  ZERO commits (unborn HEAD) — both cases can't host a worktree/diff yet and
   *  need `git init` + an initial commit (initRepoInPlace handles both). */
  hasCommits: boolean;
}

function detectSourceToolByPath(folderPath: string): DetectedTool {
  if (existsSync(path.join(folderPath, ".zeros", "workspace.json"))) {
    return "zeros";
  }
  if (existsSync(path.join(folderPath, ".cursor", "worktrees.json"))) {
    return "cursor";
  }
  if (existsSync(path.join(folderPath, ".superset", "config.json"))) {
    return "superset";
  }
  if (
    folderPath.includes(`${path.sep}.conductor${path.sep}`) ||
    folderPath.includes(`${path.sep}conductor${path.sep}`)
  ) {
    return "conductor";
  }
  return "unknown";
}

export const workspaceInspectFolder: CommandHandler = async (args) => {
  const cmd = "workspace_inspect_folder";
  const folderPath = requireString(args, "path", cmd);
  try {
    const inRepo = await isRepo(folderPath);
    if (!inRepo) {
      return {
        isRepo: false,
        isWorktree: false,
        originUrl: null,
        branch: null,
        sourceTool: "unknown",
        mainRoot: null,
        hasCommits: false,
      } satisfies InspectFolderResult;
    }
    // Linked vs primary worktree: `.git` directory vs file.
    let isWorktree = false;
    const dotGit = path.join(folderPath, ".git");
    try {
      const raw = readFileSync(dotGit, "utf8");
      isWorktree = /^gitdir:\s*/.test(raw);
    } catch {
      // .git is a directory (or missing — but we already verified it's
      // a repo), so isWorktree stays false.
    }
    let originUrl: string | null = null;
    try {
      originUrl = await readOriginUrl(folderPath);
    } catch {
      // No origin configured — fine.
    }
    let branch: string | null = null;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const { stdout } = await exec("git", [
        "-C",
        folderPath,
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      branch = stdout.trim() || null;
    } catch {
      // Detached HEAD — leave branch null.
    }
    // Resolve the PRIMARY checkout. `--git-common-dir` is the shared `.git`
    // (the main repo's gitdir) for a linked worktree, or `.git` (relative to
    // the folder) for a primary checkout; its parent is the primary working
    // tree — what we register as the project root.
    let mainRoot: string | null = null;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      const { stdout } = await exec("git", [
        "-C",
        folderPath,
        "rev-parse",
        "--git-common-dir",
      ]);
      const commonDir = stdout.trim();
      if (commonDir) {
        mainRoot = path.dirname(path.resolve(folderPath, commonDir));
      }
    } catch {
      // Unresolvable — leave null; the renderer falls back to the picked path.
    }
    // Does HEAD resolve to a commit? A freshly `git init`'d repo has an unborn
    // HEAD (zero commits) — it passes isRepo but can't host a worktree/diff, so
    // the renderer must treat it like "needs initializing".
    let hasCommits = false;
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);
      await exec("git", [
        "-C",
        folderPath,
        "rev-parse",
        "--verify",
        "--quiet",
        "HEAD",
      ]);
      hasCommits = true;
    } catch {
      // Non-zero exit → unborn HEAD (no commits).
    }
    const sourceTool = detectSourceToolByPath(folderPath);
    const result: InspectFolderResult = {
      isRepo: true,
      isWorktree,
      originUrl,
      branch,
      sourceTool,
      mainRoot,
      hasCommits,
    };
    return result;
  } catch (err) {
    rethrow(err);
  }
};

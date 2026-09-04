// ──────────────────────────────────────────────────────────
// Design mode — one workspace, two concurrent views
// ──────────────────────────────────────────────────────────
//
// A workspace is never "a design workspace" by species: every worktree is
// created through the same code pipeline (same base ref, files-to-copy
// seeding, setup, context graph), and the MODE is simply which surface the
// user is working in. The Design surface still writes only through its scoped
// API. Switching the visible surface never changes Git checkout shape, stages
// files, commits, or retires Code processes. Design files remain ordinary
// uncommitted work until the user performs an explicit Git action.
//
// Isolation is TERRITORIAL and ACTOR-SCOPED:
//
//   • code actors run natively and receive an explicit behavioral contract
//     that treats the live Design root as read-only context;
//   • Design agents run in ZSR and mutate only through the Design API;
//   • the codebase is writable only by code actors — the design surface
//     can't reach outside the design dir by construction
//     (assertSafeDesignWriteTarget); external tools retain normal access to the
//     shared checkout.
//
// Pre-concurrency builds DID lock the whole tracked tree while a workspace
// was in design mode, and wrote a sparse cone before that. Both are treated
// as legacy state: the cone dissolves and historical ACLs are swept off.
//
// Crash safety
// ────────────
// The row flip and the filesystem work cannot be atomic, so each transition
// writes a durable marker (workspace_meta) before touching anything and
// clears it after the last step; boot completes whatever it finds. The
// remaining filesystem legs (initialize the document and legacy cleanup) are
// idempotent.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  previewDesignDirectoryForEnter,
  resolveDesignDirectoryForEnter,
} from "../design/directory";
import {
  designDirectoryNameFor,
  primeDesignDirectoryName,
  sanitizeDesignDirectoryName,
} from "../design/directory-registry";
import { initializeDesignDocument } from "../design/document";
import { unlockLegacyDesignWorkspaceLock } from "../design/workspace-lock";
import {
  rememberRecognizedDesignDirectories,
  stickyRecognizedDesignDirectories,
} from "../design/recognition-store";
import { opSettingsWrite } from "../settings/ops";
import { GitError } from "./errors";
import { runGit } from "./git-exec";
import { withWorkspaceGitMutation } from "./mutation-lock";
import {
  getWorkingDirectories,
  setWorkingDirectories,
} from "./sparse-checkout";
import {
  designWorktreesRoot,
  getWorkspaceById,
  getWorkspaceMeta,
  listWorkspaces,
  setWorkspaceMeta,
  updateWorkspace,
} from "./state";
import type { Workspace } from "./types";

/** Durable transition marker. Written before a transition's first mutation,
 *  cleared after its last; boot completes whatever it finds. The value names
 *  the DIRECTION so recovery knows which end state was intended. */
export const DESIGN_MODE_TRANSITION_META_KEY = "design.mode.transition.v1";

type TransitionMarker = "enter" | "exit";

/** `--` ends option parsing, not Git pathspec parsing. Design directory names
 * are valid filesystem names and may contain glob or pathspec-magic bytes, so
 * every exact path handed to a pathspec-taking Git command is literalized. */
function literalGitPathspec(candidate: string): string {
  return `:(literal)${candidate}`;
}

function readMarker(workspaceId: string): TransitionMarker | null {
  const raw = getWorkspaceMeta(workspaceId, DESIGN_MODE_TRANSITION_META_KEY);
  return raw === "enter" || raw === "exit" ? raw : null;
}

function writeMarker(workspaceId: string, marker: TransitionMarker): void {
  setWorkspaceMeta(workspaceId, DESIGN_MODE_TRANSITION_META_KEY, marker);
}

/** workspace_meta has no delete helper on purpose (rows are tiny); an empty
 *  value reads back as "no marker" through readMarker's validation. */
function clearMarker(workspaceId: string): void {
  setWorkspaceMeta(workspaceId, DESIGN_MODE_TRANSITION_META_KEY, "");
}

/** Ensure the Design foundation exists without touching Git history or index.
 * The returned paths are repository-relative files created by this call.
 * Existing authored files are never overwritten. */
export async function ensureDesignDocumentInitialized(
  workspacePath: string,
  designDir: string = designDirectoryNameFor(workspacePath),
): Promise<{ created: string[] }> {
  primeDesignDirectoryName(workspacePath, designDir);
  return initializeDesignDocument(workspacePath);
}

/** Enter Design view without changing Git or process authority. A caller may
 * validate/build the first surface receipt before the row is published; if
 * that preparation fails, the workspace remains in Code view. */
export async function enterDesignMode<T = void>(
  workspace: Workspace,
  beforePublish?: () => Promise<T>,
): Promise<T | undefined> {
  // Decide WHICH folder is the design folder before anything durable happens:
  // the `[design] directory` pointer, with recognition/adoption of committed
  // design folders (the copy-paste-between-repos case). A refusal here aborts
  // cleanly with no marker, Git, or view-state mutation.
  const sticky = await stickyRecognizedDesignDirectories(workspace.path);
  const designDir = await previewDesignDirectoryForEnter(workspace, {
    additionalRecognized: sticky,
  });
  primeDesignDirectoryName(workspace.path, designDir);
  writeMarker(workspace.id, "enter");
  try {
    await ensureDesignDocumentInitialized(workspace.path, designDir);
    // A freshly initialized Design draft is intentionally uncommitted. Remember
    // the resolved identity outside Git so leaving and re-entering Design does
    // not mistake that engine-created draft for an unrelated user directory.
    await rememberRecognizedDesignDirectories(workspace.path, [designDir]);
    const prepared = await beforePublish?.();
    updateWorkspace(workspace.id, { viewMode: "design" });
    clearMarker(workspace.id);
    return prepared;
  } catch (error) {
    updateWorkspace(workspace.id, { viewMode: "code" });
    clearMarker(workspace.id);
    throw error;
  }
}

function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Pre-mode Design workspaces were created under the dedicated legacy root
 * with an engine-owned cone containing exactly their Design top-level folder.
 * Dissolve only that fingerprint. A user-managed sparse selection in a normal
 * workspace—or any legacy checkout whose cone has since been customized—is
 * preserved byte-for-byte. */
async function normalizeLegacyDesignCone(workspace: Workspace): Promise<void> {
  if (!isInsideDirectory(workspace.path, designWorktreesRoot())) return;
  const state = await getWorkingDirectories(workspace.path);
  if (!state.sparse || !state.supported) return;
  const designTopLevel = designDirectoryNameFor(workspace.path).split("/")[0]!;
  if (state.included.length !== 1 || state.included[0] !== designTopLevel) {
    return;
  }
  const normalized = await setWorkingDirectories(workspace.path, state.all);
  if (normalized.leftBehind.length > 0) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message:
        "The legacy Design-only checkout could not be fully materialized.",
      remediation:
        "Review the locally modified paths, then switch to Code mode again.",
      context: {
        workspaceId: workspace.id,
        paths: normalized.leftBehind.slice(0, 20),
      },
    });
  }
}

/** Exit Design view without hiding, staging, committing, or moving Design
 * files. Legacy migration failures are reported directly; there is no
 * alternate execution backend or containment fallback. */
export async function exitDesignMode(workspace: Workspace): Promise<void> {
  writeMarker(workspace.id, "exit");
  try {
    await normalizeLegacyDesignCone(workspace);
    await unlockLegacyDesignWorkspaceLock(workspace.path);
    updateWorkspace(workspace.id, { viewMode: "code" });
    clearMarker(workspace.id);
  } catch (cause) {
    throw cause instanceof GitError
      ? cause
      : new GitError({
          code: "GIT_COMMAND_FAILED",
          message: "The legacy Design workspace cleanup did not complete.",
          cause,
          remediation:
            "Close processes using the checkout and switch to Code mode again; no alternate backend will be used.",
          context: { workspaceId: workspace.id },
        });
  }
}

/** Prime the active Design identity for a workspace that already carries one.
 * Historical name retained for compatibility; Code admission uses the identity
 * for instructions and lifecycle checks, while Design agents use it in ZSR. */
export async function fenceWorkspaceDesignDirectoryIfPresent(workspace: {
  path: string;
  repoRoot: string;
}): Promise<void> {
  // Sticky recognition covers the engine-created first-use draft
  // ("<repo> - Design"), which has no committed marker until the user commits
  // it and no pointer of its own: without it a restart would re-prime the
  // unconfigured default and orphan the live draft.
  const sticky = await stickyRecognizedDesignDirectories(workspace.path);
  await resolveDesignDirectoryForEnter(workspace, {
    strict: false,
    additionalRecognized: sticky,
  });
}

/** Re-prime semantic identity after external Git moves HEAD. Older builds also
 * repaired partial ACL-blocked checkouts here; current builds install no ACL,
 * so rewriting working files would risk destroying legitimate external edits. */
export async function reconcileDesignDirAfterExternalGit(workspace: {
  path: string;
  repoRoot?: string;
}): Promise<void> {
  const sticky = await stickyRecognizedDesignDirectories(workspace.path);
  await resolveDesignDirectoryForEnter(
    { path: workspace.path, repoRoot: workspace.repoRoot ?? workspace.path },
    { strict: false, additionalRecognized: sticky },
  );
}

/** Rename the repo's design directory — folder and pointer in ONE commit.
 *
 *  Runs in the repo's MAIN checkout: the folder is committed content, so a
 *  rename is a git operation, not a settings edit. The `[design] directory`
 *  pointer is updated in the committed `.zeros/settings.toml` and committed
 *  TOGETHER with the `git mv` — split across two commits, a teammate can pull
 *  a pointer aimed at a folder that doesn't exist yet (or vice versa).
 *
 *  Refused while any live design-mode workspace exists for the repo: their
 *  open documents and zeros-design:// resources are all
 *  rooted at the old name, and rewriting them mid-session is not worth the
 *  complexity while the rename is one Archive/Exit away from being safe.
 *  Refused when the folder or committed settings file has uncommitted changes
 *  in the main checkout — an automatic commit would sweep them silently into
 *  the rename. */
export async function renameDesignDirectory(opts: {
  repoRoot: string;
  from: string;
  to: string;
}): Promise<{ committedPointer: boolean }> {
  return withWorkspaceGitMutation(opts.repoRoot, () =>
    renameDesignDirectoryAdmitted(opts),
  );
}

async function renameDesignDirectoryAdmitted(opts: {
  repoRoot: string;
  from: string;
  to: string;
}): Promise<{ committedPointer: boolean }> {
  const from = sanitizeDesignDirectoryName(opts.from);
  const to = sanitizeDesignDirectoryName(opts.to);
  if (!from || !to) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Design folder names must be repo-relative paths.",
    });
  }
  if (from === to) return { committedPointer: false };
  const liveDesign = listWorkspaces({ archived: false }).filter(
    (workspace) =>
      workspace.kind === "design" &&
      path.resolve(workspace.repoRoot) === path.resolve(opts.repoRoot),
  );
  if (liveDesign.length > 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${liveDesign.length} design workspace${liveDesign.length === 1 ? " is" : "s are"} still open on this repo.`,
      remediation:
        "Archive them (or switch them to code mode), rename the folder, then restore.",
    });
  }
  const settingsPath = ".zeros/settings.toml";
  const tracked = await runGit(opts.repoRoot, [
    "ls-files",
    "-z",
    "--",
    literalGitPathspec(from),
  ]);
  if (!tracked.stdout.split("\0").some(Boolean)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `"${from}" isn't a tracked design folder in this repository.`,
    });
  }
  if (existsSync(path.join(opts.repoRoot, ...to.split("/")))) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `"${to}" already exists — pick a name that isn't taken.`,
    });
  }
  const dirty = await runGit(opts.repoRoot, [
    "status",
    "--porcelain",
    "--",
    literalGitPathspec(from),
    literalGitPathspec(settingsPath),
  ]);
  if (dirty.stdout.trim()) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        `"${from}" or ${settingsPath} has uncommitted changes in the ` +
        "main checkout.",
      remediation:
        "Commit or stash those changes, then rename the design folder.",
    });
  }
  // A nested target ("apps/web/designs") needs its parent to exist before
  // `git mv` can move into it.
  const toParent = path.dirname(path.join(opts.repoRoot, ...to.split("/")));
  await mkdir(toParent, { recursive: true });
  await runGit(opts.repoRoot, ["mv", "--", from, to]);
  // Point the committed team default at the new name. Best-effort staging:
  // a repo that gitignores `.zeros/` keeps the pointer as a local file (git
  // refuses to add an ignored path without -f, and force-committing a file
  // the repo explicitly ignores is not our call to make).
  opSettingsWrite("repo", { design: { directory: to } }, opts.repoRoot);
  let committedPointer = true;
  try {
    await runGit(opts.repoRoot, [
      "add",
      "--",
      literalGitPathspec(settingsPath),
    ]);
  } catch {
    committedPointer = false;
  }
  await runGit(opts.repoRoot, [
    "-c",
    "user.name=Zeros",
    "-c",
    "user.email=zeros@localhost",
    "commit",
    "--no-verify",
    "-m",
    `Rename design directory to ${to}`,
    "--",
    literalGitPathspec(from),
    literalGitPathspec(to),
    ...(committedPointer ? [literalGitPathspec(settingsPath)] : []),
  ]);
  return { committedPointer };
}

/** Complete a crash-interrupted view flip. View transitions never alter the
 * checkout, index, Git history, or execution backend. */
export async function reconcileDesignModeTransition(
  workspaceId: string,
): Promise<void> {
  const marker = readMarker(workspaceId);
  if (!marker) return;
  const workspace = getWorkspaceById(workspaceId);
  if (!workspace || !existsSync(workspace.path)) {
    clearMarker(workspaceId);
    return;
  }
  clearMarker(workspaceId);
}

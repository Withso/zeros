// ──────────────────────────────────────────────────────────
// Design mode — one workspace, two CONCURRENT modes
// ──────────────────────────────────────────────────────────
//
// A workspace is never "a design workspace" by species: every worktree is
// created through the same code pipeline (same base ref, files-to-copy
// seeding, setup, context graph), and the MODE is simply which surface the
// user is working in. Both halves stay alive at once — agents and terminals
// keep editing code territory while the design canvas is open — so the mode
// switch enforces nothing and blocks on nothing; it ensures the design
// document exists, flips the row, and returns.
//
// Isolation is TERRITORIAL and ACTOR-SCOPED:
//
//   • a Zeros-launched code agent receives an immutable provider sandbox whose
//     write map carves out every recognized Design subtree;
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
// remaining filesystem legs are small (ensure/commit the doc and legacy
// cleanup), and every one is idempotent.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  discoverDesignDirectories,
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
import { opSettingsWrite } from "../settings/ops";
import { GitError } from "./errors";
import { runGit } from "./git-exec";
import {
  getWorkingDirectories,
  setWorkingDirectories,
} from "./sparse-checkout";
import {
  getWorkspaceById,
  getWorkspaceMeta,
  listWorkspaces,
  setWorkspaceMeta,
  updateWorkspace,
} from "./state";
import type { Workspace, WorkspaceMode } from "./types";

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

/** Ensure the design document exists and is committed, WITHOUT sweeping
 *  unrelated work into the commit.
 *
 *  Entering design mode on a live workspace must never turn the user's
 *  in-flight code-mode changes into a surprise "Initialize Zeros Design"
 *  commit, so the staging is narrowed by what was actually found:
 *
 *    • design folder has NO tracked files (first enter, or a design folder
 *      pasted in from another repo): force-add the whole folder — untracked
 *      and gitignore-swallowed files alike — and commit it by pathspec.
 *    • folder tracked, but seed files were MISSING (partial doc): force-add
 *      exactly the created paths and commit those.
 *    • folder tracked and complete: no commit at all. The user's own design
 *      edits stay uncommitted until they Save designs.
 *
 *  Commits are pathspec-limited (`git commit -- <paths>`), so whatever else
 *  is staged in the index stays staged and uncommitted. */
export async function ensureDesignDocumentCommitted(
  workspacePath: string,
  designDir: string = designDirectoryNameFor(workspacePath),
): Promise<{ committed: boolean }> {
  const { created } = await initializeDesignDocument(workspacePath);
  const tracked = await runGit(workspacePath, [
    "ls-files",
    "-z",
    "--",
    literalGitPathspec(designDir),
  ]);
  const commitPaths: string[] = [];
  if (!tracked.stdout.split("\0").some(Boolean)) {
    await runGit(workspacePath, [
      "add",
      "-f",
      "-A",
      "--",
      literalGitPathspec(designDir),
    ]);
    commitPaths.push(designDir);
  } else if (created.length > 0) {
    await runGit(workspacePath, [
      "add",
      "-f",
      "--",
      ...created.map(literalGitPathspec),
    ]);
    commitPaths.push(...created);
  } else {
    return { committed: false };
  }
  // The add above can be a no-op tree-wise (a checkout hook already committed
  // the seeds); commit only when it actually staged a delta, mirroring the
  // original create-time sequence.
  const staged = await runGit(workspacePath, [
    "diff",
    "--cached",
    "--name-only",
    "--",
    ...commitPaths.map(literalGitPathspec),
  ]);
  if (!staged.stdout.trim()) return { committed: false };
  await runGit(workspacePath, [
    "-c",
    "user.name=Zeros",
    "-c",
    "user.email=zeros@localhost",
    "commit",
    "--no-verify",
    "-m",
    "Initialize Zeros Design",
    "--",
    ...commitPaths.map(literalGitPathspec),
  ]);
  return { committed: true };
}

/** Dissolve the sparse cone pre-mode builds wrote for design workspaces.
 *
 *  Under the mode model a design checkout is FULL — the codebase is present
 *  and read-only, not absent — so a surviving cone is legacy state. It is
 *  normalized on EXIT (materialize everything, then the unlock sweep covers
 *  whatever appeared) rather than at boot, so a legacy design workspace is
 *  never churned while the user isn't touching it. Best-effort: a non-cone /
 *  unsupported sparse state is left alone for the Working-directories picker
 *  to surface, and a failure here must not block leaving design mode. */
async function normalizeLegacyCone(workspacePath: string): Promise<void> {
  try {
    const state = await getWorkingDirectories(workspacePath);
    if (!state.sparse || !state.supported) return;
    const result = await setWorkingDirectories(workspacePath, state.all);
    if (result.leftBehind.length > 0) {
      console.warn(
        `[design-mode] ${result.leftBehind.length} path(s) had local ` +
          `modifications while dissolving the legacy design cone at ` +
          `${workspacePath}; they were left on disk.`,
      );
    }
  } catch (error) {
    console.warn(
      `[design-mode] couldn't dissolve the legacy design cone at ` +
        `${workspacePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}

/** Enter design mode on a live code-mode workspace.
 *
 *  An existing or admission-reserved Design subtree is already carved out of
 *  every code-agent sandbox, so switching the visible surface does not disturb
 *  those agents. `withFirstTerritoryCreation` asks the engine to prove that
 *  identity; only a legacy/stale boundary admitted before reservation is
 *  retired before initialization creates/publishes the document.
 *  Order: preview identity → optional authority transition → publish identity
 *  → marker → ensure/commit doc → flip row → clear marker. */
export async function enterDesignMode(
  workspace: Workspace,
  opts: {
    withFirstTerritoryCreation?: (
      designDirectory: string,
      mutation: () => Promise<void>,
    ) => Promise<void>;
  } = {},
): Promise<void> {
  // Decide WHICH folder is the design folder before anything durable happens:
  // the `[design] directory` pointer, with recognition/adoption of committed
  // design folders (the copy-paste-between-repos case). A refusal here — the
  // pointer dangles and several candidates exist — aborts cleanly with no
  // marker written. This is deliberately a PREVIEW: on first use, publishing
  // the identity before the authority transition would let a concurrent
  // Design observer target the new subtree while old code processes were
  // still alive. Publication and creation therefore happen inside the same
  // process-start block below.
  const designDir = await previewDesignDirectoryForEnter(workspace);
  const createOrEnter = async (): Promise<void> => {
    primeDesignDirectoryName(workspace.path, designDir);
    writeMarker(workspace.id, "enter");
    try {
      await ensureDesignDocumentCommitted(workspace.path, designDir);
      updateWorkspace(workspace.id, { viewMode: "design" });
    } catch (error) {
      updateWorkspace(workspace.id, { viewMode: "code" });
      clearMarker(workspace.id);
      throw error;
    }
    clearMarker(workspace.id);
  };
  const designDirectory = path.join(workspace.path, ...designDir.split("/"));
  // An untracked default folder may have been pre-seeded by a checkout hook—or
  // created while a no-Design code session was alive. Existence alone does not
  // make it an established authority boundary. Retire the old sandbox before
  // the first committed marker is created, even when the directory already
  // exists, so pre-seeding cannot open a creation-time policy race.
  const recognized = await discoverDesignDirectories(workspace.path);
  if (!recognized.includes(designDir) && opts.withFirstTerritoryCreation) {
    await opts.withFirstTerritoryCreation(designDirectory, createOrEnter);
    return;
  }
  await createOrEnter();
}

/** Exit design mode: marker → flip row → dissolve legacy cone → sweep off
 *  legacy whole-tree ACLs (pre-concurrency builds locked the entire codebase
 *  while in design mode) → clear marker. When the sweep reports failures the marker is KEPT so boot
 *  retries; the row stays "code" (visible, actionable) and the error names
 *  the stragglers rather than silently leaving read-only source. */
export async function exitDesignMode(workspace: Workspace): Promise<void> {
  writeMarker(workspace.id, "exit");
  updateWorkspace(workspace.id, { viewMode: "code" });
  await normalizeLegacyCone(workspace.path);
  try {
    await unlockLegacyDesignWorkspaceLock(workspace.path);
  } catch (error) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: "Some files are still read-only after leaving design mode.",
      cause: error,
      remediation:
        "Close processes using this workspace and switch modes again (or restart Zeros) to finish unlocking.",
      context: { workspaceId: workspace.id },
    });
  }
  clearMarker(workspace.id);
}

/** Prime the active Design identity for a workspace that already carries one.
 * Historical name retained for compatibility; provider admission installs the
 * actual actor-scoped write boundary. */
export async function fenceWorkspaceDesignDirectoryIfPresent(workspace: {
  path: string;
  repoRoot: string;
}): Promise<void> {
  await resolveDesignDirectoryForEnter(workspace, {
    strict: false,
  });
}

/** Re-prime semantic identity after external Git moves HEAD. Older builds also
 * repaired partial ACL-blocked checkouts here; current builds install no ACL,
 * so rewriting working files would risk destroying legitimate external edits. */
export async function reconcileDesignDirAfterExternalGit(workspace: {
  path: string;
  repoRoot?: string;
}): Promise<void> {
  await resolveDesignDirectoryForEnter(
    { path: workspace.path, repoRoot: workspace.repoRoot ?? workspace.path },
    { strict: false },
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

/** Complete transitions a crash interrupted. Directions are re-derived from
 *  marker + row state:
 *
 *    enter + design row → the flip landed: finish compatibility cleanup.
 *    enter + code row   → nothing durable happened: clear the marker.
 *    exit  + code row   → the flip landed, the legacy sweep may not have:
 *                         dissolve cone and sweep.
 *    exit  + design row → the flip never landed: clear the marker (the row
 *                         is still consistently in design mode).
 */
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
  const mode: WorkspaceMode = workspace.kind === "design" ? "design" : "code";
  if (marker === "exit" && mode === "code") {
    await normalizeLegacyCone(workspace.path);
    await unlockLegacyDesignWorkspaceLock(workspace.path);
  }
  clearMarker(workspaceId);
}

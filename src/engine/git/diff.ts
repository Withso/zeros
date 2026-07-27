// Read-path git: status, diff, log.
//
// `status` shells out to `git status --porcelain` (byte-exact paths,
// conflict + untracked handling that matches system git). `diff` shells out
// to `git diff` because system git produces well-formed unified diffs and we
// just need to parse hunk headers. `log` uses isomorphic-git's log (no
// subprocess) for fast, structured commit history.

import * as git from "isomorphic-git";
import nodeFs from "node:fs";
import path from "node:path";
import { resolveRepoForGitOp } from "./worktree";
import { runGit, assertSafeGitRef } from "./git-exec";
import { resolveRepoGit } from "../settings/repo-git";
import { isConflictEntry, parsePorcelainZ } from "./porcelain";
import { getInProgressState } from "./repo";
import { GitError } from "./errors";
import type {
  Commit,
  FileChange,
  FileChangeStatus,
  Hunk,
  Workspace,
} from "./types";

const fs = nodeFs;

/** Stdout cap for the multi-file `git diff` read (runGit's default is 16 MB).
 *  A branch's whole contribution can legitimately exceed that (lockfiles,
 *  generated code); when even this cap is hit, diff() throws a named
 *  "too big to display" error instead of a bare "git … failed". */
const DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Note on worktree support: isomorphic-git's per-worktree index lives
// at `<repo>/.git/worktrees/<id>/index` and the shared ref store is at
// `<repo>/.git/`. There's no way to ask isomorphic-git to use both at
// once — and the worktree's `commondir` pointer isn't reliably followed.
//
//   - `status` shells out to system git (porcelain v1). System git
//     follows commondir natively, so it sees the right index + refs.
//   - `log` uses isomorphic-git against the shared `.git` directly,
//     passing the workspace's branch as `ref`. The shared ref store is
//     where every branch lives anyway, so this works correctly.
//   - `diff` shells out to system git for the same reason as status.

// ── status ───────────────────────────────────────────────

/** In-progress multi-step git operation, surfaced so the UI can show a
 *  conflict banner with Continue/Abort. */
export type ConflictState =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | null;

export interface StatusResult {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  /** Unmerged files (conflict markers present). D.2. */
  conflicted: FileChange[];
  /** Non-null when a merge/rebase/cherry-pick/revert is mid-flight. */
  conflictState: ConflictState;
  /** Local commits ahead of the upstream tracking branch (unpushed). Null when
   *  the branch has no upstream yet — powers the PR island's "Ahead / Push". */
  ahead: number | null;
  /** Commits the upstream has that the local branch doesn't (unpulled). Null
   *  when there's no upstream — powers the PR island's "Behind / Pull". */
  behind: number | null;
  /** The upstream tracking ref (e.g. `origin/zeros/foo`), or null when unset. */
  upstream: string | null;
}

/** File totals for the four live Changes scopes. Each total is computed from
 * the same Git comparison that renders that scope, rather than by unioning the
 * two porcelain columns. That distinction matters for an `AD` entry (a newly
 * staged file subsequently removed from disk): it is one staged addition and
 * one unstaged deletion, but it is no net change versus HEAD/base. */
export interface ChangeCounts {
  all: number;
  uncommitted: number;
  staged: number;
  unstaged: number;
}

export type ChangePathFilter = (path: string, oldPath?: string) => boolean;

const letterToStatus = (letter: string): FileChangeStatus | null => {
  switch (letter) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "added";
    default:
      return null;
  }
};

/** Bucket porcelain entries into staged / unstaged / untracked /
 *  conflicted. The `-z` records carry byte-exact paths (parsePorcelainZ). */
function parsePorcelain(out: string): {
  staged: FileChange[];
  unstaged: FileChange[];
  untracked: string[];
  conflicted: FileChange[];
} {
  const staged: FileChange[] = [];
  const unstaged: FileChange[] = [];
  const untracked: string[] = [];
  const conflicted: FileChange[] = [];

  for (const e of parsePorcelainZ(out)) {
    if (e.x === "?" && e.y === "?") {
      untracked.push(e.path);
      continue;
    }
    if (isConflictEntry(e)) {
      conflicted.push({ path: e.path, status: "conflicted" });
      continue;
    }
    const stagedStatus = letterToStatus(e.x);
    const unstagedStatus = letterToStatus(e.y);
    if (stagedStatus) {
      // oldPath only belongs on the side that is actually a rename/copy.
      // A staged rename then a working-tree edit (RM) must NOT label the
      // unstaged-modified side with the rename source.
      const isRename = e.x === "R" || e.x === "C";
      staged.push({
        path: e.path,
        status: stagedStatus,
        ...(isRename && e.oldPath ? { oldPath: e.oldPath } : {}),
      });
    }
    if (unstagedStatus) {
      const isRename = e.y === "R" || e.y === "C";
      unstaged.push({
        path: e.path,
        status: unstagedStatus,
        ...(isRename && e.oldPath ? { oldPath: e.oldPath } : {}),
      });
    }
  }
  return { staged, unstaged, untracked, conflicted };
}

/** Filter the legacy in-tree `.zeros/` seed (pre-relocation worktrees only;
 *  the crash-recovery seed now lives in app-data) from the untracked list —
 *  it's an implementation detail, not user content. */
function isInternal(p: string): boolean {
  return p === ".zeros" || p.startsWith(".zeros/");
}

export async function status(workspaceId: string): Promise<StatusResult> {
  const ws = await resolveRepoForGitOp(workspaceId);
  // `-z` = NUL-delimited, byte-exact paths (C1). `-uall` lists every
  // untracked file individually (not collapsed to the dir) so the
  // Changes tab can stage them one by one.
  const { stdout } = await runGit(ws.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "-uall",
  ]);
  const parsed = parsePorcelain(stdout);
  // Conflict state (merge/rebase/cherry-pick/revert mid-flight) so the UI
  // can show a banner; never let the probe fail the status read.
  let conflictState: ConflictState = null;
  try {
    conflictState = await getInProgressState(ws.path);
  } catch {
    conflictState = null;
  }
  // Ahead/behind vs the upstream tracking branch — best-effort so the PR island
  // can offer "Push" (unpushed local commits) / "Pull" (unpulled remote work).
  // A branch with no upstream (never pushed) yields null counts, which the UI
  // reads as "unknown" and skips those states.
  const tracking = await upstreamAheadBehind(ws.path);
  return {
    staged: parsed.staged.filter((f) => !isInternal(f.path)),
    unstaged: parsed.unstaged.filter((f) => !isInternal(f.path)),
    untracked: parsed.untracked.filter((p) => !isInternal(p)),
    conflicted: parsed.conflicted.filter((f) => !isInternal(f.path)),
    conflictState,
    ahead: tracking.ahead,
    behind: tracking.behind,
    upstream: tracking.upstream,
  };
}

function addVisibleChanges(
  paths: Set<string>,
  changes: readonly FileChange[],
  includePath: ChangePathFilter,
): void {
  for (const change of changes) {
    if (!isInternal(change.path) && includePath(change.path, change.oldPath)) {
      paths.add(change.path);
    }
  }
}

function addVisiblePaths(
  paths: Set<string>,
  additions: readonly string[],
  includePath: ChangePathFilter,
): void {
  for (const addition of additions) {
    if (!isInternal(addition) && includePath(addition)) paths.add(addition);
  }
}

async function diffNameStatus(
  worktreePath: string,
  rangeArgs: readonly string[],
): Promise<FileChange[]> {
  const { stdout } = await runGit(worktreePath, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "--name-status",
    "-z",
    ...rangeArgs,
  ]);
  return parseNameStatusZ(stdout);
}

/** Lightweight, path-free summary for the Changes badge and scope menu.
 *
 * `git status` remains the source for staged/unstaged/untracked/conflicted
 * membership. Net scopes use `git diff --name-status` against HEAD or the
 * branch fork point, exactly matching their full-patch list queries. The
 * optional filter is applied inside the engine before counting, allowing a
 * remote client to receive totals that match its secret-filtered lists without
 * exposing any host path. */
export async function changeCounts(
  workspaceId: string,
  includePath: ChangePathFilter = () => true,
): Promise<ChangeCounts> {
  const ws = await resolveRepoForGitOp(workspaceId);
  const { remote } = resolveRepoGit(ws.repoRoot);
  const [{ stdout }, resolvedFloor] = await Promise.all([
    runGit(ws.path, ["status", "--porcelain=v1", "-z", "-uall"]),
    forkPoint(ws.path, ws.baseBranch, remote),
  ]);
  const parsed = parsePorcelain(stdout);
  const floor = resolvedFloor ?? "HEAD";
  const [allTracked, uncommittedTracked] = await Promise.all([
    diffNameStatus(ws.path, [floor]),
    diffNameStatus(ws.path, ["HEAD"]),
  ]);

  const conflicts = new Set<string>();
  addVisibleChanges(conflicts, parsed.conflicted, includePath);

  const all = new Set(conflicts);
  addVisibleChanges(all, allTracked, includePath);
  addVisiblePaths(all, parsed.untracked, includePath);

  const uncommitted = new Set(conflicts);
  addVisibleChanges(uncommitted, uncommittedTracked, includePath);
  addVisiblePaths(uncommitted, parsed.untracked, includePath);

  const staged = new Set(conflicts);
  addVisibleChanges(staged, parsed.staged, includePath);

  const unstaged = new Set(conflicts);
  addVisibleChanges(unstaged, parsed.unstaged, includePath);
  addVisiblePaths(unstaged, parsed.untracked, includePath);

  return {
    all: all.size,
    uncommitted: uncommitted.size,
    staged: staged.size,
    unstaged: unstaged.size,
  };
}

/** Exact "anything worth a PR?" probe — the single signal shared by the
 * Create-PR button and Dashboard cards. It uses the same base-vs-worktree net
 * comparison as the default All Changes scope, so index/worktree operations
 * that cancel out (notably `AD`) do not enable a PR for an empty diff.
 * Best-effort: any Git failure reads as "no changes" rather than throwing. */
export async function hasWorkspaceChanges(
  workspaceId: string,
): Promise<boolean> {
  try {
    return (await changeCounts(workspaceId)).all > 0;
  } catch {
    return false;
  }
}

/** Stamp `hasChanges` on a workspace list with PARALLEL best-effort git probes.
 *  Only live rows are probed — archived / missing / synthetic-trunk rows get
 *  `false` — so the cost is bounded to the board's real worktrees. Used by
 *  workspace.list when the caller asks for change state (the Dashboard). */
export async function stampChangeState(
  workspaces: Workspace[],
): Promise<Workspace[]> {
  return Promise.all(
    workspaces.map(async (w) => {
      if (w.archivedAt != null || w.present === false || w.repoSlug === "") {
        return { ...w, hasChanges: false };
      }
      return { ...w, hasChanges: await hasWorkspaceChanges(w.id) };
    }),
  );
}

/** Read the branch's upstream ref + ahead/behind counts in one shot. Returns
 *  all-null when the branch has no `@{upstream}` (never pushed / detached), so
 *  callers treat it as "unknown" rather than "in sync". Never throws — a
 *  missing upstream is the common, expected case, not an error. */
async function upstreamAheadBehind(worktreePath: string): Promise<{
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
}> {
  let upstream: string | null = null;
  try {
    const { stdout } = await runGit(worktreePath, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    upstream = stdout.trim() || null;
  } catch {
    return { ahead: null, behind: null, upstream: null };
  }
  if (!upstream) return { ahead: null, behind: null, upstream: null };
  try {
    const { stdout } = await runGit(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      "@{upstream}...HEAD",
    ]);
    // `<behind> <ahead>` — left side is @{upstream}, right is HEAD.
    const [behind, ahead] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => parseInt(n, 10) || 0);
    return { ahead: ahead ?? 0, behind: behind ?? 0, upstream };
  } catch {
    return { ahead: null, behind: null, upstream };
  }
}

// ── diff ─────────────────────────────────────────────────

/** Generalized diff comparison mode (D.1). Supersedes the legacy
 *  `against` selector; when `mode` is set it wins.
 *    'worktree-vs-index' → unstaged changes (default; `git diff`)
 *    'index-vs-head'     → staged changes (`git diff --cached`)
 *    'worktree-vs-head'  → all uncommitted tracked changes (`git diff HEAD`)
 *    'worktree-vs-base'  → this branch's COMMITTED *and* uncommitted tracked
 *                          changes in one net diff (`git diff <forkPoint>`;
 *                          fork point → working tree). Powers "All changes".
 *    'base'              → `base...HEAD` (3-dot; this branch's COMMITTED changes)
 *    'refs'              → arbitrary `base...head` (branch/commit compare)
 *
 *  Audit note (2026-06-19): the Changes view uses 'index-vs-head' +
 *  'worktree-vs-index' (uncommitted), 'worktree-vs-base' (All changes) and
 *  'refs' (compare); Review uses 'base'. 'worktree-vs-head' is exposed and
 *  tested but has NO current UI caller — it is reachable only via the legacy
 *  `against:'HEAD'` shim below, which is itself unused. Keep it (cheap, correct)
 *  or drop it with `against` if trimming. */
export type DiffMode =
  | "worktree-vs-index"
  | "index-vs-head"
  | "worktree-vs-head"
  | "worktree-vs-base"
  | "base"
  | "refs";

export interface DiffOptions {
  workspaceId: string;
  /** Restrict to a single file. */
  filePath?: string;
  /** @deprecated Legacy selector, mapped onto `mode` via `againstToMode`. As of
   *  the 2026-06-19 audit it has NO caller — every call site (renderer
   *  `gitDiff`, `workspace-bridge`, `service.ts`) passes `mode`. Retained only
   *  for bridge back-compat (a stale web client could still send it); safe to
   *  remove together with `worktree-vs-head` once no old client remains. */
  against?: "index" | "HEAD" | "main";
  /** Generalized comparison mode (overrides `against`). The live selector. */
  mode?: DiffMode;
  /** For mode:'refs' — the base ref/commit (required for 'refs'). */
  base?: string;
  /** For mode:'refs' — the head ref/commit (defaults to HEAD). */
  head?: string;
  /** Also return the raw unified-diff text in `DiffResult.patch`.
   *  `@pierre/diffs` <PatchDiff> consumes this directly — no parse. */
  rawPatch?: boolean;
}

export interface DiffResult {
  hunks: Hunk[];
  /** Present when `rawPatch` was requested: the raw `git diff` stdout. */
  patch?: string;
}

/** Map the legacy `against` selector onto a DiffMode. */
function againstToMode(against: DiffOptions["against"]): DiffMode {
  switch (against) {
    case "HEAD":
      return "worktree-vs-head";
    case "main":
      return "base";
    case "index":
    default:
      return "worktree-vs-index";
  }
}

/** Build the range/flag args that select what `git diff` compares. */
function diffRangeArgs(opts: DiffOptions, baseBranch: string): string[] {
  const mode = opts.mode ?? againstToMode(opts.against);
  switch (mode) {
    case "index-vs-head":
      return ["--cached"];
    case "worktree-vs-head":
      return ["HEAD"];
    case "worktree-vs-base":
      // `baseBranch` has been resolved to the fork point (or "HEAD" for a fresh
      // branch) by diff() below — a SINGLE ref means "diff it against the WORKING
      // TREE", so this captures committed + uncommitted tracked changes at once.
      return [baseBranch];
    case "base":
      return [`${baseBranch}...HEAD`];
    case "refs": {
      if (!opts.base) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: "diff: mode 'refs' requires a 'base' ref",
        });
      }
      // base/head are caller-supplied refs and are now reachable from a remote
      // client (WorkspaceService forwards mode/base/head). Reject a leading-`-`
      // (flag injection) before they reach the `git diff` argv.
      const base = assertSafeGitRef(opts.base, "diff.base");
      const head = assertSafeGitRef(opts.head ?? "HEAD", "diff.head");
      return [`${base}...${head}`];
    }
    case "worktree-vs-index":
    default:
      return [];
  }
}

/** Resolve a persisted base-branch NAME to a concrete, reachable ref.
 *
 *  The workspace row stores `baseBranch` as a PLAIN name ("main",
 *  "feature/mumbai") — never "origin/main" — yet at query time that name may
 *  not resolve locally: the worktree was forked from `origin/<base>` (no local
 *  branch), or the base was since deleted / renamed. Without this, the commit
 *  list (`base..HEAD`) and "All changes" (`base...HEAD`) silently come back
 *  empty for work that was genuinely committed (by an agent, the terminal, or
 *  by hand). Try, in order: the name as-is (local branch / tag / sha /
 *  already-qualified ref), its remote-tracking copy on the CONFIGURED remote
 *  (`git.remote`, default origin — worktrees fork from `<remote>/<base>`),
 *  then the repo's trunk (<remote>/HEAD → main → master). Returns the first
 *  that names a commit, or null when there's nothing to compare against
 *  (e.g. an unborn HEAD). */
async function resolveBaseRef(
  worktreePath: string,
  base: string,
  remote: string,
): Promise<string | null> {
  // Only trust `base` as a candidate if it's a safe, non-empty ref name (no
  // leading "-" = no flag injection into the argv); else lean on the trunk.
  const safe =
    base && !base.startsWith("-") && !base.includes("\0") ? base : null;
  // Same guard for the settings-sourced remote before it lands in a ref argv.
  const safeRemote =
    remote && !remote.startsWith("-") && !remote.includes("\0")
      ? remote
      : "origin";
  const seen = new Set<string>();
  for (const ref of [
    safe,
    safe ? `${safeRemote}/${safe}` : null,
    `${safeRemote}/HEAD`,
    "main",
    "master",
    `${safeRemote}/main`,
    `${safeRemote}/master`,
  ]) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    try {
      await runGit(worktreePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${ref}^{commit}`,
      ]);
      return ref;
    } catch {
      /* not resolvable — try the next candidate */
    }
  }
  return null;
}

/** Run git, returning trimmed stdout or null on any failure (read-only probes). */
async function gitTry(
  worktreePath: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await runGit(worktreePath, args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
async function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await runGit(worktreePath, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** The DEEPEST merge-base of HEAD across the base's local AND remote-tracking
 *  variants. resolveBaseRef prefers the bare local name, but worktrees are
 *  created from `origin/<base>` — so a local base branch that's BEHIND its
 *  remote (cloned/checked out long ago, never pulled) would anchor the fork
 *  point at the stale local tip, and every upstream commit the local branch is
 *  missing would show up as this workspace's own changes (a brand-new worktree
 *  "full of changes"). The symmetric case (local ahead, remote stale) exists
 *  too. Compute the merge-base against each resolvable variant and keep the
 *  one closest to HEAD — the true fork point. */
async function bestMergeBase(
  worktreePath: string,
  resolved: string,
  base: string,
  remote: string,
): Promise<string | null> {
  const variants = new Set<string>([resolved]);
  if (base && !base.startsWith("-") && !base.includes("\0")) {
    variants.add(base);
    if (remote && !remote.startsWith("-") && !remote.includes("\0")) {
      variants.add(`${remote}/${base}`);
    }
    variants.add(`origin/${base}`); // legacy worktrees forked pre-setting
  }
  let best: string | null = null;
  for (const ref of variants) {
    const mb = await gitTry(worktreePath, ["merge-base", ref, "HEAD"]);
    if (!mb || mb === best) continue;
    if (!best || (await isAncestor(worktreePath, best, mb))) best = mb;
  }
  return best;
}

/** The commit this worktree FORKED from — the floor for "what this branch
 *  added". This is the durable anchor the persisted base *name* can't provide:
 *
 *   1. the merge-base with `base` (where HEAD diverged) — the normal case, and
 *      identical to `base..HEAD` whenever the base is behind HEAD;
 *   2. but if the base has ABSORBED this branch (merge-base == HEAD — e.g. the
 *      branch was merged into main, so main now contains every commit and
 *      `base..HEAD` is empty), recover the branch's CREATION commit from its
 *      reflog ("branch: Created from …"), so an already-merged worktree still
 *      shows the commits it contributed.
 *
 *  Returns a commit SHA, or null when HEAD has genuinely added nothing (unborn
 *  HEAD, or HEAD == its fork point). */
async function forkPoint(
  worktreePath: string,
  base: string,
  remote: string,
): Promise<string | null> {
  const resolved = await resolveBaseRef(worktreePath, base, remote);
  if (!resolved) return null;
  const head = await gitTry(worktreePath, ["rev-parse", "HEAD"]);
  if (!head) return null;
  let floor = await bestMergeBase(worktreePath, resolved, base, remote);
  if (!floor || floor === head) {
    const branch = await gitTry(worktreePath, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    // The reflog fallback recovers an already-MERGED branch's contribution. It
    // must never fire when the checkout IS the base branch itself (the "Local
    // main" trunk workspace, or a worktree the user switched onto the base):
    // merge-base(base, HEAD) == HEAD there by construction, and the base
    // branch's oldest reflog entry is the CLONE/checkout point — anchoring
    // there diffs the entire history since clone (tens of MB on an active
    // repo: blows runGit's maxBuffer, wedges the engine parsing it, and shows
    // every upstream commit as workspace changes).
    const onBaseItself =
      !branch ||
      branch === "HEAD" ||
      branch === base ||
      branch === resolved ||
      `${remote}/${branch}` === resolved ||
      `origin/${branch}` === resolved;
    if (!onBaseItself) {
      // `reflog show` is newest-first; the OLDEST entry is the branch's creation
      // point (the commit it was forked at). Survives the base moving past it.
      // Only trust a genuine creation record: after partial reflog expiry the
      // oldest surviving entry is an arbitrary commit, and anchoring there
      // over-reports just like the clone point would.
      const rl = await gitTry(worktreePath, [
        "reflog",
        "show",
        "--format=%H%x09%gs",
        branch,
      ]);
      const oldest = rl?.split("\n").filter(Boolean).pop();
      const tab = oldest?.indexOf("\t") ?? -1;
      const created = tab > 0 ? oldest!.slice(0, tab) : undefined;
      const subject = tab > 0 ? oldest!.slice(tab + 1) : "";
      if (
        created &&
        created !== head &&
        /^branch: Created from/.test(subject)
      ) {
        floor = created;
      }
    }
  }
  return floor && floor !== head ? floor : null;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified diff into structured hunks. Each `@@ -A,B +C,D @@`
 *  header opens a new hunk; the body up to the next header (or the
 *  next "diff --git" or EOF) is the hunk's lines. */
export function parseUnifiedDiff(raw: string): Hunk[] {
  const out: Hunk[] = [];
  const lines = raw.split("\n");
  let currentFilePath = "";
  let currentOldFilePath = "";
  let currentHunk: Hunk | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentHunk) {
      currentHunk.body = buffer.join("\n");
      out.push(currentHunk);
    }
    currentHunk = null;
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      flush();
      // Format: `diff --git a/<path> b/<path>` — capture BOTH sides (b is the
      // canonical path, a is the pre-image / rename source). If the header
      // can't be parsed (e.g. a path containing " b/", or quoting), set both to
      // "" so the hunk fails CLOSED in the remote secret filter rather than
      // inheriting a stale path. (We also run diff with core.quotePath=false so
      // non-ASCII paths parse cleanly.)
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      currentOldFilePath = m ? m[1] : "";
      currentFilePath = m ? m[2] : "";
      continue;
    }
    if (line.startsWith("@@")) {
      flush();
      const m = line.match(HUNK_HEADER_RE);
      if (m) {
        currentHunk = {
          filePath: currentFilePath,
          oldFilePath: currentOldFilePath,
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] ? parseInt(m[2], 10) : 1,
          newStart: parseInt(m[3], 10),
          newLines: m[4] ? parseInt(m[4], 10) : 1,
          body: "",
        };
        buffer = [line];
      }
      continue;
    }
    if (currentHunk) buffer.push(line);
  }
  flush();
  return out;
}

export async function diff(opts: DiffOptions): Promise<DiffResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  // Branch-relative diffs compare against the worktree's FORK POINT — the commit
  // it diverged from its base. Anchoring to the fork point (not the base's live
  // tip) keeps "All changes" correct when the base is remote-only, was
  // deleted/renamed, OR has since advanced to absorb this branch (merged into
  // main) — all of which would otherwise make the diff silently empty.
  const mode = opts.mode ?? againstToMode(opts.against);
  let rangeOpts = opts;
  let baseBranch = ws.baseBranch;
  const { remote } = resolveRepoGit(ws.repoRoot);
  if (mode === "refs" && opts.base) {
    rangeOpts = {
      ...opts,
      base: (await forkPoint(ws.path, opts.base, remote)) ?? opts.base,
    };
  } else if (mode === "base") {
    baseBranch =
      (await forkPoint(ws.path, ws.baseBranch, remote)) ?? ws.baseBranch;
  } else if (mode === "worktree-vs-base") {
    // Anchor at the fork point and diff it against the WORKING TREE, so "All
    // changes" lists this branch's whole contribution — committed AND
    // uncommitted — in one pass. A fresh branch (no commits past base, or unborn
    // HEAD) has no fork point → fall back to HEAD, i.e. `git diff HEAD`, which
    // surfaces just the uncommitted working tree (the only changes there are).
    baseBranch = (await forkPoint(ws.path, ws.baseBranch, remote)) ?? "HEAD";
  }
  // core.quotePath=false so non-ASCII paths appear unquoted in the
  // `diff --git` header → parseUnifiedDiff captures them (the remote secret
  // filter keys on that path; a quoted/unparsed path fails closed).
  const args: string[] = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    "-U3",
  ];
  args.push(...diffRangeArgs(rangeOpts, baseBranch));
  if (opts.filePath) args.push("--", opts.filePath);
  let stdout: string;
  try {
    ({ stdout } = await runGit(ws.path, args, {
      maxBufferBytes: DIFF_MAX_BUFFER_BYTES,
    }));
  } catch (err) {
    // A patch bigger than the buffer used to surface as a bare
    // "git … diff … failed" banner. Name the actual problem instead.
    const cause = (err as { cause?: unknown }).cause as
      | { code?: unknown }
      | undefined;
    if (cause?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new GitError({
        code: "GIT_COMMAND_FAILED",
        message: `diff is larger than ${Math.round(DIFF_MAX_BUFFER_BYTES / (1024 * 1024))} MB — too big to display; view individual files or commits instead`,
        cause: err,
      });
    }
    throw err;
  }
  return {
    hunks: parseUnifiedDiff(stdout),
    ...(opts.rawPatch ? { patch: stdout } : {}),
  };
}

// ── show commit ──────────────────────────────────────────

export interface ShowCommitResult {
  files: FileChange[];
  /** Raw multi-file unified diff for the commit (no commit header). */
  patch: string;
}

/** Parse `git diff-tree --name-status -z` output into FileChanges. */
function parseNameStatusZ(out: string): FileChange[] {
  const f = out.split("\0").filter((s) => s.length > 0);
  const res: FileChange[] = [];
  let i = 0;
  const map = (c: string): FileChangeStatus => {
    if (c === "A") return "added";
    if (c === "D") return "deleted";
    if (c === "R") return "renamed";
    if (c === "C") return "added";
    return "modified"; // M, T (type change), and anything else
  };
  while (i < f.length) {
    const code = f[i][0]; // e.g. "R100" → "R"
    if (code === "R" || code === "C") {
      res.push({ path: f[i + 2] ?? "", status: map(code), oldPath: f[i + 1] });
      i += 3;
    } else {
      res.push({ path: f[i + 1] ?? "", status: map(code) });
      i += 2;
    }
  }
  return res;
}

/** Show a single commit: its changed files + the raw unified diff.
 *  Uses `diff-tree` (plumbing) so there's no commit-message header to
 *  strip. Merge commits render empty in v1 (no `-m`). Powers the Review
 *  tab's commit list and a future history pane. */
/** Is `sha` present in the worktree's local object store? `cat-file -e` exits
 *  non-zero (→ runGit throws) when the object is absent. */
async function commitObjectExists(
  worktreePath: string,
  sha: string,
): Promise<boolean> {
  try {
    await runGit(worktreePath, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Ensure `sha` is in the local store before we diff it. A PR commit can be
 *  absent locally — force-push, or the worktree is behind / on another branch —
 *  in which case `diff-tree` fails with an opaque "bad object". GitHub serves
 *  any reachable SHA, so fetch the single object from the configured remote
 *  (`git.remote` — the one PRs target) and retry; if that fails, throw a CLEAR
 *  error instead of letting the diff pane error out raw. (Powers the Review →
 *  Commits sub-tab, which renders PR commit diffs from the local object store.) */
async function ensureCommitPresent(
  worktreePath: string,
  sha: string,
  remote: string,
): Promise<void> {
  if (await commitObjectExists(worktreePath, sha)) return;
  assertSafeGitRef(remote, "ensureCommitPresent.remote"); // settings-sourced
  try {
    // Reachable-SHA fetch (GitHub enables uploadpack.allowReachableSHA1InWant);
    // brings just this commit's objects into the shared store.
    await runGit(worktreePath, ["fetch", "--no-tags", remote, sha]);
  } catch (err) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Commit ${sha.slice(0, 7)} isn't in your local clone and couldn't be fetched from ${remote}.`,
      remediation:
        "Pull this branch (or fetch the PR ref), then reopen the commit.",
      cause: err,
    });
  }
  if (!(await commitObjectExists(worktreePath, sha))) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Commit ${sha.slice(0, 7)} is not available locally.`,
      remediation: "Pull the latest changes for this branch and try again.",
    });
  }
}

export async function showCommit(
  workspaceId: string,
  sha: string,
): Promise<ShowCommitResult> {
  // sha is caller-supplied and reachable from a remote client (git.show).
  // assertSafeGitRef rejects empty/non-string AND a leading-`-` (flag
  // injection into the diff-tree argv).
  assertSafeGitRef(sha, "showCommit.sha");
  const ws = await resolveRepoForGitOp(workspaceId);
  // The commit may not be in the local store (force-push / behind) — fetch it
  // (or fail with a clear message) before diffing.
  await ensureCommitPresent(ws.path, sha, resolveRepoGit(ws.repoRoot).remote);
  // core.quotePath=false so a non-ASCII path appears UNQUOTED in the
  // `diff --git` header → the remote secret filter's a/…b/ parser matches it
  // (a quoted header fails closed = the file is dropped, never rendered).
  const { stdout: patch } = await runGit(ws.path, [
    "-c",
    "core.quotePath=false",
    "diff-tree",
    "--no-commit-id",
    "-p",
    "-U3",
    "--no-color",
    "-r",
    sha,
  ]);
  const { stdout: ns } = await runGit(ws.path, [
    "-c",
    "core.quotePath=false",
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-z",
    "-r",
    sha,
  ]);
  return { files: parseNameStatusZ(ns), patch };
}

// ── log ──────────────────────────────────────────────────

export interface LogOptions {
  workspaceId: string;
  /** Max commits to return. Defaults to 50. */
  limit?: number;
  /** Filter to commits after this unix-ms timestamp. */
  since?: number;
  /** Start at a non-HEAD ref (e.g. 'main' to see only main's history). */
  ref?: string;
  /** When set, list ONLY `base..HEAD` — the commits this branch added on top
   *  of `base`, not the whole HEAD ancestry. */
  base?: string;
}

/** Return the commit log for the workspace.
 *
 *  • `base` set → ONLY this branch's own commits (`git log base..HEAD`):
 *    reachable from HEAD, not from base. isomorphic-git can't express an
 *    exclusion range, so this path shells out. Powers the Changes-tab scope
 *    picker, which must list the WORKTREE's commits — not the base branch's
 *    whole history.
 *  • no `base` → the fast isomorphic-git HEAD-history walk (no subprocess,
 *    JS-native commit objects, no parsing). */
export async function log(opts: LogOptions): Promise<Commit[]> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const limit = opts.limit ?? 50;
  if (limit < 1 || limit > 1000) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "log: 'limit' must be between 1 and 1000",
    });
  }
  if (opts.base) {
    return logRange(
      ws.path,
      opts.base,
      limit,
      resolveRepoGit(ws.repoRoot).remote,
      opts.since,
    );
  }

  const gitdir = path.join(ws.repoRoot, ".git");
  const commits = await git.log({
    fs,
    gitdir,
    depth: limit,
    ref: opts.ref ?? ws.branch,
    since: opts.since ? new Date(opts.since) : undefined,
  });
  return commits.map((c) => ({
    sha: c.oid,
    abbreviatedSha: c.oid.slice(0, 7),
    message: c.commit.message,
    authorName: c.commit.author.name,
    authorEmail: c.commit.author.email,
    authorDate: c.commit.author.timestamp * 1000,
    parents: c.commit.parent ?? [],
  }));
}

// Commits are NUL-terminated (`-z`); fields within a commit are split by US
// (0x1f), so a multi-line `%B` body stays intact inside its record.
const LOG_FIELD_SEP = "\x1f";
const LOG_FORMAT = ["%H", "%an", "%ae", "%at", "%P", "%B"].join(LOG_FIELD_SEP);

/** `git log base..HEAD` → only the commits this branch added on top of `base`
 *  (reachable from HEAD, not from base), newest first. */
async function logRange(
  worktreePath: string,
  base: string,
  limit: number,
  remote: string,
  since?: number,
): Promise<Commit[]> {
  // Anchor to the worktree's FORK POINT (the commit it diverged from its base),
  // recovered robustly even when the base is remote-only, was deleted, or has
  // since absorbed this branch — that's what lets the list show the commits this
  // worktree added regardless of how/where the base moved. null = nothing added.
  const floor = await forkPoint(worktreePath, base, remote);
  if (!floor) return [];
  const args = ["log", `--max-count=${limit}`, "-z", `--format=${LOG_FORMAT}`];
  if (since) args.push(`--since=${new Date(since).toISOString()}`);
  args.push(`${floor}..HEAD`);
  let stdout: string;
  try {
    ({ stdout } = await runGit(worktreePath, args));
  } catch {
    return [];
  }
  return stdout
    .split("\0")
    .filter((r) => r.length > 0)
    .map((r) => {
      const parts = r.split(LOG_FIELD_SEP);
      const [
        sha = "",
        authorName = "",
        authorEmail = "",
        at = "0",
        parents = "",
      ] = parts;
      return {
        sha,
        abbreviatedSha: sha.slice(0, 7),
        message: parts.slice(5).join(LOG_FIELD_SEP),
        authorName,
        authorEmail,
        authorDate: (parseInt(at, 10) || 0) * 1000,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
      };
    });
}

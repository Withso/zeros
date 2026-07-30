// ──────────────────────────────────────────────────────────
// Per-turn git plumbing — snapshots, attribution, per-turn diff, reset
// ──────────────────────────────────────────────────────────
//
// Backs the "turns + reset to this point" feature (see
// docs/turns-and-reset-to-point-plan-2026-06-24.md). The design decisions this
// module encodes:
//
//  • SNAPSHOTS are whole-tree commits captured into a HIDDEN ref namespace
//    (refs/zeros/turns/*) using a SCRATCH index (GIT_INDEX_FILE) so the user's
//    real index / branch / working tree are never touched, and the user's
//    `git log` / `status` never show them. They're ref-pinned so `git gc`
//    won't prune them; reset deletes the refs it no longer needs. `.gitignore`
//    is respected (node_modules/dist/etc. excluded — decision #3).
//
//  • ATTRIBUTION (which files a turn changed) comes from the agent's OWN
//    edit/delete/move tool calls — NOT a whole-tree snapshot diff — so a
//    concurrent chat editing the same working tree never leaks into this turn's
//    file list. That is the only concurrency-safe attribution signal.
//
//  • RESET restores each authored path to its pre-turn content. The common case
//    (nobody else changed the file since this chat last wrote it — detected by
//    a blob-OID compare) is an exact, binary-safe `git restore --source`. When
//    the file HAS diverged (a concurrent chat edited it), we 3-way merge; a
//    clean merge preserves the other chat's lines, an overlap CONFLICTS and is
//    reported rather than silently clobbering the other chat's work.
//
// Everything here is best-effort from the caller's perspective: a non-git
// folder, a huge repo, or a transient git error degrades to null/empty so the
// live turn is never disturbed.
// ──────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";

import type {
  AgentMessage,
  AgentToolMessage,
} from "@zeros/core/agent-messages";
import { runFile, runGit, assertSafeGitRef } from "./git-exec";
import { authoredPathsFromShellCommand } from "./shell-authored-paths";

// ── Identity for snapshot commits (commit-tree needs an author/committer; we
//    don't want to depend on, or pollute, the user's git config). ──
const SNAPSHOT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Zeros",
  GIT_AUTHOR_EMAIL: "turns@zeros.local",
  GIT_COMMITTER_NAME: "Zeros",
  GIT_COMMITTER_EMAIL: "turns@zeros.local",
};

/** How many reset snapshots to keep per chat (the rest are pruned on the
 *  next reset — their Undo windows are long gone). Each reset pins TWO
 *  snapshots (pre-reset for undo's content, post-reset for undo's merge
 *  base), so 10 refs = the last 5 resets — matching RESET_UNDO_KEEP. */
const RESET_SNAPSHOT_KEEP = 10;

/** Ref stamp for a reset snapshot: ms timestamp first so the lexicographic
 *  prune stays chronological, plus a random suffix so two resets in the same
 *  millisecond (or the pre/post pair of one reset) can never collide. */
function resetStamp(phase: "pre" | "post"): string {
  return `${Date.now()}-${phase}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True when `cwd` is inside a git work tree (a snapshot is possible). */
export async function isGitWorkTree(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--is-inside-work-tree",
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitDir(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--absolute-git-dir"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The worktree's TOP-LEVEL directory, or null when `cwd` isn't inside a work
 *  tree. A chat's folder can be a SUBDIRECTORY of its worktree (a chat opened in
 *  a monorepo package, say — findWorkspaceForFolder tolerates this), but a
 *  whole-tree snapshot has to be rooted at the top: `git add -A` from a subdir
 *  with the empty scratch index would capture only that subdir AND strip its
 *  prefix, and `<rev>:<path>` lookups re-add the cwd prefix — so snapshots,
 *  attribution, and reset must all anchor here, not at the raw folder. */
export async function repoToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Ref naming ───────────────────────────────────────────
//
// chatId / turnId are app ids (uuid-ish), but sanitize defensively so they can
// never break `git check-ref-format` or escape the namespace.
function sanitize(component: string): string {
  const s = component.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[.-]+/, "_");
  return s.length > 0 ? s : "x";
}

export type SnapshotWhich = "pre" | "post";

export function snapshotRef(
  chatId: string,
  turnId: string,
  which: SnapshotWhich,
): string {
  return `refs/zeros/turns/${sanitize(chatId)}/${sanitize(turnId)}__${which}`;
}

function resetRef(chatId: string, stamp: string): string {
  return `refs/zeros/resets/${sanitize(chatId)}/${sanitize(stamp)}`;
}

/** Durable per-workspace archive snapshot ref. Unlike per-turn snapshots
 *  (`refs/zeros/turns/*`, pruned at the retention cap) this is keyed by the
 *  immutable workspace id and lives until the workspace is restored or deleted —
 *  the recovery anchor archive/restore use to bring back uncommitted + untracked
 *  work WITHOUT `git stash` — a ref survives an orphaned worktree gitdir,
 *  a stash does not. Since workspace
 *  ids are `[A-Za-z0-9_-]`, `sanitize` is identity on them, so the ref suffix
 *  round-trips back to the id (the boot janitor relies on this). */
export function archiveSnapshotRef(workspaceId: string): string {
  return `refs/zeros/archive/${sanitize(workspaceId)}`;
}

// ── Snapshot ─────────────────────────────────────────────

/** Capture the whole working tree of `cwd` as a commit pinned at `ref`. Uses a
 *  scratch index so the user's real index is untouched — seeded from HEAD so a
 *  tracked path that is legitimately absent from the worktree (sparse-excluded
 *  by Working folders, or skip-worktree-pinned) is preserved rather than
 *  recorded as a deletion; see the long note inside. `forceAddPaths` is for
 *  explicitly configured, normally-ignored files (for example `.env.local`)
 *  that an archive must preserve without pulling node_modules/all ignored
 *  content into the object store. Returns the commit OID, or null on any
 *  failure / non-git folder (best-effort). */
export async function snapshotWorkingTree(
  cwd: string,
  ref: string,
  opts: { parent?: string; forceAddPaths?: string[] } = {},
): Promise<string | null> {
  try {
    const dir = await gitDir(cwd);
    if (!dir) return null;
    const scratch = nodePath.join(
      dir,
      `zeros-turns-index-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
    );
    const env = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: scratch };
    try {
      // Seed the scratch index from HEAD before staging.
      //
      // `add -A` can only stage what is ON DISK, and an EMPTY seed made that
      // the whole truth — so any tracked path missing from the worktree was
      // silently absent from the snapshot. Two ways that bites:
      //
      //   1. SPARSE-CHECKOUT (Working folders). A deselected folder is removed
      //      from the worktree, so archive captured a tree without it. Restore
      //      then does `read-tree --reset -u <snapshot>` + `reset --mixed HEAD`
      //      — index at HEAD, worktree at the snapshot — and the hidden folder
      //      came back as an uncommitted DELETION of every file in it. Commit
      //      that (or let an agent commit "all changes") and the work is gone
      //      from the branch. Verified end-to-end on git 2.50.
      //   2. A tracked file that also matches .gitignore. From an empty index
      //      it looks untracked, so `add -A` skips it and the snapshot records
      //      it as deleted.
      //
      // Seeding from HEAD fixes both without weakening the snapshot: `add -A`
      // still stages worktree content over it, and still records a GENUINE
      // deletion (the entry is present-in-index, absent-on-disk, and NOT
      // skip-worktree, so git removes it). Only entries git itself considers
      // absent-by-design — the skip-worktree bits sparse-checkout sets — are
      // left alone, which is exactly the intent.
      //
      // Best-effort: an unborn HEAD (`git init`, nothing committed) has no tree
      // to read, and a snapshot there is still valid from an empty index.
      await runGit(cwd, ["read-tree", "HEAD"], { env }).catch(() => undefined);
      // Stage everything (tracked + untracked-not-ignored) into the scratch
      // index, then write it as a tree. `add -A` respects .gitignore, so
      // node_modules/dist/etc. are excluded for free.
      await runGit(cwd, ["add", "-A"], { env });
      const forcedPathspecs: string[] = [];
      for (const candidate of opts.forceAddPaths ?? []) {
        if (!candidate || nodePath.isAbsolute(candidate)) continue;
        const normalized = nodePath.normalize(candidate);
        if (normalized === ".." || normalized.startsWith(`..${nodePath.sep}`)) {
          continue;
        }
        // A configured seed can have been deliberately deleted in this
        // workspace. It has no base-tree entry, so absence is already captured;
        // don't let git's unmatched-pathspec error invalidate the checkpoint.
        try {
          await fs.lstat(nodePath.resolve(cwd, normalized));
        } catch {
          continue;
        }
        const gitPath = normalized.split(nodePath.sep).join("/");
        forcedPathspecs.push(`:(literal)${gitPath}`);
      }
      // Keep argv comfortably below platform limits for broad include files.
      for (let offset = 0; offset < forcedPathspecs.length; offset += 100) {
        await runGit(
          cwd,
          [
            "add",
            "-f",
            "-A",
            "--",
            ...forcedPathspecs.slice(offset, offset + 100),
          ],
          { env },
        );
      }
      const { stdout: treeOut } = await runGit(cwd, ["write-tree"], { env });
      const tree = treeOut.trim();
      if (!tree) return null;
      const commitArgs = ["commit-tree", tree];
      if (opts.parent) {
        assertSafeGitRef(opts.parent, "snapshot parent");
        commitArgs.push("-p", opts.parent);
      }
      commitArgs.push("-m", "zeros turn snapshot");
      const { stdout: commitOut } = await runGit(cwd, commitArgs, { env });
      const commit = commitOut.trim();
      if (!commit) return null;
      await runGit(cwd, ["update-ref", ref, commit]);
      return commit;
    } finally {
      await fs.rm(scratch, { force: true }).catch(() => {});
    }
  } catch {
    return null;
  }
}

/** Best-effort delete of snapshot refs (on reset cleanup / chat delete). */
export async function deleteSnapshotRefs(
  cwd: string,
  chatId: string,
  turnIds: string[],
): Promise<void> {
  for (const turnId of turnIds) {
    for (const which of ["pre", "post"] as SnapshotWhich[]) {
      await runGit(cwd, [
        "update-ref",
        "-d",
        snapshotRef(chatId, turnId, which),
      ]).catch(() => {});
    }
  }
}

// ── Retention / gc ───────────────────────────────────────
//
// Snapshot refs are ref-pinned (gc-safe by design) so they DON'T get pruned by
// `git gc` — which is exactly why we have to prune them ourselves, or a chat's
// hidden commits grow without bound. Three triggers: a chat is deleted (drop all
// its refs), a chat exceeds the per-chat turn cap (drop the oldest turns' refs),
// and a reset creates yet another pre-reset snapshot (keep only the last few).

/** Refs under a path prefix (e.g. `refs/zeros/turns/<chat>/`). Best-effort. */
async function listRefs(cwd: string, prefix: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      prefix,
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Delete EVERY turn + reset snapshot ref belonging to a chat — used when the
 *  chat itself is deleted, so its hidden snapshot commits become gc-able. */
export async function deleteAllChatSnapshotRefs(
  cwd: string,
  chatId: string,
): Promise<void> {
  const c = sanitize(chatId);
  const refs = [
    ...(await listRefs(cwd, `refs/zeros/turns/${c}/`)),
    ...(await listRefs(cwd, `refs/zeros/resets/${c}/`)),
  ];
  for (const ref of refs) {
    await runGit(cwd, ["update-ref", "-d", ref]).catch(() => {});
  }
}

/** Keep only the newest `keep` pre-reset snapshots for a chat; drop older ones
 *  (their Undo windows are long past). The ref name embeds a millisecond stamp,
 *  so a lexicographic sort is chronological for the foreseeable future (13-digit
 *  ms timestamps stay fixed-width until year 2286). Best-effort. */
export async function pruneResetSnapshots(
  cwd: string,
  chatId: string,
  keep: number,
): Promise<void> {
  const refs = await listRefs(cwd, `refs/zeros/resets/${sanitize(chatId)}/`);
  if (refs.length <= keep) return;
  const stale = refs.sort().slice(0, refs.length - keep);
  for (const ref of stale) {
    await runGit(cwd, ["update-ref", "-d", ref]).catch(() => {});
  }
}

// ── Archive snapshot (durable, per-workspace; backs archive/restore) ─────────

/** Delete a workspace's archive snapshot ref (on restore / hard-delete), so its
 *  snapshot commit becomes gc-able. Best-effort. */
export async function deleteArchiveSnapshotRef(
  cwd: string,
  workspaceId: string,
): Promise<void> {
  await runGit(cwd, [
    "update-ref",
    "-d",
    archiveSnapshotRef(workspaceId),
  ]).catch(() => {});
}

/** The workspace ids that currently have an archive snapshot ref in `cwd`'s repo
 *  (ref suffix == id — see archiveSnapshotRef). Best-effort; used by the boot
 *  janitor to drop refs whose workspace row is gone. */
export async function listArchiveSnapshotWorkspaceIds(
  cwd: string,
): Promise<string[]> {
  const prefix = "refs/zeros/archive/";
  return (await listRefs(cwd, prefix))
    .filter((r) => r.startsWith(prefix))
    .map((r) => r.slice(prefix.length))
    .filter((id) => id.length > 0);
}

/** Overlay an archive snapshot's whole tree onto a freshly-recreated worktree so
 *  the uncommitted + untracked work captured at archive comes back as
 *  WORKING-TREE changes (not new commits). Binary-safe — operates on trees, no
 *  patch/merge. Sequence: point index+worktree at the snapshot tree, then reset
 *  the index back to HEAD so the snapshot's delta surfaces exactly as the user
 *  left it (modified / added / deleted / untracked). `cwd` must be the worktree
 *  top, freshly `worktree add`ed and clean. Returns true when applied; false
 *  (best-effort) leaves the worktree at its branch tip — committed work is still
 *  safe. */
export async function restoreWorktreeFromSnapshot(
  cwd: string,
  snapshotCommit: string,
): Promise<boolean> {
  try {
    assertSafeGitRef(snapshotCommit, "archive snapshot");
    // index + worktree → snapshot tree (removes files absent from the snapshot,
    // materializes ones present — including untracked-not-ignored).
    await runGit(cwd, ["read-tree", "--reset", "-u", snapshotCommit]);
    // index → HEAD; --mixed keeps the working tree == snapshot, so the delta
    // shows as uncommitted edits rather than a staged reset of the branch.
    await runGit(cwd, ["reset", "--mixed", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export type ArchiveSnapshotApplyResult =
  | "applied"
  | "conflicted"
  | "unavailable";

/** Materialize `git diff` into a private temporary file, then feed that file to
 * `git apply`. Archive deltas can contain large binary assets, so they must not
 * cross an in-memory subprocess buffer. Sequential native subprocesses also
 * avoid the Bun engine's Node child-process compatibility path and make each
 * child independently observable/killable. */
async function streamArchivePatchToApply(
  cwd: string,
  snapshotCommit: string,
  archivedHead: string,
  applyArgs: string[],
): Promise<boolean> {
  const tmp = await fs.mkdtemp(
    nodePath.join(os.tmpdir(), "zeros-archive-patch-"),
  );
  const patchPath = nodePath.join(tmp, "archive.patch");
  try {
    await runGit(
      cwd,
      [
        "diff",
        "--binary",
        "--full-index",
        `--output=${patchPath}`,
        archivedHead,
        snapshotCommit,
        "--",
      ],
      { maxBufferBytes: 1024 * 1024 },
    );
    await runGit(cwd, ["apply", ...applyArgs, patchPath], {
      maxBufferBytes: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reapply only the archive-time working-tree delta onto the branch's CURRENT
 * tip. A branch can advance while archived (or be checked out/committed in
 * another worktree); replacing the whole tree would turn those newer committed
 * files into apparent deletions. `git apply --3way` preserves non-overlapping
 * advances and leaves genuine overlaps as ordinary unmerged paths for the UI.
 *
 * A process can die after `git apply` succeeds but before the lifecycle phase
 * is persisted. Reverse-checking the patch makes that retry idempotent. A
 * non-conflict failure never reset/cleans the checkout: by then it can contain
 * the prior successful apply or an external writer's files, neither of which
 * is ours to destroy. */
export async function applyArchiveSnapshotOntoCurrent(
  cwd: string,
  snapshotCommit: string,
  archivedHead: string,
): Promise<ArchiveSnapshotApplyResult> {
  try {
    assertSafeGitRef(snapshotCommit, "archive snapshot");
    assertSafeGitRef(archivedHead, "archive base");
    if (await treesIdentical(cwd, archivedHead, snapshotCommit)) {
      return "applied";
    }
    const alreadyApplied = async (): Promise<boolean> => {
      try {
        return await streamArchivePatchToApply(
          cwd,
          snapshotCommit,
          archivedHead,
          ["--reverse", "--check", "--whitespace=nowarn"],
        );
      } catch {
        return false;
      }
    };
    const { stdout: existingUnmerged } = await runGit(cwd, [
      "ls-files",
      "-u",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    if (existingUnmerged.trim()) return "conflicted";
    if (await alreadyApplied()) {
      // A crash can land after `git apply --index` but before the normal reset
      // below. Retrying must restore archive's public contract: recovered WIP
      // is present but unstaged, never silently left in the index.
      await runGit(cwd, ["reset", "--mixed", "HEAD"]);
      return "applied";
    }
    try {
      const applied = await streamArchivePatchToApply(
        cwd,
        snapshotCommit,
        archivedHead,
        ["--3way", "--index", "--whitespace=nowarn"],
      );
      if (!applied) throw new Error("git apply rejected the archive patch");
    } catch {
      const { stdout: unmerged } = await runGit(cwd, ["ls-files", "-u"]).catch(
        () => ({ stdout: "", stderr: "" }),
      );
      if (unmerged.trim()) return "conflicted";
      if (await alreadyApplied()) {
        await runGit(cwd, ["reset", "--mixed", "HEAD"]);
        return "applied";
      }
      return "unavailable";
    }
    // Keep restored WIP as working-tree changes, matching the old archive
    // contract (archive/restore never silently stages everything).
    await runGit(cwd, ["reset", "--mixed", "HEAD"]);
    return "applied";
  } catch {
    return "unavailable";
  }
}

/** True when two commits point at the SAME tree — i.e. the span between them
 *  changed nothing on disk. Lets finishTurn distinguish a provably no-op turn
 *  (safe to drop its checkpoint refs immediately) from a turn whose tree DID
 *  change but whose files escaped attribution (keep the refs as a recovery
 *  net; retention prunes them later). Returns false on any error — the
 *  conservative direction (refs are kept). */
export async function treesIdentical(
  cwd: string,
  commitA: string,
  commitB: string,
): Promise<boolean> {
  try {
    assertSafeGitRef(commitA, "tree compare");
    assertSafeGitRef(commitB, "tree compare");
    const a = await runGit(cwd, ["rev-parse", `${commitA}^{tree}`]);
    const b = await runGit(cwd, ["rev-parse", `${commitB}^{tree}`]);
    const ta = a.stdout.trim();
    const tb = b.stdout.trim();
    return ta.length > 0 && ta === tb;
  } catch {
    return false;
  }
}

// ── Blob / content helpers ───────────────────────────────

/** The blob OID of `path` in commit/tree `rev`, or null when the path is absent
 *  there. OID compares let us decide "unchanged since" without reading bytes —
 *  binary-safe. */
export async function blobOid(
  cwd: string,
  rev: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", `${rev}:${path}`]);
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** The blob OID of `path`'s stage-0 INDEX entry, or null when the path isn't in
 *  the index. Used to decide whether a reset must also sync the staged copy:
 *  when the index holds exactly the blob being reverted away from, leaving it
 *  would let a later commit resurrect the reverted change. */
async function indexBlobOid(cwd: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", `:0:${path}`]);
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** The OID the on-disk file at `path` (relative to `cwd`) would hash to, or null
 *  when it doesn't exist on disk. */
async function diskBlobOid(cwd: string, path: string): Promise<string | null> {
  const abs = nodePath.resolve(cwd, path);
  try {
    await fs.access(abs);
  } catch {
    return null;
  }
  try {
    const { stdout } = await runGit(cwd, ["hash-object", "--", abs]);
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/** Text content of `path` in `rev`, or null if absent. `isBinary` flags a NUL
 *  byte (we won't 3-way-merge binary). */
async function showText(
  cwd: string,
  rev: string,
  path: string,
): Promise<{ text: string; isBinary: boolean } | null> {
  try {
    const { stdout } = await runGit(cwd, ["show", `${rev}:${path}`], {
      maxBufferBytes: 64 * 1024 * 1024,
    });
    return { text: stdout, isBinary: stdout.includes("\0") };
  } catch {
    return null;
  }
}

async function readDiskText(
  cwd: string,
  path: string,
): Promise<{ text: string; isBinary: boolean } | null> {
  try {
    const buf = await fs.readFile(nodePath.resolve(cwd, path));
    const text = buf.toString("utf8");
    return { text, isBinary: buf.includes(0) };
  } catch {
    return null;
  }
}

// ── Per-turn authored diff (for pills + file viewer) ─────

export interface TurnFileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

function parseZList(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

/** Status + ±counts for `paths` between two snapshots, restricting to the
 *  authored paths so a concurrent chat's edits to OTHER files never appear. */
export async function turnFileDiffs(
  cwd: string,
  pre: string,
  post: string,
  paths: string[],
): Promise<TurnFileDiff[]> {
  if (paths.length === 0) return [];
  const pathArgs = ["--", ...paths];
  // name-status: A/M/D/R<score>. -z makes rename emit old\0new.
  const statusByPath = new Map<
    string,
    { status: TurnFileDiff["status"]; oldPath?: string }
  >();
  try {
    const { stdout } = await runGit(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      pre,
      post,
      ...pathArgs,
    ]);
    const toks = parseZList(stdout);
    for (let i = 0; i < toks.length; ) {
      const code = toks[i] ?? "";
      const letter = code[0];
      if (letter === "A") {
        statusByPath.set(toks[i + 1], { status: "added" });
        i += 2;
      } else if (letter === "D") {
        statusByPath.set(toks[i + 1], { status: "deleted" });
        i += 2;
      } else {
        statusByPath.set(toks[i + 1], { status: "modified" });
        i += 2;
      }
    }
  } catch {
    /* fall through to numstat-only */
  }
  const out: TurnFileDiff[] = [];
  try {
    const { stdout } = await runGit(cwd, [
      "diff",
      "--numstat",
      "-z",
      "--no-renames",
      pre,
      post,
      ...pathArgs,
    ]);
    // numstat -z: "adds\tdels\tpath\0" per file (binary => "-\t-").
    const toks = parseZList(stdout);
    for (const tok of toks) {
      const m = tok.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
      if (!m) continue;
      const path = m[3];
      const additions = m[1] === "-" ? 0 : parseInt(m[1], 10);
      const deletions = m[2] === "-" ? 0 : parseInt(m[2], 10);
      const meta = statusByPath.get(path);
      out.push({
        path,
        status: meta?.status ?? "modified",
        oldPath: meta?.oldPath,
        additions,
        deletions,
      });
    }
  } catch {
    /* leave out empty */
  }
  return out;
}

/** A unified patch for the authored paths between two snapshots (feeds the file
 *  viewer's per-turn diff). */
export async function turnPatch(
  cwd: string,
  pre: string,
  post: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) return "";
  try {
    const { stdout } = await runGit(
      cwd,
      ["diff", "--no-color", "-U3", pre, post, "--", ...paths],
      { maxBufferBytes: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return "";
  }
}

// ── Attribution (tool calls → authored paths) ────────────

export interface AuthoredPath {
  path: string;
  kind: "edit" | "delete" | "renamed";
}

/** Resolve a tool's reported path (relative to the agent cwd `fromDir`, or
 *  absolute) and express it relative to the worktree `root` — the frame every
 *  snapshot/diff/reset uses. When `fromDir === root` (the chat folder IS the
 *  worktree top, the common case) this is the old single-cwd behavior. */
function relTo(fromDir: string, root: string, raw: string): string | null {
  if (!raw) return null;
  const abs = nodePath.isAbsolute(raw) ? raw : nodePath.resolve(fromDir, raw);
  const rel = nodePath.relative(root, abs);
  // Reject paths that escape the work tree (defensive — never restore outside).
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
  return rel.split(nodePath.sep).join("/");
}

export function pathsFromTool(
  fromDir: string,
  root: string,
  t: AgentToolMessage,
): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== "string" || !raw) return;
    const rel = relTo(fromDir, root, raw);
    if (rel && !out.includes(rel)) out.push(rel);
  };
  // Priority 1: ACP `locations` (most reliable, cross-adapter).
  const locs = t.locations as Array<{ path?: string }> | undefined;
  if (Array.isArray(locs)) for (const l of locs) push(l?.path);
  // Priority 2: common rawInput shapes across Claude / Codex / Cursor tools.
  const ri = t.rawInput as Record<string, unknown> | undefined;
  if (ri && typeof ri === "object") {
    const keys = [
      "file_path",
      "filePath",
      "path",
      "abs_path",
      "absolute_path",
      "notebook_path",
      "target_file",
      "new_path",
      "old_path",
    ];
    for (const k of keys) push(ri[k]);
    // Codex's `fileChange` tool nests one-or-MORE paths under
    // `rawInput.changes: [{ path }]` (app-server-translator toolInput) and sets
    // no scalar key / no `locations` — so without this branch a Codex edit
    // attributes to NOTHING and the turn records 0 files. Cursor's apply-diff
    // shapes that surface an `edits`/`files` array land here too.
    for (const key of ["changes", "edits", "files"] as const) {
      const arr = ri[key];
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c && typeof c === "object") {
            const rec = c as Record<string, unknown>;
            push(rec.path ?? rec.file_path ?? rec.filePath ?? rec.new_path);
          } else {
            push(c);
          }
        }
      }
    }
  }
  return out;
}

/** The set of files THIS turn's agent edited/deleted/renamed, from its own tool
 *  calls. Concurrency-immune (another chat's tool calls are in another session's
 *  message stream). Dedupes by path, last-writer-wins on kind. A single tool
 *  call may touch several files (e.g. Codex's multi-file patch), so each path it
 *  names is attributed. */
export function authoredPathsFromMessages(
  messages: AgentMessage[],
  fromDir: string,
  root: string = fromDir,
): AuthoredPath[] {
  const byPath = new Map<string, AuthoredPath["kind"]>();
  for (const m of messages) {
    if (m.kind !== "tool") continue;
    const t = m as AgentToolMessage;
    // A tool that never progressed past pending didn't change anything.
    if (t.status === "pending") continue;
    const kindRaw = (t.toolKind ?? "").toLowerCase();
    // Shell mutations (notably `rm`) arrive as generic execute tools rather
    // than file tools. Recover only paths explicitly named by known mutating
    // commands/redirections; finishTurn intersects them with the real snapshot
    // diff, so denied and no-op commands still produce no recorded file.
    if (kindRaw === "execute" || kindRaw === "bash" || kindRaw === "shell") {
      const input =
        t.rawInput && typeof t.rawInput === "object"
          ? (t.rawInput as Record<string, unknown>)
          : null;
      const command = input?.command;
      if (typeof command === "string") {
        for (const authored of authoredPathsFromShellCommand(
          command,
          fromDir,
          root,
          input?.cwd,
        )) {
          byPath.set(authored.path, authored.kind);
        }
      }
      continue;
    }
    // File-native tools are atomic from the adapter's perspective. A failed
    // Write/Edit/Delete is a denial or rejected operation, not authorship. Drop
    // it before path attribution so an unrelated external edit to the same path
    // during the prompt cannot be mistaken for the denied proposal. (Failed
    // shell commands stay above: a shell may mutate before exiting non-zero.)
    if (t.status === "failed") continue;
    let kind: AuthoredPath["kind"] | null = null;
    if (kindRaw === "edit" || kindRaw === "write") kind = "edit";
    else if (kindRaw === "delete") kind = "delete";
    else if (kindRaw === "move" || kindRaw === "rename") kind = "renamed";
    if (!kind) continue;
    for (const path of pathsFromTool(fromDir, root, t)) byPath.set(path, kind);
  }
  return [...byPath.entries()].map(([path, kind]) => ({ path, kind }));
}

// ── 3-way merge (text only) ──────────────────────────────

async function runRaw(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await runFile("git", args, {
      cwd,
      maxBufferBytes: 64 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (error) {
    const details = error as { code?: unknown; stdout?: unknown };
    return {
      code: typeof details.code === "number" ? details.code : 1,
      stdout: typeof details.stdout === "string" ? details.stdout : "",
    };
  }
}

/** 3-way merge three text buffers. `base` is the common ancestor (what this chat
 *  last wrote), `ours` the current disk content, `theirs` the target (pre-turn).
 *  Returns the merged text and whether it conflicted. Implemented via
 *  `git merge-file -p` (writes to stdout, never touches the tree; exit code = #
 *  conflicts). */
async function mergeText(
  cwd: string,
  ours: string,
  base: string,
  theirs: string,
): Promise<{ merged: string; conflict: boolean }> {
  const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "zeros-merge-"));
  try {
    const o = nodePath.join(tmp, "ours");
    const b = nodePath.join(tmp, "base");
    const t = nodePath.join(tmp, "theirs");
    await fs.writeFile(o, ours);
    await fs.writeFile(b, base);
    await fs.writeFile(t, theirs);
    const { code, stdout } = await runRaw(
      ["merge-file", "-p", "-q", o, b, t],
      cwd,
    );
    return { merged: stdout, conflict: code > 0 };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Reset (per-path restore) ─────────────────────────────

export interface ResetFileOutcome {
  path: string;
  result: "restored" | "deleted" | "merged" | "conflict" | "skipped";
  reason?: string;
}

/** Restore one authored path toward its pre-turn state.
 *   - `target` = state before the reverted span (turn T's pre snapshot).
 *   - `base`   = what this chat last wrote (its latest turn's post snapshot).
 *   - current  = on-disk now.
 *  Fast path (current === base, by OID): nobody changed it since → set it to
 *  target exactly (binary-safe). Diverged: 3-way text merge (conflict reported,
 *  never silently overwrites the other chat's lines). */
async function resetPath(
  cwd: string,
  path: string,
  targetCommit: string | null,
  baseCommit: string | null,
): Promise<ResetFileOutcome> {
  if (!targetCommit || !baseCommit) {
    return { path, result: "skipped", reason: "no snapshot available" };
  }
  const targetOid = await blobOid(cwd, targetCommit, path);
  const baseOid = await blobOid(cwd, baseCommit, path);
  const currentOid = await diskBlobOid(cwd, path);

  // Fast path: file is exactly as this chat last left it → no concurrent edit.
  if (currentOid === baseOid) {
    // If the INDEX also holds the exact blob being reverted (the agent's edit
    // was staged verbatim), sync it too — a worktree-only restore would leave
    // the reverted content staged, and a later commit would resurrect it. Any
    // OTHER staged content (the user's own partial staging) is left alone.
    const stagedSameBlob =
      currentOid != null && (await indexBlobOid(cwd, path)) === currentOid;
    if (targetOid) {
      await runGit(cwd, [
        "restore",
        `--source=${targetCommit}`,
        ...(stagedSameBlob ? ["--staged"] : []),
        "--worktree",
        "--",
        path,
      ]);
      return { path, result: "restored" };
    }
    // Target absent → the file didn't exist before the span → remove it (and
    // its staged copy, when that copy is the reverted blob).
    if (currentOid) {
      if (stagedSameBlob) {
        await runGit(cwd, ["update-index", "--force-remove", "--", path]).catch(
          () => {},
        );
      }
      await fs.rm(nodePath.resolve(cwd, path), { force: true }).catch(() => {});
      return { path, result: "deleted" };
    }
    return { path, result: "skipped", reason: "nothing to do" };
  }

  // Diverged (a concurrent chat or manual edit changed it) → 3-way merge.
  const cur = await readDiskText(cwd, path);
  const base = baseOid
    ? await showText(cwd, baseCommit, path)
    : { text: "", isBinary: false };
  const tgt = targetOid
    ? await showText(cwd, targetCommit, path)
    : { text: "", isBinary: false };
  if (!cur || cur.isBinary || base?.isBinary || tgt?.isBinary) {
    return {
      path,
      result: "conflict",
      reason: "binary or unreadable; not auto-merged",
    };
  }
  const { merged, conflict } = await mergeText(
    cwd,
    cur.text,
    base?.text ?? "",
    tgt?.text ?? "",
  );
  if (conflict) {
    return { path, result: "conflict", reason: "overlapping concurrent edit" };
  }
  await fs.writeFile(nodePath.resolve(cwd, path), merged);
  return { path, result: "merged" };
}

export interface TurnResetResult {
  /** Files actually changed on disk (restored / merged / deleted). */
  applied: ResetFileOutcome[];
  /** Files a concurrent/overlapping edit blocked — left as-is, not clobbered. */
  conflicts: ResetFileOutcome[];
  /** Files we could NOT restore (no snapshot available, binary, unreadable).
   *  Surfaced separately so the caller can warn instead of pretending the reset
   *  fully applied — otherwise a snapshot-less reset silently rolls back only
   *  the transcript while files stay put. */
  skipped: ResetFileOutcome[];
  preResetSnapshot: string | null;
  /** Whole-tree state right AFTER the reset applied — undo's merge base. Undo
   *  compares disk against this to detect (and 3-way merge around) edits made
   *  between the reset and the undo, instead of blindly overwriting them. */
  postResetSnapshot: string | null;
}

/** Restore `paths` to their pre-turn state (target = `targetCommit`), using
 *  `baseCommit` (this chat's latest post snapshot) as the merge ancestor. Takes
 *  a snapshot-before-reset escape hatch first. */
export async function applyTurnReset(
  cwd: string,
  chatId: string,
  paths: string[],
  targetCommit: string | null,
  baseCommit: string | null,
): Promise<TurnResetResult> {
  // Escape hatch: snapshot the current tree so the reset itself is undoable.
  const preResetSnapshot = await snapshotWorkingTree(
    cwd,
    resetRef(chatId, resetStamp("pre")),
  );
  // Cap the chat's reset snapshots — this one is the newest, so it survives.
  await pruneResetSnapshots(cwd, chatId, RESET_SNAPSHOT_KEEP).catch(() => {});
  const outcomes: ResetFileOutcome[] = [];
  for (const path of paths) {
    try {
      outcomes.push(await resetPath(cwd, path, targetCommit, baseCommit));
    } catch (err) {
      outcomes.push({
        path,
        result: "skipped",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const postResetSnapshot = await snapshotWorkingTree(
    cwd,
    resetRef(chatId, resetStamp("post")),
  );
  return {
    applied: outcomes.filter(
      (o) =>
        o.result === "restored" ||
        o.result === "merged" ||
        o.result === "deleted",
    ),
    conflicts: outcomes.filter((o) => o.result === "conflict"),
    skipped: outcomes.filter((o) => o.result === "skipped"),
    preResetSnapshot,
    postResetSnapshot,
  };
}

export interface TurnResetStep {
  /** Authored paths for exactly one turn. */
  paths: string[];
  /** Whole-tree state immediately before/after that same turn. */
  preSnapshot: string | null;
  postSnapshot: string | null;
}

/**
 * Reset a span of turns without using a later unrelated whole-tree snapshot as
 * every file's merge base. Steps are supplied oldest-first and unwound newest-
 * first. This matters when another agent edits the same file between two turns:
 * each inverse uses only the pre/post pair for the turn that actually authored
 * that path, preserving the interleaved edit wherever a 3-way merge can.
 *
 * A path with any pruned/missing snapshot is pre-blocked before mutation, so a
 * long reset never half-reverts that path and then discovers it cannot finish.
 */
export async function applyTurnSpanReset(
  cwd: string,
  chatId: string,
  steps: TurnResetStep[],
): Promise<TurnResetResult> {
  const preResetSnapshot = await snapshotWorkingTree(
    cwd,
    resetRef(chatId, resetStamp("pre")),
  );
  await pruneResetSnapshots(cwd, chatId, RESET_SNAPSHOT_KEEP).catch(() => {});

  const orderedPaths = [...new Set(steps.flatMap((step) => step.paths))];
  if (!preResetSnapshot && orderedPaths.length > 0) {
    return {
      applied: [],
      conflicts: [],
      skipped: orderedPaths.map((path) => ({
        path,
        result: "skipped" as const,
        reason: "could not create pre-reset safety snapshot",
      })),
      preResetSnapshot: null,
      postResetSnapshot: null,
    };
  }
  const outcomes = new Map<string, ResetFileOutcome>();
  const blocked = new Set<string>();
  const touched = new Set<string>();

  // Validate the whole per-path chain before changing disk. Snapshot retention
  // may have pruned an old turn; in that case leave the path untouched.
  for (const step of steps) {
    if (step.preSnapshot && step.postSnapshot) continue;
    for (const path of step.paths) {
      blocked.add(path);
      outcomes.set(path, {
        path,
        result: "skipped",
        reason: "no snapshot available",
      });
    }
  }

  for (const step of [...steps].reverse()) {
    for (const path of new Set(step.paths)) {
      if (blocked.has(path)) continue;
      let outcome: ResetFileOutcome;
      try {
        outcome = await resetPath(
          cwd,
          path,
          step.preSnapshot,
          step.postSnapshot,
        );
      } catch (err) {
        outcome = {
          path,
          result: "skipped",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
      outcomes.set(path, outcome);
      // Once an inverse cannot be applied safely, earlier inverses for the same
      // path no longer have a trustworthy current state. If a newer inverse for
      // this path already landed, restore the pre-reset escape snapshot first —
      // a conflict must never leave a file only half-reset.
      if (outcome.result === "conflict" || outcome.result === "skipped") {
        if (touched.has(path) && preResetSnapshot) {
          const [rollback] = await undoTurnReset(cwd, preResetSnapshot, [path]);
          if (rollback?.result === "skipped") {
            outcome = {
              path,
              result: "skipped",
              reason: `reset conflicted and rollback failed: ${rollback.reason ?? "unknown error"}`,
            };
            outcomes.set(path, outcome);
          }
        }
        touched.delete(path);
        blocked.add(path);
      } else {
        touched.add(path);
      }
    }
  }

  const final = orderedPaths.map(
    (path) =>
      outcomes.get(path) ?? {
        path,
        result: "skipped" as const,
        reason: "nothing to do",
      },
  );
  // Capture the tree the reset LEFT — undo's merge base (see TurnResetResult).
  const postResetSnapshot = await snapshotWorkingTree(
    cwd,
    resetRef(chatId, resetStamp("post")),
  );
  return {
    applied: final.filter(
      (o) =>
        o.result === "restored" ||
        o.result === "merged" ||
        o.result === "deleted",
    ),
    conflicts: final.filter((o) => o.result === "conflict"),
    skipped: final.filter((o) => o.result === "skipped"),
    preResetSnapshot,
    postResetSnapshot,
  };
}

/** Undo a prior reset: restore `paths` from the pre-reset snapshot (best-effort,
 *  binary-safe). Files only — the truncated transcript is not restored.
 *
 *  `mergeBase` is the post-reset snapshot (the tree the reset LEFT). When
 *  present, undo gets the same never-clobber rule as reset itself: a path the
 *  user (or another chat) edited AFTER the reset is 3-way merged — an
 *  overlapping edit conflicts and is left as-is instead of being silently
 *  overwritten. Without it (legacy undo records, or the mid-reset rollback
 *  where forcing back to the escape snapshot is exactly the point) the
 *  original blind restore applies. */
export async function undoTurnReset(
  cwd: string,
  snapshot: string,
  paths: string[],
  mergeBase?: string | null,
): Promise<ResetFileOutcome[]> {
  if (mergeBase) {
    const out: ResetFileOutcome[] = [];
    for (const path of paths) {
      try {
        // target = pre-reset state (what undo restores toward); base = what the
        // reset left on disk. Undisturbed paths take resetPath's exact fast
        // path; diverged ones merge, overlaps conflict.
        out.push(await resetPath(cwd, path, snapshot, mergeBase));
      } catch (err) {
        out.push({
          path,
          result: "skipped",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }
  const out: ResetFileOutcome[] = [];
  for (const path of paths) {
    try {
      const oid = await blobOid(cwd, snapshot, path);
      if (oid) {
        await runGit(cwd, [
          "restore",
          `--source=${snapshot}`,
          "--worktree",
          "--",
          path,
        ]);
        out.push({ path, result: "restored" });
      } else {
        await fs
          .rm(nodePath.resolve(cwd, path), { force: true })
          .catch(() => {});
        out.push({ path, result: "deleted" });
      }
    } catch (err) {
      out.push({
        path,
        result: "skipped",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

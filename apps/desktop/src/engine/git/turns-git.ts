// ──────────────────────────────────────────────────────────
// Per-turn git plumbing — snapshots, attribution, per-turn diff, reset
// ──────────────────────────────────────────────────────────
//
// Backs the "turns + reset to this point" feature. The design decisions this
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

import { applyTurnReset as applySharedTurnReset, applyTurnSpanReset as applySharedTurnSpanReset,
  undoTurnReset as undoSharedTurnReset, type TurnResetHost, type TurnResetStep } from "@zeros/protocol/turns";
export type { ResetFileOutcome, TurnResetResult, TurnResetStep } from "@zeros/protocol/turns";

import { constants, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { openLocalFile, openLocalDirectory } from "../local-orchestration/filesystem";
import { openBoundedDirectorySync } from "../files/bounded-read-sync";
import { createGitTemporaryDirectory, writeGitTemporaryFile } from "./git-temporary";
import * as os from "node:os";
import * as nodePath from "node:path";

import { runFile, runGit, assertSafeGitRef } from "./git-exec";
import { prepareSnapshotIndex } from "./snapshot-index";

// ── Identity for snapshot commits (commit-tree needs an author/committer; we
//    don't want to depend on, or pollute, the user's git config). ──
export const SNAPSHOT_ENV: Record<string, string> = {
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

export interface SnapshotTimings {
  seedMs: number;
  stageMs: number;
  forceAddMs: number;
  writeMs: number;
  reusedIndex: boolean;
}

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
  opts: {
    parent?: string;
    forceAddPaths?: string[];
    excludePaths?: string[];
    onTiming?: (timings: SnapshotTimings) => void;
  } = {},
): Promise<string | null> {
  const timings: SnapshotTimings = {
    seedMs: 0,
    stageMs: 0,
    forceAddMs: 0,
    writeMs: 0,
    reusedIndex: false,
  };
  const seedStartedAt = Date.now();
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
      const indexCache = await prepareSnapshotIndex(cwd, dir, scratch, opts);
      timings.reusedIndex = indexCache.reused;
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
      // An exact rule/HEAD match can retain the entire prior snapshot index.
      // Otherwise reset to HEAD, retaining only unchanged committed entries.
      // The final add always discovers and verifies current disk state.
      try {
        await runGit(cwd, ["read-tree", "--reset", indexCache.tree ?? "HEAD"], {
          env,
        });
      } catch {
        await fs.rm(scratch, { force: true });
        // The cached tree may have been pruned with its ref. Rebuild from the
        // live branch; an unborn HEAD retains the original empty-index path.
        await runGit(cwd, ["read-tree", "HEAD"], { env }).catch(
          () => undefined,
        );
      }
      timings.seedMs = Date.now() - seedStartedAt;
      // Stage everything (tracked + untracked-not-ignored) into the scratch
      // index, then write it as a tree. `add -A` respects .gitignore, so
      // node_modules/dist/etc. are excluded for free.
      const stageStartedAt = Date.now();
      await runGit(cwd, ["add", "-A"], { env });
      timings.stageMs = Date.now() - stageStartedAt;
      const forceStartedAt = Date.now();
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
      for (const candidate of opts.excludePaths ?? []) {
        const normalized = nodePath.normalize(candidate);
        if (
          !candidate ||
          nodePath.isAbsolute(normalized) ||
          normalized === ".." ||
          normalized.startsWith(`..${nodePath.sep}`)
        )
          continue;
        await runGit(
          cwd,
          ["update-index", "--force-remove", "--", normalized],
          { env },
        );
      }
      timings.forceAddMs = Date.now() - forceStartedAt;
      const writeStartedAt = Date.now();
      await indexCache.validate();
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
      // A failed publication never becomes the source of another snapshot.
      // Cache allocation is optional; the durable ref already owns the tree.
      await indexCache.publish(tree).catch(() => {});
      timings.writeMs = Date.now() - writeStartedAt;
      return commit;
    } finally {
      await fs.rm(scratch, { force: true }).catch(() => {});
    }
  } catch {
    return null;
  } finally {
    opts.onTiming?.(timings);
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

/** Delete a workspace's archive snapshot ref (on explicit deletion), so its
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
 *  (ref suffix == id — see archiveSnapshotRef). Best-effort diagnostics;
 *  an unknown id can belong to another instance's database. */
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
  const tmp = await createGitTemporaryDirectory(
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
/** Resolve a turn's abbreviated commit candidates to the full SHAs of commits
 *  that exist in this repository, in order. One `cat-file` reads them all; an
 *  unknown or ambiguous candidate, or a read failure, records nothing. */
export async function resolveTurnCommits(
  cwd: string,
  candidates: string[],
): Promise<string[]> {
  const valid = candidates.filter((sha) => /^[0-9a-f]{7,64}$/.test(sha));
  if (valid.length === 0) return [];
  try {
    const { stdout } = await runGit(
      cwd,
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
      { input: valid.map((sha) => `${sha}^{commit}\n`).join(""), readOnly: true, timeoutMs: 10_000 },
    );
    const out: string[] = [];
    for (const line of stdout.split("\n")) {
      const [sha, type] = line.trim().split(" ");
      if (type === "commit" && sha && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) && !out.includes(sha)) out.push(sha);
    }
    return out;
  } catch {
    return [];
  }
}

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
  const contents = await readTurnFile(cwd, path);
  if (!contents) return null;
  {
    const { stdout } = await runGit(cwd, ["hash-object", `--path=${path}`, "--stdin"], { input: contents });
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  }
}

function turnPath(cwd: string, relative: string): string {
  const root = nodePath.resolve(cwd), target = nodePath.resolve(root, relative);
  if (target === root || !target.startsWith(root + nodePath.sep) || nodePath.relative(root, target).split(nodePath.sep).includes(".git"))
    throw new Error("Turn reset path is outside the workspace.");
  return target;
}

async function readTurnFile(cwd: string, path: string): Promise<Buffer | null> {
  let handle: fs.FileHandle;
  try { handle = await openLocalFile(turnPath(cwd, path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Turn file is not a bounded regular file.");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    const after = await handle.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Error("The file changed during turn reset.");
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

/** Stage Git's binary-safe checkout outside the working tree; all publication
 * and deletion effects use the pinned destination directory. */
async function restoreTurnPath(cwd: string, path: string, revision: string | null, expectedOid?: string | null): Promise<void> {
  const target = turnPath(cwd, path);
  openBoundedDirectorySync(nodePath.dirname(target), true).close();
  const directory = await openLocalDirectory(nodePath.dirname(target));
  const destination = nodePath.join(directory.path, nodePath.basename(target));
  const temporary = `${destination}.${randomUUID()}.reset`;
  let scratch: string | undefined;
  try {
    if (revision) {
      scratch = await createGitTemporaryDirectory(nodePath.join(os.tmpdir(), "zeros-turn-restore-"));
      const env = { GIT_INDEX_FILE: nodePath.join(scratch, "index") };
      const checkout = nodePath.join(scratch, "worktree");
      await fs.mkdir(checkout);
      await runGit(cwd, ["read-tree", revision], { env });
      await runGit(cwd, ["checkout-index", `--prefix=${checkout}${nodePath.sep}`, "--", path], { env });
      const source = nodePath.join(checkout, path);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), temporary);
      else if (stat.isFile()) await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
      else throw new Error("Unsupported turn file type.");
    }
    if (expectedOid !== undefined && await diskBlobOid(cwd, path) !== expectedOid)
      throw new Error("The file changed during turn reset; retry after reviewing it.");
    if (!revision) await fs.unlink(destination).catch(error => { if (error.code !== "ENOENT") throw error; });
    else if (expectedOid === null) { await fs.link(temporary, destination); await fs.unlink(temporary); }
    else await fs.rename(temporary, destination);
  } finally {
    await fs.unlink(temporary).catch(() => {});
    await directory.handle.close();
    if (scratch) await fs.rm(scratch, { recursive: true, force: true });
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
    const buf = await readTurnFile(cwd, path);
    if (!buf) return null;
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

export { pathsFromTool, authoredPathsFromMessages, commitShasFromMessages, type AuthoredPath } from "@zeros/protocol/turn-attribution";

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
  const tmp = await createGitTemporaryDirectory(nodePath.join(os.tmpdir(), "zeros-merge-"));
  try {
    const o = nodePath.join(tmp, "ours");
    const b = nodePath.join(tmp, "base");
    const t = nodePath.join(tmp, "theirs");
    await writeGitTemporaryFile(o, ours);
    await writeGitTemporaryFile(b, base);
    await writeGitTemporaryFile(t, theirs);
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

function resetHost(cwd: string, chatId: string): TurnResetHost {
  const available = new Map<string, Promise<boolean>>();
  return {
    snapshotAvailable: revision => {
      let checking = available.get(revision);
      if (!checking) { checking = runGit(cwd, ["cat-file", "-e", `${revision}^{tree}`]).then(() => true, () => false); available.set(revision, checking); }
      return checking;
    },
    blobOid: (revision, path) => blobOid(cwd, revision, path),
    diskBlobOid: path => diskBlobOid(cwd, path),
    indexBlobOid: path => indexBlobOid(cwd, path),
    restore: (path, revision, expected) => restoreTurnPath(cwd, path, revision, expected),
    restoreIndex: (path, revision) => runGit(cwd, ["restore", `--source=${revision}`, "--staged", "--", path]),
    removeIndex: path => runGit(cwd, ["update-index", "--force-remove", "--", path]),
    readDiskText: path => readDiskText(cwd, path),
    showText: (revision, path) => showText(cwd, revision, path),
    mergeText: (ours, base, theirs) => mergeText(cwd, ours, base, theirs),
    publishMerge: async (path, merged, expected) => {
      const target = turnPath(cwd, path);
      const directory = await openLocalDirectory(nodePath.dirname(target));
      const pinned = nodePath.join(directory.path, nodePath.basename(target));
      const temporary = `${pinned}.${randomUUID()}.merge`;
      try {
        const previous = await fs.lstat(pinned);
        await fs.writeFile(temporary, merged, { flag: "wx", mode: previous.mode & 0o777 });
        const latest = await readDiskText(cwd, path);
        if (!latest || latest.text !== expected) return false;
        await fs.rename(temporary, pinned);
      } finally {
        await fs.unlink(temporary).catch(() => {});
        await directory.handle.close();
      }
      return true;
    },
    snapshot: phase => snapshotWorkingTree(cwd, resetRef(chatId, resetStamp(phase))),
    prune: () => pruneResetSnapshots(cwd, chatId, RESET_SNAPSHOT_KEEP),
  };
}

export function applyTurnReset(cwd: string, chatId: string, paths: string[], targetCommit: string | null, baseCommit: string | null) {
  return applySharedTurnReset(resetHost(cwd, chatId), paths, targetCommit, baseCommit);
}

export function applyTurnSpanReset(cwd: string, chatId: string, steps: TurnResetStep[]) {
  return applySharedTurnSpanReset(resetHost(cwd, chatId), steps);
}

export function undoTurnReset(cwd: string, snapshot: string, paths: string[], mergeBase?: string | null) {
  return undoSharedTurnReset(resetHost(cwd, ""), snapshot, paths, mergeBase);
}

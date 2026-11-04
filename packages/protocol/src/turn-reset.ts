export interface TurnResetHost {
  snapshotAvailable(revision: string): Promise<boolean>;
  blobOid(revision: string, path: string): Promise<string | null>;
  diskBlobOid(path: string): Promise<string | null>;
  indexBlobOid(path: string): Promise<string | null>;
  restore(path: string, revision: string | null, expectedOid?: string | null): Promise<void>;
  restoreIndex(path: string, revision: string): Promise<unknown>;
  removeIndex(path: string): Promise<unknown>;
  readDiskText(path: string): Promise<{ text: string; isBinary: boolean } | null>;
  showText(revision: string, path: string): Promise<{ text: string; isBinary: boolean } | null>;
  mergeText(ours: string, base: string, theirs: string): Promise<{ merged: string; conflict: boolean }>;
  publishMerge(path: string, merged: string, expected: string): Promise<boolean>;
  snapshot(phase: "pre" | "post"): Promise<string | null>;
  prune(): Promise<void>;
}

export interface ResetFileOutcome {
  path: string;
  result: "restored" | "deleted" | "merged" | "conflict" | "skipped";
  reason?: string;
}

/** The authored post-image is the merge base, so later unrelated edits survive. */
async function resetPath(
  host: TurnResetHost,
  path: string,
  targetCommit: string | null,
  baseCommit: string | null,
): Promise<ResetFileOutcome> {
  if (!targetCommit || !baseCommit || !await host.snapshotAvailable(targetCommit) || !await host.snapshotAvailable(baseCommit)) {
    return { path, result: "skipped", reason: "no snapshot available" };
  }
  const targetOid = await host.blobOid(targetCommit, path);
  const baseOid = await host.blobOid(baseCommit, path);
  const currentOid = await host.diskBlobOid(path);

  if (currentOid === baseOid) {
    // Leaving the reverted blob staged would resurrect it on commit; other
    // staged bytes belong to the user's partial staging and remain untouched.
    const stagedSameBlob =
      currentOid != null && (await host.indexBlobOid(path)) === currentOid;
    if (targetOid) {
      await host.restore(path, targetCommit, currentOid);
      if (stagedSameBlob) await host.restoreIndex(path, targetCommit);
      return { path, result: "restored" };
    }
    if (currentOid) {
      if (stagedSameBlob) {
        await host.removeIndex(path).catch(
          () => {},
        );
      }
      await host.restore(path, null, currentOid);
      return { path, result: "deleted" };
    }
    return { path, result: "skipped", reason: "nothing to do" };
  }

  const cur = await host.readDiskText(path);
  const base = baseOid
    ? await host.showText(baseCommit, path)
    : { text: "", isBinary: false };
  const tgt = targetOid
    ? await host.showText(targetCommit, path)
    : { text: "", isBinary: false };
  if (!cur || cur.isBinary || base?.isBinary || tgt?.isBinary) {
    return {
      path,
      result: "conflict",
      reason: "binary or unreadable; not auto-merged",
    };
  }
  const { merged, conflict } = await host.mergeText(
    cur.text,
    base?.text ?? "",
    tgt?.text ?? "",
  );
  if (conflict) {
    return { path, result: "conflict", reason: "overlapping concurrent edit" };
  }
  if (!await host.publishMerge(path, merged, cur.text))
    return { path, result: "conflict", reason: "file changed during merge" };
  return { path, result: "merged" };
}

export interface TurnResetResult {
  /** Files actually changed on disk (restored / merged / deleted). */
  applied: ResetFileOutcome[];
  /** Files a concurrent/overlapping edit blocked — left as-is, not clobbered. */
  conflicts: ResetFileOutcome[];
  /** Unavailable snapshots or unsupported contents require a separate warning. */
  skipped: ResetFileOutcome[];
  preResetSnapshot: string | null;
  /** Undo's merge base distinguishes reset output from edits made afterward. */
  postResetSnapshot: string | null;
}

/** Restore authored paths toward `targetCommit`, using the chat's latest
 * post-image `baseCommit` as the merge ancestor and retaining an Undo snapshot. */
export async function applyTurnReset(
  host: TurnResetHost,
  paths: string[],
  targetCommit: string | null,
  baseCommit: string | null,
): Promise<TurnResetResult> {
  const preResetSnapshot = await host.snapshot("pre");
  await host.prune().catch(() => {});
  const outcomes: ResetFileOutcome[] = [];
  for (const path of paths) {
    try {
      outcomes.push(await resetPath(host, path, targetCommit, baseCommit));
    } catch (err) {
      outcomes.push({
        path,
        result: "skipped",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const postResetSnapshot = await host.snapshot("post");
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

/** Oldest-first steps unwind newest-first, each with its own authored pre/post
 * pair, preserving interleaved edits. A missing snapshot blocks the whole path
 * before mutation so the reset cannot leave it partially reverted. */
export async function applyTurnSpanReset(
  host: TurnResetHost,
  steps: TurnResetStep[],
): Promise<TurnResetResult> {
  const preResetSnapshot = await host.snapshot("pre");
  await host.prune().catch(() => {});

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

  for (const step of steps) {
    if (step.preSnapshot && step.postSnapshot && await host.snapshotAvailable(step.preSnapshot) && await host.snapshotAvailable(step.postSnapshot)) continue;
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
          host,
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
      // A failed inverse invalidates earlier merge bases for this path. Roll
      // back any newer inverses so a conflict cannot leave it partially reset.
      if (outcome.result === "conflict" || outcome.result === "skipped") {
        if (touched.has(path) && preResetSnapshot) {
          const [rollback] = await undoTurnReset(host, preResetSnapshot, [path]);
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
  const postResetSnapshot = await host.snapshot("post");
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

/** Restore files using the post-reset `mergeBase` to preserve subsequent edits.
 * Without it, legacy Undo records and mid-reset rollback retain forced restore.
 * Transcript restoration remains the caller's responsibility. */
export async function undoTurnReset(
  host: TurnResetHost,
  snapshot: string,
  paths: string[],
  mergeBase?: string | null,
): Promise<ResetFileOutcome[]> {
  if (!await host.snapshotAvailable(snapshot)) return paths.map(path => ({ path, result: "skipped", reason: "no snapshot available" }));
  if (mergeBase) {
    const out: ResetFileOutcome[] = [];
    for (const path of paths) {
      try {
        out.push(await resetPath(host, path, snapshot, mergeBase));
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
      const oid = await host.blobOid(snapshot, path);
      if (oid) {
        await host.restore(path, snapshot);
        out.push({ path, result: "restored" });
      } else {
        await host.restore(path, null);
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

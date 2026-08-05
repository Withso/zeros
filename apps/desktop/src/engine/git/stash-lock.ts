// ──────────────────────────────────────────────────────────
// Per-repository stash serialization
// ──────────────────────────────────────────────────────────
//
// All worktrees of ONE repo share a single `refs/stash` stack. A `git stash
// push` followed by `git rev-parse stash@{0}` (to capture the new stash's SHA)
// is only correct if no OTHER stash op on the same repo interleaves between the
// two commands — otherwise the second op shifts the stack and `stash@{0}`
// resolves to the WRONG workspace's stash, so a later restore applies the wrong
// changes (silent cross-workspace work loss).
//
// The engine is single-process, so an in-memory promise-chain mutex keyed by the
// shared repo root makes each repo's stash ops atomic without touching the
// stack-free `stash create` path (which would drop untracked files).
// ──────────────────────────────────────────────────────────

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after any in-flight stash op on the SAME repo finishes. Failures
 *  don't poison the chain (the next op still runs). */
export function withStashLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(repoRoot) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(
    repoRoot,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

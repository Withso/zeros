// ──────────────────────────────────────────────────────────
// Remote-aware base-branch helpers
// ──────────────────────────────────────────────────────────
//
// Small, best-effort git probes used when basing a new worktree on the remote
// (createWorkspace) and when resolving a Local-main "changes vs origin" diff.
// Every probe is non-fatal: a failure (offline, no remote, unset symref) returns
// false/null so the caller can fall back to a local ref. Network probes go
// through runGit so HTTPS remotes use the same scoped credential broker as
// push/clone instead of falling through to an ambient system helper.
// ──────────────────────────────────────────────────────────

import { assertSafeGitRef, runGit } from "./git-exec";

async function git(
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  const { stdout } = await runGit(cwd, args, {
    maxBufferBytes: 4 * 1024 * 1024,
    // Network probes (ls-remote) must be bounded — they sit on the
    // create-workspace reply path. A local probe (symbolic-ref) passes no
    // timeout (it can't hang). 0/undefined = no timeout (Node default).
    timeoutMs,
  });
  return stdout.trim();
}

/** True when the repo has a remote with the given name (default "origin"). */
export async function repoHasRemote(
  repoRoot: string,
  remote = "origin",
): Promise<boolean> {
  // `remote` is sourced from layered TOML (`git.remote`), which a paired relay
  // device can write — refuse a leading-"-" value before it reaches git as a
  // positional (flag injection). Throws VALIDATION_FAILED; fails the create loud.
  assertSafeGitRef(remote, "remote");
  try {
    await git(repoRoot, ["remote", "get-url", remote]);
    return true;
  } catch {
    return false;
  }
}

/** True when a git ref resolves locally (e.g. `refs/remotes/origin/main`,
 *  `refs/heads/main`). `--verify --quiet` exits non-zero (→ false) when absent. */
export async function refExists(
  repoRoot: string,
  ref: string,
): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/** Freshness memo for fetchRemote: (repoRoot ␀ remote) → last SUCCESSFUL fetch
 *  time. A fetch inside this window is skipped — creating several workspaces in
 *  a row shouldn't pay up to 8s of network per create for refs that were
 *  refreshed seconds ago. In-memory only (the engine is long-lived); failures
 *  are never memoized, so an offline blip retries on the next call. */
const FETCH_FRESH_MS = 60_000;
const lastFetchAt = new Map<string, number>();
/** In-flight dedup: two rapid creates on the same repo share one fetch instead
 *  of racing two `git fetch` processes against the same ref store. */
const inFlightFetches = new Map<string, Promise<boolean>>();
/** ls-remote HEAD memo — see detectRemoteDefaultBranch. A remote's default
 *  branch changes ~never; re-probing it over the network on every create was
 *  up to 5s of the create reply path for repos without a local origin/HEAD. */
const DETECT_HEAD_TTL_MS = 10 * 60_000;
const lsRemoteHeadMemo = new Map<string, { branch: string; at: number }>();

/** Test seam: forget fetch/default-branch freshness (all repos, or one
 *  repo+remote). */
export function resetFetchFreshness(
  repoRoot?: string,
  remote = "origin",
): void {
  if (repoRoot === undefined) {
    lastFetchAt.clear();
    inFlightFetches.clear();
    lsRemoteHeadMemo.clear();
  } else {
    const key = `${repoRoot}\0${remote}`;
    lastFetchAt.delete(key);
    inFlightFetches.delete(key);
    lsRemoteHeadMemo.delete(key);
  }
}

/** Best-effort `git fetch <remote>`. Non-fatal — returns false on any failure
 *  (offline, auth, no remote) so the caller falls back to a local base. Bounded
 *  by a hard 8s timeout so a hung network can't stall workspace creation.
 *
 *  Freshness memo: skipped (→ true) when this repo+remote was successfully
 *  fetched < 60s ago — pass `force: true` for an explicit user-driven freshen
 *  that must really hit the network (the branch-picker refresh looking for a
 *  just-pushed branch).
 *
 *  Wait cap: with `maxWaitMs`, the CALLER stops waiting after that long (→
 *  false, fall back to local refs) but the fetch keeps running detached and
 *  still lands in the ref store + freshness memo — so a slow network costs one
 *  create a short wait instead of a stall, and the next create is fresh AND
 *  instant. Concurrent calls for the same repo+remote share one in-flight
 *  fetch. */
export async function fetchRemote(
  repoRoot: string,
  remote = "origin",
  opts: { force?: boolean; maxWaitMs?: number } = {},
): Promise<boolean> {
  assertSafeGitRef(remote, "remote"); // see repoHasRemote — flag-injection guard
  const key = `${repoRoot}\0${remote}`;
  const last = lastFetchAt.get(key);
  if (!opts.force && last !== undefined && Date.now() - last < FETCH_FRESH_MS) {
    return true; // refs are fresh enough for a best-effort base resolve
  }
  let flight = inFlightFetches.get(key);
  if (!flight) {
    const started: Promise<boolean> = runGit(repoRoot, ["fetch", remote], {
      maxBufferBytes: 16 * 1024 * 1024,
      // Hard bound so a hung network can't pin the process — the fetch is
      // best-effort and callers fall back to the local base on failure.
      timeoutMs: 8_000,
    })
      .then(() => {
        lastFetchAt.set(key, Date.now());
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (inFlightFetches.get(key) === started) inFlightFetches.delete(key);
      });
    flight = started;
    inFlightFetches.set(key, started);
  }
  const waitMs = opts.maxWaitMs;
  if (waitMs === undefined || waitMs <= 0) return flight;
  return Promise.race([
    flight,
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), waitMs);
      // Don't let a pending race timer hold the engine process open.
      t.unref?.();
    }),
  ]);
}

/** Resolve a remote's default branch name (e.g. "main"), or null if it can't be
 *  determined. Order:
 *    1. local `refs/remotes/<remote>/HEAD` symref — fast, no network (set by
 *       clone, or `git remote set-head`).
 *    2. `git ls-remote --symref <remote> HEAD` — authoritative; one round-trip.
 *    3. null → caller falls back to a settings value / "main".
 *  Both probes are non-fatal. */
export async function detectRemoteDefaultBranch(
  repoRoot: string,
  remote = "origin",
): Promise<string | null> {
  assertSafeGitRef(remote, "remote"); // see repoHasRemote — flag-injection guard
  // 1. local origin/HEAD symref → "origin/main"
  try {
    const out = await git(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const prefix = `${remote}/`;
    if (out.startsWith(prefix)) return out.slice(prefix.length);
    if (out) return out;
  } catch {
    /* origin/HEAD not set — fall through to ls-remote */
  }
  // 2. ls-remote --symref → "ref: refs/heads/main\tHEAD". Network round-trip —
  // bounded (5s) so an unreachable remote can't hang the create reply path,
  // and memoized (10 min) so repos WITHOUT a local origin/HEAD symref don't
  // pay it on every single create. Only successes are memoized: an offline
  // blip retries on the next call.
  const key = `${repoRoot}\0${remote}`;
  const memo = lsRemoteHeadMemo.get(key);
  if (memo && Date.now() - memo.at < DETECT_HEAD_TTL_MS) return memo.branch;
  try {
    const out = await git(
      repoRoot,
      ["ls-remote", "--symref", remote, "HEAD"],
      5_000,
    );
    const m = out.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
    if (m) {
      lsRemoteHeadMemo.set(key, { branch: m[1], at: Date.now() });
      return m[1];
    }
  } catch {
    /* offline / no remote — give up, caller uses a local default */
  }
  return null;
}

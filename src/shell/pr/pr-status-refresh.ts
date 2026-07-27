/** Active PR surfaces poll GitHub slowly, but returning to Zeros is an explicit
 * external-change boundary. The age floor coalesces the visibility + focus
 * events browsers commonly emit together and avoids duplicating a mount read. */
export const PR_STATUS_FULL_POLL_MS = 60_000;
export const PR_STATUS_RESUME_MIN_AGE_MS = 2_000;

export function shouldRefreshPrStatusOnResume(
  lastActivityAt: number,
  now: number = Date.now(),
): boolean {
  return (
    lastActivityAt === 0 || now - lastActivityAt >= PR_STATUS_RESUME_MIN_AGE_MS
  );
}

/** A detailed PR read owns live presentation, while gh.prSync owns the durable
 * workspace row/lifecycle. Reconcile only when GitHub disagrees with the row. */
export function shouldReconcileWorkspacePrState(
  persistedState: string | null,
  liveState: string,
): boolean {
  return persistedState !== liveState;
}

/** How a PR-status GitHub read came to be requested. The recurring,
 * self-scheduled triggers (interval / resume / refresh-key) are the ones a
 * terminal PR suppresses; the user-initiated ones (activation / manual)
 * always go through so suppression can never strand a stale status. */
export type PrStatusPollTrigger =
  /** The bounded active-only slow poll (island + Review slow/fast lanes). */
  | "interval"
  /** App focus / visibilitychange — the external-change resume boundary. */
  | "resume"
  /** A git refresh-bus bump (agent turn-end, engine git/gh write). */
  | "refresh-key"
  /** Tab/island (re)activation — the mount fetch after navigation. */
  | "activation"
  /** An explicit user refresh action (Review's refresh button / mutations). */
  | "manual";

export interface PrStatusEffectTrigger {
  /** Data generation currently considered active by this retained surface. */
  activeDataKey: string | null;
  /** Null while hidden; otherwise how the fetch effect should classify itself. */
  trigger: "activation" | "refresh-key" | null;
}

/** Classify one retained PR-status effect run. Kept pure so the active →
 * hidden → active transition cannot regress into a data-key-only check. */
export function classifyPrStatusEffectTrigger(
  activeDataKey: string | null,
  active: boolean,
  dataKey: string,
): PrStatusEffectTrigger {
  if (!active) return { activeDataKey: null, trigger: null };
  return {
    activeDataKey: dataKey,
    trigger: activeDataKey === dataKey ? "refresh-key" : "activation",
  };
}

/** Merged and closed are TERMINAL: GitHub never moves a PR out of them on its
 * own. A human can still REOPEN a closed PR, which is why callers must
 * re-derive this from current data on every trigger (re-evaluable suppression)
 * rather than latching it once. */
export function isTerminalPrState(state: string | null | undefined): boolean {
  return state === "merged" || state === "closed";
}

/** The PR state the polling decision keys on: live GitHub data when a settled
 * fetch exists (a non-null mergedAt is authoritative even while `state` lags
 * the merge), else the persisted workspace row — the same precedence
 * derivePrIslandState uses for its terminal short-circuit, so the poll gate
 * and the rendered row can never disagree about "this PR is done". */
export function effectivePrPollState(
  livePr: { state: string; mergedAt: number | null } | null | undefined,
  persistedState?: string | null,
): string | null {
  if (livePr) return livePr.mergedAt != null ? "merged" : livePr.state;
  return persistedState ?? null;
}

/** Should this trigger burn a GitHub round for this PR? Open/draft/unknown
 * PRs always poll. Terminal (merged/closed) PRs answer only user-initiated
 * triggers — real-world logs (2026-07-24) showed a merged PR re-fetched every
 * few seconds forever — so the recurring lanes stay quiet while manual
 * refresh and tab re-activation keep a reopened PR recoverable. */
export function shouldPollPrStatus(
  effectiveState: string | null,
  trigger: PrStatusPollTrigger,
): boolean {
  if (!isTerminalPrState(effectiveState)) return true;
  return trigger === "activation" || trigger === "manual";
}

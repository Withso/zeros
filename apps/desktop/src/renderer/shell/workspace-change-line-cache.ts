import type { ChangeLineCounts } from "../platform/git";

/** The shared "nothing to show" value. Frozen and module-level so a tab that
 *  has no numbers never re-renders on a fresh object identity. */
export const NO_CHANGE_LINES: ChangeLineCounts = Object.freeze({
  additions: 0,
  deletions: 0,
});

// Bounded by the number of workspaces a session realistically visits; the
// oldest entry is dropped once the bound is reached (insertion order is the
// LRU queue, refreshed on every write).
export const MAX_REMEMBERED_CHANGE_LINE_WORKSPACES = 128;
const lastKnownChangeLines = new Map<string, ChangeLineCounts>();
const lastKnownBases = new Map<string, string>();
const lastObservations = new Map<string, number>();
const confirmedListeners = new Map<string, Set<() => void>>();
let nextObservation = 0;

/** Count probes and full comparisons share a clock captured when each read
 * starts. A slow older read cannot overwrite a newer confirmed comparison. */
export function beginChangeLineObservation(): number {
  return ++nextObservation;
}

/** A passive Home observer reuses sidebar counts without issuing another Git
 * read. Unknown stays distinct from a confirmed zero, and a new target branch
 * cannot inherit the previous comparison's counts. */
export function confirmedChangeLinesForBase(
  target: string,
  baseBranch: string,
): ChangeLineCounts | undefined {
  return lastKnownBases.get(target) === baseBranch
    ? lastKnownChangeLines.get(target)
    : undefined;
}

export function subscribeConfirmedChangeLines(
  target: string,
  listener: () => void,
): () => void {
  const listeners = confirmedListeners.get(target) ?? new Set();
  listeners.add(listener);
  confirmedListeners.set(target, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) confirmedListeners.delete(target);
  };
}

/** Record a target's last CONFIRMED pair and return the CANONICAL object for
 *  it. Only a successful read may call this — a failed refresh must leave the
 *  previous answer standing.
 *
 *  An unchanged pair keeps its previous identity, which is what lets a tab sit
 *  out the re-render: every Git refresh generation re-reads every visible
 *  workspace, and almost none of them have actually moved. */
export function rememberChangeLines(
  target: string,
  counts: ChangeLineCounts,
  baseBranch?: string,
  observation = beginChangeLineObservation(),
): ChangeLineCounts {
  const previous = lastKnownChangeLines.get(target);
  const previousBase = lastKnownBases.get(target);
  if (observation < (lastObservations.get(target) ?? 0)) {
    return previous && previousBase === baseBranch ? previous : counts;
  }
  const canonical =
    previous &&
    previous.additions === counts.additions &&
    previous.deletions === counts.deletions
      ? previous
      : counts;
  lastKnownChangeLines.delete(target);
  lastKnownChangeLines.set(target, canonical);
  lastObservations.set(target, observation);
  if (baseBranch !== undefined) lastKnownBases.set(target, baseBranch);
  else lastKnownBases.delete(target);
  while (lastKnownChangeLines.size > MAX_REMEMBERED_CHANGE_LINE_WORKSPACES) {
    const oldest = lastKnownChangeLines.keys().next().value as
      | string
      | undefined;
    if (oldest === undefined) break;
    lastKnownChangeLines.delete(oldest);
    lastKnownBases.delete(oldest);
    lastObservations.delete(oldest);
    for (const listener of confirmedListeners.get(oldest) ?? []) listener();
  }
  if (previous !== canonical || previousBase !== baseBranch)
    for (const listener of confirmedListeners.get(target) ?? []) listener();
  return canonical;
}

/** The last confirmed pair for a target, or the shared zero pair when that
 *  target has never resolved (or was evicted). Never allocates. */
export function lastConfirmedChangeLines(
  target: string | null,
): ChangeLineCounts {
  if (!target) return NO_CHANGE_LINES;
  return lastKnownChangeLines.get(target) ?? NO_CHANGE_LINES;
}

export function resetConfirmedChangeLinesForTests(): void {
  lastKnownChangeLines.clear();
  lastKnownBases.clear();
  lastObservations.clear();
  confirmedListeners.clear();
  nextObservation = 0;
}

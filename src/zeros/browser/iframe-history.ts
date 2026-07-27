export interface IframeHistorySnapshot {
  entries: string[];
  index: number;
}

/** Copy the mutable hook refs before an explicit iframe navigation changes
 * them. A cancelled provisional load can then restore the exact Back/Forward
 * arm rather than replacing the requested entry with the page we never left. */
export function snapshotIframeHistory(
  entries: string[],
  index: number,
): IframeHistorySnapshot {
  return { entries: [...entries], index };
}

/** Reconcile a trusted committed URL with the renderer-owned history stack.
 * Same-document history traversal reports the destination through
 * `did-navigate-in-page`, just like pushState/hash navigation. Matching an
 * adjacent entry first preserves Back/Forward direction; a genuinely new URL
 * still truncates the forward arm and appends. */
export function reconcileObservedIframeHistory(
  entries: string[],
  index: number,
  url: string,
  pendingUrl: string | null,
  allowAdjacentTraversal = false,
): IframeHistorySnapshot {
  const current = entries[index];
  if (pendingUrl && current === pendingUrl) {
    const next = [...entries];
    next[index] = url;
    return { entries: next, index };
  }
  if (url === current) return { entries, index };

  if (allowAdjacentTraversal && index > 0 && entries[index - 1] === url) {
    return { entries, index: index - 1 };
  }
  if (
    allowAdjacentTraversal &&
    index >= 0 &&
    index < entries.length - 1 &&
    entries[index + 1] === url
  ) {
    return { entries, index: index + 1 };
  }

  const next = entries.slice(0, index + 1);
  next.push(url);
  return { entries: next, index: next.length - 1 };
}

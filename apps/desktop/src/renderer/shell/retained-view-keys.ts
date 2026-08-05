/** Add `activeKey` to a most-recently-used view deck without duplicating it.
 * The returned order is oldest → newest; the active view is always last. */
export function retainRecentViewKeys(
  retained: readonly string[],
  activeKey: string | null,
  limit: number,
  availableKeys?: ReadonlySet<string>,
): string[] {
  if (limit <= 0) return retained.length === 0 ? (retained as string[]) : [];
  const validActiveKey =
    activeKey && (!availableKeys || availableKeys.has(activeKey))
      ? activeKey
      : null;
  let next = (
    availableKeys
      ? retained.filter((key) => availableKeys.has(key))
      : [...retained]
  ).slice(-limit);
  if (validActiveKey) {
    next = [
      ...next.filter((key) => key !== validActiveKey),
      validActiveKey,
    ].slice(-limit);
  }
  if (
    next.length === retained.length &&
    next.every((key, index) => key === retained[index])
  ) {
    return retained as string[];
  }
  return next;
}

/** Multi-visible variant for split panes and intent pre-rendering. Every key in
 * `activeKeys` is retained (in caller priority order) before the bound is
 * applied. With a limit at least as large as the number of visible panes, no
 * live surface can be evicted by another pane's selection. */
export function retainRecentViewKeySet(
  retained: readonly string[],
  activeKeys: readonly string[],
  limit: number,
  availableKeys?: ReadonlySet<string>,
): string[] {
  if (limit <= 0) return retained.length === 0 ? (retained as string[]) : [];
  let next = availableKeys
    ? retained.filter((key) => availableKeys.has(key))
    : [...retained];
  for (const key of activeKeys) {
    if (!key || (availableKeys && !availableKeys.has(key))) continue;
    next = [...next.filter((entry) => entry !== key), key];
  }
  next = next.slice(-limit);
  if (
    next.length === retained.length &&
    next.every((key, index) => key === retained[index])
  ) {
    return retained as string[];
  }
  return next;
}

/** Collapse retained variants that represent the same mounted surface. The
 * newest key wins while unrelated identities keep their deck order. This lets
 * metadata/query changes update one React tree in place instead of mounting a
 * duplicate editor and discarding its local draft. */
export function retainLatestViewKeyPerIdentity(
  keys: readonly string[],
  identityForKey: (key: string) => string,
): string[] {
  const seen = new Set<string>();
  const reversed: string[] = [];
  let removedDuplicate = false;
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index];
    const identity = identityForKey(key);
    if (seen.has(identity)) {
      removedDuplicate = true;
      continue;
    }
    seen.add(identity);
    reversed.push(key);
  }
  if (!removedDuplicate) return keys as string[];
  return reversed.reverse();
}

/** A nested retained destination is paintable only while both its owning
 * surface and its own key are active. Checking the key alone lets a child's
 * `visibility: visible` override an inactive parent's inherited visibility. */
export function isRetainedViewVisible(
  surfaceActive: boolean,
  viewKey: string,
  activeKey: string | null,
): boolean {
  return surfaceActive && viewKey === activeKey;
}

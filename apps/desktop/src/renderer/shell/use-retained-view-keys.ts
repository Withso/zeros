import { useLayoutEffect, useMemo, useRef } from "react";

import {
  preserveRetainedViewOrder,
  retainRecentViewKeys,
  retainRecentViewKeySet,
} from "./retained-view-keys";

/** Render a bounded MRU deck immediately, then remember that exact committed
 * deck without scheduling a second React render. Ref writes happen only after
 * commit, so an abandoned concurrent render cannot corrupt retention order. */
export function useRetainedViewKeys(
  activeKey: string | null,
  limit: number,
  availableKeys?: ReadonlySet<string>,
  retentionScope = "",
): string[] {
  // Stores only the last committed deck; the current render derives its full
  // active deck synchronously so the destination view exists before paint.
  const retainedRef = useRef<{ scope: string; keys: string[] }>({
    scope: retentionScope,
    keys: [],
  });
  const keys = useMemo(() => {
    const committedKeys =
      retainedRef.current.scope === retentionScope
        ? retainedRef.current.keys
        : [];
    return retainRecentViewKeys(
      committedKeys,
      activeKey,
      limit,
      availableKeys,
    );
  }, [activeKey, availableKeys, limit, retentionScope]);
  useLayoutEffect(() => {
    retainedRef.current = { scope: retentionScope, keys };
  }, [keys, retentionScope]);
  return keys;
}

/** Bounded retained deck for surfaces that can have several simultaneously
 * visible destinations (split chats) or one visible + one intent-prefetched
 * destination (Changes hover). */
export function useRetainedViewKeySet(
  activeKeys: readonly string[],
  limit: number,
  availableKeys?: ReadonlySet<string>,
  retentionScope = "",
): string[] {
  const retainedRef = useRef<{ scope: string; keys: string[] }>({
    scope: retentionScope,
    keys: [],
  });
  // Context changes are handled during render, not in an effect. A deck from
  // workspace A must never spend one paint mounted with workspace B's cwd.
  const keys = useMemo(() => {
    const committedKeys =
      retainedRef.current.scope === retentionScope
        ? retainedRef.current.keys
        : [];
    return retainRecentViewKeySet(
      committedKeys,
      activeKeys,
      limit,
      availableKeys,
    );
  }, [activeKeys, availableKeys, limit, retentionScope]);
  useLayoutEffect(() => {
    retainedRef.current = { scope: retentionScope, keys };
  }, [keys, retentionScope]);
  return keys;
}

/** Render a retained deck without reflecting MRU changes as sibling moves.
 * React preserves component state across keyed reorders, but the browser does
 * not preserve a nested browsing context when its iframe DOM node is moved. */
export function useStableRetainedViewOrder(
  retainedKeys: readonly string[],
  retentionScope = "",
): string[] {
  const orderRef = useRef<{ scope: string; keys: string[] }>({
    scope: retentionScope,
    keys: [],
  });
  const keys = useMemo(() => {
    const committedKeys =
      orderRef.current.scope === retentionScope ? orderRef.current.keys : [];
    return preserveRetainedViewOrder(committedKeys, retainedKeys);
  }, [retainedKeys, retentionScope]);
  useLayoutEffect(() => {
    orderRef.current = { scope: retentionScope, keys };
  }, [keys, retentionScope]);
  return keys;
}

// ──────────────────────────────────────────────────────────
// scroll-memory — keyed scroll offsets + reattach restoration
// ──────────────────────────────────────────────────────────
//
// Two related mechanisms with one goal: a scrollable surface returns to the
// exact offset the user left it at, no matter how its DOM was hidden or
// destroyed in between.
//
//  • Keyed memory (`useScrollMemory`) — for scrollers that REMOUNT (Workbench
//    Changes/Review/Files surfaces are per-worktree and remount on every
//    workspace switch) or that are SHARED by several logical views (the
//    Settings detail pane hosts every section panel; the Repo page scroller
//    hosts every repo/view target — hiding the inactive panel with
//    `display:none` collapses the shared scroller and the browser clamps
//    scrollTop). The offset lives in a module-level map under a caller-chosen
//    key, so it survives both. Session-lifetime by design — chat transcripts,
//    the one surface with durable cross-restart scroll, keep their
//    localStorage-backed sessions-store and use only the registry half below.
//
//  • Reattach registry (`registerScrollRestore` + `capture/restoreScrollWithin`)
//    —
//    for scrollers whose DOM is preserved but whose scroll state the browser
//    destroys or temporarily clamps. Chromium resets a scroller to 0 when it
//    is detached from the document (pane-host reparenting on workspace switch);
//    a shared scroller can also clamp when its old child becomes display:none.
//    Containers that perform those transitions call restore right after;
//    every registered scroller inside re-applies its own saved offset before
//    the frame paints. (Chromium's `moveBefore()` will eventually make the
//    reparent case unnecessary; the Electron we ship doesn't have it yet.)
//
// Only scrollTop is tracked. The app's horizontal scrollers (dashboard board,
// tab strips) live on surfaces that hide via `visibility`, which preserves
// scroll state natively.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Marker attribute so container-level restores can find registered scrollers
 *  with one querySelectorAll instead of tracking React subtrees. */
export const SCROLL_RESTORE_ATTR = "data-scroll-restore";

/** Opt-in for content-visibility boundaries whose measured block size must
 * survive DOM detachment. Chromium forgets `contain-intrinsic-size:auto`'s
 * remembered size when a subtree is removed, so reattaching a long transcript
 * otherwise lays every skipped turn out at its 240px fallback for one paint. */
export const SCROLL_INTRINSIC_SIZE_ATTR = "data-scroll-intrinsic-size";

interface ScrollRegistration {
  restore: () => void;
  capture?: () => void;
}

const restorers = new WeakMap<Element, ScrollRegistration>();

/** Session-lifetime offsets for `useScrollMemory` keys. */
const offsets = new Map<string, number>();
export const MAX_SCROLL_MEMORY_ENTRIES = 512;

/** How long a clamped restore keeps retrying while async content (SQLite
 *  hydrate, git diff load, section fetch) grows the scroller. Frame-based so
 *  a suspended renderer doesn't burn the budget while nothing can change. */
const RESTORE_RETRY_FRAMES = 180;

// ── Pure map access (also the unit-test surface) ─────────────

export function saveScrollOffset(key: string, top: number): void {
  if (!key || !Number.isFinite(top) || top < 0) return;
  // Delete + set makes this a bounded least-recently-written cache. Scroll
  // events naturally keep active destinations warm without an extra clock.
  offsets.delete(key);
  offsets.set(key, top);
  while (offsets.size > MAX_SCROLL_MEMORY_ENTRIES) {
    const oldest = offsets.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    offsets.delete(oldest);
  }
}

export function savedScrollOffset(key: string): number | undefined {
  return offsets.get(key);
}

/** Test/reset hook — not used by production code paths. */
export function clearScrollOffsets(): void {
  offsets.clear();
}

// ── Reattach registry ────────────────────────────────────────

/** Attach a restore function to a scroller element. Returns the unregister
 *  cleanup. The marker attribute makes the element discoverable by
 *  `restoreScrollWithin`; the WeakMap keeps the callback collectable. */
export function registerScrollRestore(
  el: Element,
  restore: () => void,
  capture?: () => void,
): () => void {
  const registration = { restore, capture };
  el.setAttribute(SCROLL_RESTORE_ATTR, "");
  restorers.set(el, registration);
  return () => {
    // A newer registration for the same element (key change re-registering
    // in the same commit) must not be torn down by the old cleanup.
    if (restorers.get(el) === registration) {
      restorers.delete(el);
      el.removeAttribute(SCROLL_RESTORE_ATTR);
    }
  };
}

/** Snapshot registered scrollers while their old surface is still connected.
 * Containers call this immediately before moving a retained subtree. This
 * closes the scroll-event → rAF race: a workspace click cannot detach a pane
 * before its final compositor-owned position has reached the keyed store. */
export function captureScrollWithin(root: Element | null): void {
  if (!root) return;
  if (root.hasAttribute(SCROLL_RESTORE_ATTR)) {
    restorers.get(root)?.capture?.();
  }
  for (const el of root.querySelectorAll(`[${SCROLL_RESTORE_ATTR}]`)) {
    restorers.get(el)?.capture?.();
  }
}

/** Re-apply saved offsets for every registered scroller inside (and
 * including) `root`. Call after reparenting a preserved subtree or revealing
 * a surface whose shared scroll geometry may have clamped while hidden. */
export function restoreScrollWithin(root: Element | null): void {
  if (!root) return;
  if (root.hasAttribute(SCROLL_RESTORE_ATTR)) {
    restorers.get(root)?.restore();
  }
  for (const el of root.querySelectorAll(`[${SCROLL_RESTORE_ATTR}]`)) {
    restorers.get(el)?.restore();
  }
}

function intrinsicSizeElementsWithin(root: Element): HTMLElement[] {
  const elements: Element[] = [];
  if (root.hasAttribute(SCROLL_INTRINSIC_SIZE_ATTR)) elements.push(root);
  elements.push(...root.querySelectorAll(`[${SCROLL_INTRINSIC_SIZE_ATTR}]`));
  return elements as HTMLElement[];
}

/** Freeze the current block sizes of marked content-visibility boundaries.
 *
 * Chromium 130 preserves a scroller's DOM but resets its scrollTop and drops
 * `contain-intrinsic-size:auto`'s remembered sizes when that DOM is detached.
 * On reattach, every skipped transcript turn temporarily becomes the fallback
 * height, so an anchor restore clamps short and the first visible frame comes
 * from near the top. Writing the already-measured size to the block-axis
 * longhand keeps the detached geometry exact. Reads are intentionally batched
 * before writes to avoid a layout/read/write loop on the navigation path.
 *
 * Returns the number of usable sizes captured (also useful to focused tests).
 */
export function preserveScrollGeometryWithin(root: Element | null): number {
  if (!root) return 0;
  const elements = intrinsicSizeElementsWithin(root);

  const measured = elements.map((element) => ({
    element,
    rect: element.getBoundingClientRect(),
  }));
  let captured = 0;
  for (const { element, rect } of measured) {
    const { height, width } = rect;
    if (!Number.isFinite(height) || height <= 0) continue;
    const value = `auto ${height}px`;
    if (element.style.containIntrinsicBlockSize !== value) {
      element.style.containIntrinsicBlockSize = value;
    }
    if (Number.isFinite(width) && width > 0) {
      element.dataset.scrollIntrinsicInlineSize = String(width);
    }
    captured += 1;
  }
  return captured;
}

/** Materialize any still-unmeasured content-visibility boundaries needed for
 * a cold restore. A persisted anchor can precede the current viewport after an
 * app restart, when Chromium has no remembered `auto` sizes yet. Temporarily
 * making only the prefix through that anchor visible gives it exact geometry
 * synchronously; explicit intrinsic sizes keep that geometry when `auto`
 * resumes before the same paint. `through === null` materializes all markers
 * for a legacy raw-offset restore. Warm reattach is a no-op because pre-detach
 * capture already populated every size. */
export function materializeScrollGeometryWithin(
  root: Element | null,
  through: Element | null,
): number {
  if (!root) return 0;
  const all = intrinsicSizeElementsWithin(root);
  const throughIndex = through ? all.indexOf(through as HTMLElement) : -1;
  const relevant =
    through && throughIndex >= 0 ? all.slice(0, throughIndex + 1) : all;
  const widthChecks = relevant.map((element) => ({
    element,
    width: element.getBoundingClientRect().width,
    savedWidth: Number(element.dataset.scrollIntrinsicInlineSize),
  }));
  const missing = widthChecks
    .filter(({ element, width, savedWidth }) => {
      if (element.style.containIntrinsicBlockSize.length === 0) return true;
      if (!Number.isFinite(savedWidth) || savedWidth <= 0) return true;
      return Number.isFinite(width) && Math.abs(width - savedWidth) > 1;
    })
    .map(({ element }) => element);
  if (missing.length === 0) return 0;

  const previous = missing.map((element) => ({
    element,
    contentVisibility: element.style.contentVisibility,
  }));
  for (const { element } of previous) {
    element.style.contentVisibility = "visible";
  }
  const measured = previous.map(({ element, contentVisibility }) => {
    const rect = element.getBoundingClientRect();
    return {
      element,
      contentVisibility,
      height: rect.height,
      width: rect.width,
    };
  });
  let captured = 0;
  for (const { element, height, width } of measured) {
    if (!Number.isFinite(height) || height <= 0) continue;
    element.style.containIntrinsicBlockSize = `auto ${height}px`;
    if (Number.isFinite(width) && width > 0) {
      element.dataset.scrollIntrinsicInlineSize = String(width);
    }
    captured += 1;
  }
  for (const { element, contentVisibility } of measured) {
    if (contentVisibility) element.style.contentVisibility = contentVisibility;
    else element.style.removeProperty("content-visibility");
  }
  return captured;
}

// ── Keyed scroll memory hook ─────────────────────────────────

/**
 * Remember and restore `el.scrollTop` under `key`.
 *
 *  - Saves on scroll, ignoring clamp noise: a detached scroller
 *    (`!isConnected`) or one collapsed by `display:none` (clientHeight 0)
 *    reports 0, which is never user intent.
 *  - Restores on mount and on key change. An unvisited key restores to 0 —
 *    a brand-new view starts at the top instead of inheriting whatever
 *    offset the previous view left in a shared scroller.
 *  - A restore that lands short (content still loading, scrollHeight too
 *    small to honor the target) re-applies each frame until it sticks, the
 *    user interacts, or the retry budget runs out. While the retry is armed
 *    the save path is muted so the clamped position can't overwrite the
 *    saved target.
 *  - Registers the element in the reattach registry so container-level
 *    `restoreScrollWithin` calls also bring this scroller back.
 *
 * Pass the element via state-tracked callback ref (not a RefObject) so the
 * hook re-runs when the node mounts. `key === null` idles the hook.
 */
export function useScrollMemory(
  el: HTMLElement | null,
  key: string | null,
): void {
  const keyRef = useRef(key);
  const retryRef = useRef<{
    target: number;
    raf: number;
    frames: number;
  } | null>(null);

  const cancelRetry = useCallback(() => {
    if (retryRef.current === null) return;
    cancelAnimationFrame(retryRef.current.raf);
    retryRef.current = null;
  }, []);

  /** Set scrollTop; if the browser clamps it short, keep re-applying on
   *  animation frames while the content grows underneath. */
  const applyWithRetry = useCallback(
    (element: HTMLElement, target: number) => {
      cancelRetry();
      element.scrollTop = target;
      if (element.scrollTop + 1 >= target) return;
      const tick = () => {
        const pending = retryRef.current;
        if (pending === null) return;
        if (pending.frames <= 0) {
          retryRef.current = null;
          return;
        }
        pending.frames -= 1;
        // A frame where the element is detached or display:none'd can't
        // make progress — keep waiting, the budget covers it.
        if (element.isConnected && element.clientHeight > 0) {
          element.scrollTop = pending.target;
          if (element.scrollTop + 1 >= pending.target) {
            retryRef.current = null;
            return;
          }
        }
        pending.raf = requestAnimationFrame(tick);
      };
      retryRef.current = {
        target,
        frames: RESTORE_RETRY_FRAMES,
        raf: requestAnimationFrame(tick),
      };
    },
    [cancelRetry],
  );

  // Save on scroll (muted during restore retries; clamp noise filtered).
  // A user gesture cancels any in-flight retry — the reader taking over
  // mid-load must win against the restoration loop.
  useEffect(() => {
    if (!el) return;
    const onScroll = () => {
      const activeKey = keyRef.current;
      if (activeKey === null) return;
      if (retryRef.current !== null) return;
      if (!el.isConnected || el.clientHeight === 0) return;
      // visibility:hidden retention keeps layout, but a scroll event from a
      // hidden surface can only be programmatic/clamp noise — never save it.
      if (
        typeof el.checkVisibility === "function" &&
        !el.checkVisibility({ visibilityProperty: true })
      ) {
        return;
      }
      saveScrollOffset(activeKey, el.scrollTop);
    };
    const onUserGesture = () => cancelRetry();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onUserGesture, { passive: true });
    el.addEventListener("touchstart", onUserGesture, { passive: true });
    el.addEventListener("pointerdown", onUserGesture, { passive: true });
    el.addEventListener("keydown", onUserGesture);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onUserGesture);
      el.removeEventListener("touchstart", onUserGesture);
      el.removeEventListener("pointerdown", onUserGesture);
      el.removeEventListener("keydown", onUserGesture);
    };
  }, [el, cancelRetry]);

  // Restore on mount / key change — before paint, so the reader never sees
  // the clamped frame. The key ref flips first: any clamp scroll event the
  // browser fires after this commit attributes to the NEW key (and is
  // filtered by the retry mute anyway).
  useLayoutEffect(() => {
    cancelRetry();
    keyRef.current = key;
    if (!el || key === null) return;
    applyWithRetry(el, offsets.get(key) ?? 0);
  }, [el, key, applyWithRetry, cancelRetry]);

  // Reattach registry membership.
  useEffect(() => {
    if (!el) return;
    const unregister = registerScrollRestore(
      el,
      () => {
        const activeKey = keyRef.current;
        if (activeKey === null) return;
        const saved = offsets.get(activeKey);
        if (saved === undefined) return;
        applyWithRetry(el, saved);
      },
      () => {
        const activeKey = keyRef.current;
        if (activeKey === null) return;
        if (!el.isConnected || el.clientHeight === 0) return;
        saveScrollOffset(activeKey, el.scrollTop);
      },
    );
    return () => {
      unregister();
      cancelRetry();
    };
  }, [el, applyWithRetry, cancelRetry]);
}

/** Convenience wrapper: `const ref = useScrollMemoryRef(key)` for surfaces
 *  that don't need the element for anything else. State-tracked (not a
 *  RefObject) so the hook re-runs when the node mounts. */
export function useScrollMemoryRef(
  key: string | null,
): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useScrollMemory(el, key);
  return setEl;
}

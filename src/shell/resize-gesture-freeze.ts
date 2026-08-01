// ──────────────────────────────────────────────────────────
// Gesture-time freeze for retained (hidden) surfaces + iframes
// ──────────────────────────────────────────────────────────
//
// Dragging a seam moves geometry every animation frame. The frame budget must
// go to the surfaces the user is watching — the active transcript re-wrapping,
// the active diff re-virtualizing — and to nothing else. But the app keeps a
// lot of DOM alive invisibly (visibility:hidden retention decks: up to 12
// chats, 6 row-1 tab bodies, 6 diff views, 8 browser iframes, N terminals),
// and visibility:hidden does NOT remove a subtree from layout: every hidden
// diff re-virtualized, every hidden iframe re-laid-out its guest document, on
// every frame of a drag. That — not the visible content — is what made seam
// drags jerky once real work piled up.
//
// The fix: while a continuous layout gesture is active (the shared signal in
// terminal/continuous-layout-resize.ts), every element marked with
// `data-zeros-resize-freeze` is pinned to its pre-gesture border-box size via
// inline width/height. A pinned box never changes size, so nothing inside it
// is invalidated: no layout, no ResizeObserver callbacks, no iframe guest
// reflow — per-frame cost drops to the visible surfaces. Release restores the
// prior inline styles; each thawed subtree lays out ONCE at the final
// geometry, off-screen.
//
// Which elements carry the marker:
//   • Hidden retained layers (the `invisible` deck pattern) — their staleness
//     is invisible by definition. The marker rides the same conditional as
//     `inert`, so an ACTIVE layer is never pinned and tracks the seam live.
//   • Browser iframes, even the visible one — resizing an iframe re-lays-out
//     the embedded document (style, layout, media queries) on every frame,
//     the single most expensive thing a drag can trigger. A frozen iframe
//     clips (shrink) or shows surface background (grow) until release, the
//     same treatment VS Code gives webviews during sash drags.
//
// History (why not the previous width-floor lock): resize-layout-lock.ts used
// to floor `min-width` on the two column BODIES, active content included. On
// the shrinking side the live column clipped its own frozen content at the
// moving seam — the composer's send button cut in half, transcript text
// sliding under column 3 — which read as breakage, while the growing side
// still reflowed at full cost every frame. Freezing only invisible surfaces
// keeps the win without ever clipping something the user can see.
//
// Why not gesture-scoped `content-visibility: hidden` on the hidden layers:
// skipped contents lose live layout, so any programmatic scroll into a hidden
// transcript mid-gesture (a streaming chat's sticky-bottom) would clamp to 0.
// Pinning the box keeps hidden layout fully alive — scroll state, remembered
// content-visibility sizes, xterm grids — just at yesterday's size for the
// few hundred milliseconds the drag lasts.
//
// Kept dependency-light: installed once from main.tsx on the boot path.

import { subscribeContinuousLayoutResize } from "./terminal/continuous-layout-resize";

export const RESIZE_FREEZE_ATTRIBUTE = "data-zeros-resize-freeze" as const;
export const RESIZE_FREEZE_SELECTOR = `[${RESIZE_FREEZE_ATTRIBUTE}]` as const;

interface FreezeSnapshot {
  element: HTMLElement;
  width: number;
  height: number;
  previousWidth: string;
  previousWidthPriority: string;
  previousHeight: string;
  previousHeightPriority: string;
}

/** Factor by which ancestor transforms scale this element on screen —
 * i.e. visual (getBoundingClientRect) size ÷ layout size.
 *
 * Needed because the pin is written as inline layout width/height, but the
 * rect is the post-transform visual box. The browser iframe sits under the
 * canvas-mode wrapper's `transform: scale(zoom)` (browser-tab.tsx), where
 * zoom is routinely < 1, so pinning the raw rect would shrink the iframe to
 * zoom×layout for the whole drag — a real resize plus two guest-document
 * relayouts, the exact cost the freeze exists to avoid.
 *
 * Computed transforms resolve to matrix()/matrix3d(); the axis scale is the
 * length of the corresponding basis column, which also stays correct if a
 * rotation is composed in. The individual `scale` property composes outside
 * `transform`, so it is read separately. Environments without a view (the
 * node-env unit-test fakes) report 1. */
function accumulatedAncestorScale(element: HTMLElement): {
  x: number;
  y: number;
} {
  const view = element.ownerDocument?.defaultView;
  if (!view) return { x: 1, y: 1 };
  let x = 1;
  let y = 1;
  for (
    let node: HTMLElement | null = element;
    node;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    const transform = style.transform;
    if (transform && transform !== "none") {
      const values = transform
        .slice(transform.indexOf("(") + 1, transform.indexOf(")"))
        .split(",")
        .map((part) => Number.parseFloat(part));
      if (transform.startsWith("matrix3d")) {
        x *= Math.hypot(values[0], values[1], values[2]);
        y *= Math.hypot(values[4], values[5], values[6]);
      } else if (transform.startsWith("matrix")) {
        x *= Math.hypot(values[0], values[1]);
        y *= Math.hypot(values[2], values[3]);
      }
    }
    const scale = style.scale;
    if (scale && scale !== "none") {
      const parts = scale.split(" ").map((part) => Number.parseFloat(part));
      x *= parts[0];
      y *= parts[1] ?? parts[0];
    }
  }
  return { x, y };
}

/** Pin every marked element at its current border-box LAYOUT size — the
 * measured rect normalized by the accumulated ancestor transform scale, so
 * the pin is a true no-op under the zoomed browser canvas. Normalizing the
 * rect (rather than reading offsetWidth/offsetHeight) keeps sub-pixel
 * precision: offset* rounds to integers, which would un-pin every
 * fractional-sized hidden layer by up to half a pixel and re-trigger the
 * relayouts the freeze exists to avoid.
 *
 * All geometry is read before the first style write so starting a gesture
 * causes at most one layout flush rather than alternating read/write per
 * surface. Zero-size elements (a collapsed panel's 0-height body, a
 * display:none subtree) are skipped: there is nothing to pin, and pinning
 * 0 would keep a surface revealed mid-gesture invisible until release.
 * A scale of 0 (an ancestor animating through scale(0)) makes the size
 * non-finite and is skipped the same way.
 * The returned release is idempotent because pointerup and
 * lostpointercapture can race. */
export function freezeResizeFreezeTargets(root: ParentNode): () => void {
  const elements = Array.from(
    root.querySelectorAll<HTMLElement>(RESIZE_FREEZE_SELECTOR),
  );
  const snapshots: FreezeSnapshot[] = [];

  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    const scale = accumulatedAncestorScale(element);
    const width = rect.width / scale.x;
    const height = rect.height / scale.y;
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      continue;
    }
    snapshots.push({
      element,
      width,
      height,
      previousWidth: element.style.getPropertyValue("width"),
      previousWidthPriority: element.style.getPropertyPriority("width"),
      previousHeight: element.style.getPropertyValue("height"),
      previousHeightPriority: element.style.getPropertyPriority("height"),
    });
  }

  for (const { element, width, height } of snapshots) {
    // Inline width/height beat the `inset-0` / `size-full` classes these
    // layers use. On an absolutely-positioned box the over-constrained
    // right/bottom legs are ignored, so the box stays anchored top-left and
    // simply stops following the container — the ancestor's overflow clips
    // the frozen area, exactly like the retained decks already clip.
    element.style.setProperty("width", `${width}px`);
    element.style.setProperty("height", `${height}px`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const {
      element,
      previousWidth,
      previousWidthPriority,
      previousHeight,
      previousHeightPriority,
    } of snapshots) {
      if (previousWidth) {
        element.style.setProperty(
          "width",
          previousWidth,
          previousWidthPriority,
        );
      } else {
        element.style.removeProperty("width");
      }
      if (previousHeight) {
        element.style.setProperty(
          "height",
          previousHeight,
          previousHeightPriority,
        );
      } else {
        element.style.removeProperty("height");
      }
    }
  };
}

let installedDispose: (() => void) | null = null;

/** Wire the freeze to the shared continuous-gesture signal. Idempotent —
 *  repeat calls (HMR re-imports) return the existing installation's dispose.
 *  Every seam already brackets its drag with beginContinuousLayoutResize(),
 *  so installing once covers the column seam, the terminal-panel seam, the
 *  split-pane seams, and the sidebar seams without per-seam code.
 *
 *  `root` defaults to the document and is injectable for the node-env unit
 *  tests (repo convention — no jsdom). */
export function installResizeGestureFreeze(
  root: ParentNode | null = typeof document === "undefined" ? null : document,
): () => void {
  if (!root) return () => {};
  if (installedDispose) return installedDispose;

  let release: (() => void) | null = null;
  const unsubscribe = subscribeContinuousLayoutResize((active) => {
    if (active) {
      // The signal publishes only on the OUTERMOST begin, but stay defensive:
      // a stale release here would restore mid-gesture styles too early.
      release?.();
      release = freezeResizeFreezeTargets(root);
      return;
    }
    release?.();
    release = null;
  });

  installedDispose = () => {
    unsubscribe();
    release?.();
    release = null;
    installedDispose = null;
  };
  return installedDispose;
}

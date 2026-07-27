// ──────────────────────────────────────────────────────────
// Sticky tab strip — shared scroll/pin/fade machinery
// ──────────────────────────────────────────────────────────
//
// The DOM half of the sticky-active-tab pattern the top-bar workspace
// strip and the column-2 chat strip each carry a private copy of
// (top-bar.tsx / column2-chat-tabs.tsx; the pure math already lives in
// top-bar-helpers.ts). Extracted so column 3's two tab rows don't
// become a third and fourth copy. New strips should use this hook;
// the two original strips are candidates to migrate here later.
//
// Behavior contract (identical to the originals):
//
//   - The strip scrolls horizontally with a hidden scrollbar; the
//     ACTIVE tab is CSS-sticky and pins to whichever edge it reaches.
//   - Overflow fades appear at edges that still hide content. When the
//     active tab pins to an edge, that edge's fade relocates to the
//     tab's inside edge so the pinned pill never fades itself.
//   - Fades are updated synchronously on scroll via direct style
//     writes (no React render) so they stay compositor-synced during
//     a trackpad fling.
//   - Native :hover can stay glued to whatever was under a stationary
//     cursor while the strip scrolls beneath it. Every scroll re-hit-
//     tests the stored pointer position and drives a single explicit
//     `data-hovered` target instead — tabs must style hover off
//     `data-[hovered=true]` (and `group-data-[hovered=true]/…`), not
//     `:hover`.
//   - A `resetKey` change (workspace/folder switch) restarts the strip
//     at the leading edge before paint.
//   - An externally activated tab is revealed by its NATURAL flow slot
//     (scrollIntoView would inspect the sticky visual box and no-op).
//
// Geometry contract the caller must uphold:
//
//   - Viewport wrapper: `relative overflow-hidden` (STICKY_TAB_VIEWPORT_CLS),
//     no horizontal padding — the fade placement math assumes the
//     wrapper and the scroller share an origin and width.
//   - Scroller (`navRef` + `navProps`): STICKY_TAB_NAV_CLS.
//   - Inner lane: STICKY_TAB_ROW_CLS — `relative` (it is the tabs'
//     offsetParent), `gap-1 px-1` matching TAB_GAP_PX/CONTENT_INSET_PX.
//   - Each tab element: `<tabAttr>="true"`, registered via
//     `registerTab`, and `sticky left-1 right-1 z-20` while active
//     (matching EDGE_INSET_PX) with an opaque active fill.
//   - `<StickyTabStripFades …/>` rendered as the wrapper's last child.

import React, { useCallback, useLayoutEffect, useRef } from "react";

import {
  horizontalOverflow,
  workspaceFadeVisibility as stickyFadeVisibility,
  workspacePinSide as stickyPinSide,
  workspaceScrollLeftForTab as scrollLeftForStickyTab,
} from "./top-bar-helpers";

// ── Shared strip classes ─────────────────────────────────

/** The clipping wrapper the fades are positioned against. `shrink` (without
 *  flex-1) lets the lane shrink-wrap its tabs so a trailing "+" control hugs
 *  the last tab until the row fills. */
export const STICKY_TAB_VIEWPORT_CLS =
  "relative h-full min-w-0 shrink overflow-hidden";

export const STICKY_TAB_NAV_CLS =
  "h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/** The scrollable lane. `relative` makes it the tabs' offsetParent (the
 *  natural-offset math reads sibling offsetLefts in lane coordinates); the
 *  4px gutter and gap match CONTENT_INSET_PX / TAB_GAP_PX below. */
export const STICKY_TAB_ROW_CLS =
  "relative flex h-full w-max items-center gap-1 px-1";

// ── Geometry constants (mirror the strip classes above) ──

/** The lane's px-1 gutter — the first tab's natural offset. */
const CONTENT_INSET_PX = 4;
/** The active tab's sticky inset — keep in sync with `left-1 right-1`. */
const EDGE_INSET_PX = 4;
/** The lane's gap-1 between tabs. */
const TAB_GAP_PX = 4;
/** The w-6 fade gradients rendered by StickyTabStripFades. */
const FADE_WIDTH_PX = 24;

function setFadeVisible(fade: HTMLDivElement | null, visible: boolean): void {
  if (!fade) return;
  const opacity = visible ? "1" : "0";
  if (fade.style.opacity !== opacity) fade.style.opacity = opacity;
}

function placeFade(
  fade: HTMLDivElement | null,
  visible: boolean,
  left: number,
): void {
  if (!fade) return;
  const transform = `translate3d(${left}px, 0, 0)`;
  if (fade.style.transform !== transform) fade.style.transform = transform;
  setFadeVisible(fade, visible);
}

// ── Hook ─────────────────────────────────────────────────

export interface StickyTabStripFadeRefs {
  outerLeft: React.MutableRefObject<HTMLDivElement | null>;
  outerRight: React.MutableRefObject<HTMLDivElement | null>;
  afterPinnedLeft: React.MutableRefObject<HTMLDivElement | null>;
  beforePinnedRight: React.MutableRefObject<HTMLDivElement | null>;
}

export interface StickyTabStripNavProps {
  onScroll: () => void;
  onPointerEnter: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onWheelCapture: (event: React.WheelEvent<HTMLDivElement>) => void;
}

export interface StickyTabStrip {
  navRef: React.MutableRefObject<HTMLDivElement | null>;
  /** Attach on the scroller element alongside navRef. */
  navProps: StickyTabStripNavProps;
  /** Register each tab element under its key (call with null on unmount). */
  registerTab: (key: string, node: HTMLDivElement | null) => void;
  /** Attach to StickyTabStripFades inside the viewport wrapper. */
  fadeRefs: StickyTabStripFadeRefs;
}

export function useStickyTabStrip(args: {
  /** Key of the tab that pins and gets revealed; null disables both (no
   *  selection shown — e.g. the collapsed terminal panel). */
  activeKey: string | null;
  /** Strip identity. A change restarts the scroll at the leading edge before
   *  the reveal effect brings the active tab back into view. */
  resetKey: string;
  /** Re-measures fades and re-reveals the active tab when it changes. */
  tabCount: number;
  /** data-* attribute (set to "true") marking this strip's tab elements. */
  tabAttr: `data-${string}`;
}): StickyTabStrip {
  const { activeKey, resetKey, tabCount, tabAttr } = args;

  const navRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const outerLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const outerRightFadeRef = useRef<HTMLDivElement | null>(null);
  const afterPinnedLeftFadeRef = useRef<HTMLDivElement | null>(null);
  const beforePinnedRightFadeRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const hoveredTabRef = useRef<HTMLElement | null>(null);

  const registerTab = useCallback(
    (key: string, node: HTMLDivElement | null) => {
      if (node) tabRefs.current.set(key, node);
      else tabRefs.current.delete(key);
    },
    [],
  );

  /** Chromium reports a sticky tab's clamped offsetLeft. Its preceding
   *  regular tab still exposes the active tab's natural flow position. */
  const naturalOffsetLeft = useCallback(
    (tab: HTMLDivElement): number => {
      let sibling = tab.previousElementSibling;
      while (sibling) {
        if (
          sibling instanceof HTMLElement &&
          sibling.matches(`[${tabAttr}="true"]`)
        ) {
          return sibling.offsetLeft + sibling.offsetWidth + TAB_GAP_PX;
        }
        sibling = sibling.previousElementSibling;
      }
      return CONTENT_INSET_PX;
    },
    [tabAttr],
  );

  const setHoveredTab = useCallback((nextTab: HTMLElement | null) => {
    const currentTab = hoveredTabRef.current;
    if (currentTab === nextTab) return;
    currentTab?.removeAttribute("data-hovered");
    if (nextTab) nextTab.dataset.hovered = "true";
    hoveredTabRef.current = nextTab;
  }, []);

  /** Re-hit-test the stored viewport coordinate on every scroll event so
   *  hover follows the visible tab synchronously, without a React render. */
  const retargetHover = useCallback(() => {
    const nav = navRef.current;
    const pointer = pointerRef.current;
    if (!nav || !pointer) {
      setHoveredTab(null);
      return;
    }

    const navRect = nav.getBoundingClientRect();
    const insideHoverArea =
      pointer.clientX >= navRect.left + EDGE_INSET_PX &&
      pointer.clientX < navRect.right - EDGE_INSET_PX &&
      pointer.clientY >= navRect.top &&
      pointer.clientY < navRect.bottom;
    if (!insideHoverArea) {
      setHoveredTab(null);
      return;
    }

    const hit = document.elementFromPoint(pointer.clientX, pointer.clientY);
    const candidate = hit?.closest(`[${tabAttr}="true"]`) ?? null;
    setHoveredTab(
      candidate instanceof HTMLElement && nav.contains(candidate)
        ? candidate
        : null,
    );
  }, [setHoveredTab, tabAttr]);

  const measureStrip = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;

    const overflow = horizontalOverflow({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
    });
    const activeTab = activeKey ? tabRefs.current.get(activeKey) : null;
    const activeTabWidth = activeTab?.offsetWidth ?? 0;
    const pinSide = activeTab
      ? stickyPinSide({
          scrollLeft: nav.scrollLeft,
          scrollWidth: nav.scrollWidth,
          clientWidth: nav.clientWidth,
          tabOffsetLeft: naturalOffsetLeft(activeTab),
          tabWidth: activeTabWidth,
          edgeInset: EDGE_INSET_PX,
        })
      : null;
    const fades = stickyFadeVisibility(overflow, pinSide);

    setFadeVisible(outerLeftFadeRef.current, fades.outerLeft);
    setFadeVisible(outerRightFadeRef.current, fades.outerRight);
    placeFade(
      afterPinnedLeftFadeRef.current,
      fades.afterPinnedLeft,
      EDGE_INSET_PX + activeTabWidth,
    );
    placeFade(
      beforePinnedRightFadeRef.current,
      fades.beforePinnedRight,
      Math.max(
        0,
        nav.clientWidth - EDGE_INSET_PX - activeTabWidth - FADE_WIDTH_PX,
      ),
    );
  }, [activeKey, naturalOffsetLeft]);

  const syncStrip = useCallback(() => {
    measureStrip();
    retargetHover();
  }, [measureStrip, retargetHover]);

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "touch") {
        pointerRef.current = null;
        setHoveredTab(null);
        return;
      }
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      retargetHover();
    },
    [retargetHover, setHoveredTab],
  );

  /** Wheel/trackpad events carry viewport coordinates and can be the first
   *  input observed when the pointer was already resting over the strip. */
  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      retargetHover();
    },
    [retargetHover],
  );

  const clearPointer = useCallback(() => {
    pointerRef.current = null;
    setHoveredTab(null);
  }, [setHoveredTab]);

  // Each resetKey owns an independent logical tab list. Start a newly shown
  // one at the leading edge before the reveal effect below runs (layout
  // effects run in declaration order).
  useLayoutEffect(() => {
    if (navRef.current) navRef.current.scrollLeft = 0;
  }, [resetKey]);

  // Track responsive viewport changes and content-width changes (renames,
  // badge/glyph swaps, newly-created or closed tabs).
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    syncStrip();
    const frame = window.requestAnimationFrame(syncStrip);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(syncStrip);
    observer?.observe(nav);
    if (nav.firstElementChild) observer?.observe(nav.firstElementChild);
    window.addEventListener("resize", syncStrip);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", syncStrip);
    };
  }, [resetKey, tabCount, syncStrip]);

  // Reveal an externally selected/new tab by its NATURAL flow slot.
  // scrollIntoView sees the sticky visual box and can incorrectly no-op.
  useLayoutEffect(() => {
    if (!activeKey) return;
    const nav = navRef.current;
    const activeTab = tabRefs.current.get(activeKey);
    if (!nav || !activeTab) return;
    const targetScrollLeft = scrollLeftForStickyTab({
      scrollLeft: nav.scrollLeft,
      scrollWidth: nav.scrollWidth,
      clientWidth: nav.clientWidth,
      tabOffsetLeft: naturalOffsetLeft(activeTab),
      tabWidth: activeTab.offsetWidth,
      edgeInset: CONTENT_INSET_PX,
    });
    if (Math.abs(nav.scrollLeft - targetScrollLeft) > 0.5) {
      nav.scrollLeft = targetScrollLeft;
    }
    syncStrip();
  }, [activeKey, resetKey, tabCount, naturalOffsetLeft, syncStrip]);

  return {
    navRef,
    navProps: {
      onScroll: syncStrip,
      onPointerEnter: handlePointer,
      onPointerMove: handlePointer,
      onPointerLeave: clearPointer,
      onPointerCancel: clearPointer,
      onWheelCapture: handleWheel,
    },
    registerTab,
    fadeRefs: {
      outerLeft: outerLeftFadeRef,
      outerRight: outerRightFadeRef,
      afterPinnedLeft: afterPinnedLeftFadeRef,
      beforePinnedRight: beforePinnedRightFadeRef,
    },
  };
}

// ── Fades + gutters overlay ──────────────────────────────

/** The four fades and two solid gutters, rendered as the LAST children of the
 *  viewport wrapper. The active tab (z-20) sits above the fades (z-10); when
 *  pinned, its edge fade relocates beside the tab. The solid four-pixel
 *  gutters (z-30) preserve the lane's edge spacing while preventing scrolled
 *  labels from leaking through it. Both column-3 rows sit on bg1; a future
 *  strip on another surface can pass its own gradient/surface classes. */
export function StickyTabStripFades({
  fades,
  fromClass = "from-bg1",
  surfaceClass = "bg-bg1",
}: {
  fades: StickyTabStripFadeRefs;
  fromClass?: string;
  surfaceClass?: string;
}) {
  return (
    <>
      <div
        ref={fades.outerLeft}
        className={`${fromClass} pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r to-transparent opacity-0`}
        aria-hidden="true"
      />
      <div
        ref={fades.outerRight}
        className={`${fromClass} pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l to-transparent opacity-0`}
        aria-hidden="true"
      />
      <div
        ref={fades.afterPinnedLeft}
        className={`${fromClass} pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r to-transparent opacity-0 will-change-transform`}
        aria-hidden="true"
      />
      <div
        ref={fades.beforePinnedRight}
        className={`${fromClass} pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-l to-transparent opacity-0 will-change-transform`}
        aria-hidden="true"
      />
      <div
        className={`${surfaceClass} pointer-events-none absolute inset-y-0 left-0 z-30 w-1`}
        aria-hidden="true"
      />
      <div
        className={`${surfaceClass} pointer-events-none absolute inset-y-0 right-0 z-30 w-1`}
        aria-hidden="true"
      />
    </>
  );
}

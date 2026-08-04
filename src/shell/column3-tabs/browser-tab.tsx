// ──────────────────────────────────────────────────────────
// Browser Tab — Cursor-style embedded browser chrome
// ──────────────────────────────────────────────────────────
//
// Roadmap 03b Phase 3 (Phase 4.7 iframe migration). A browser
// pane inside a column-3 tab. The visible tree: chrome
// (back/forward/reload + URL omnibox + Design Mode toggle + ⋯
// menu) over an `<iframe>` element. CSS positions the iframe;
// useIframeWebview drives src updates declaratively. No main-
// process bounds plumbing, no native overlay.
//
// Per-tab state:
//   - `tab.url`   — last navigated URL (persisted)
//   - `tab.title` — page title (persisted; cross-origin pages
//     fall back to URL slug since contentDocument is unreadable)
//
// Acceptance (from roadmap):
//   - Type a URL, hit Enter → loads
//   - Back / forward / reload buttons work
//   - URL bar tracks internal navigation
//   - ⋯ menu: Hard Reload + Clear Cache + Clear Cookies via IPC

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal, MousePointer2, Palette, RotateCw, Globe, GitFork, X } from "lucide-react";
import {
  useIframeWebview,
  type SelectedElement,
} from "../../zeros/browser/use-iframe-webview";
import { BrowserVariantFrame } from "../../zeros/browser/browser-variant-frame";
import {
  CanvasKnobHandles,
  type CanvasKnobAxis,
} from "../../zeros/browser/canvas-knob-handles";
import {
  BROWSER_VARIANT_GAP_PX,
  BROWSER_VARIANT_MIN_HEIGHT,
  BROWSER_VARIANT_MIN_WIDTH,
  browserCanvasStripWidth,
  type BrowserTabVariant,
  variantNeedsLiveLayer,
} from "../../zeros/browser/variant-types";
import { applyForkManifestFields } from "../../zeros/browser/variant-artifact";
import {
  useWorkspaceStore,
  useWorkspaceDispatch,
  type PendingChatSubmission,
  type PendingComposerAppend,
} from "../../zeros/store/store";
import { useNativeRuntime } from "../../native/runtime";
import {
  BROWSER_DEFAULT_HEIGHT,
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MIN_HEIGHT,
  BROWSER_MIN_WIDTH,
  BROWSER_VIEWPORT_PRESETS,
  type Column3Tab,
} from "../column3-tab-manager";
import { Button } from "../../zeros/ui";
import { isLoopbackUrl, normalizeBrowserUrl } from "./localhost-url";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
} from "../../zeros/ui/primitives";
import { toast } from "../../zeros/ui/primitives/elements";
import { ZerosSpinner } from "@/loaders";
import type { ComposerAttachment } from "@/zeros/agent/composer-attachments";

// URL normalization lives in ./localhost-url. Browser navigation accepts
// ordinary http(s) sites; Design/Canvas are gated separately to loopback URLs.

const EMPTY_BROWSER_VARIANTS: BrowserTabVariant[] = [];

// ── Component ─────────────────────────────────────────────

interface BrowserTabProps {
  tab: Column3Tab;
  active: boolean;
  /** Persisted column-3 scope; required when this iframe is retained while a
   * different workspace is active. */
  scope?: string;
}

export function BrowserTab({ tab, active, scope }: BrowserTabProps) {
  const dispatch = useWorkspaceDispatch();
  const updateTab = useCallback(
    (updates: Partial<Omit<Column3Tab, "id" | "type">>) => {
      dispatch({ type: "UPDATE_COLUMN3_TAB", id: tab.id, scope, updates });
    },
    [dispatch, scope, tab.id],
  );
  // 2026-05-23: switched to the reactive hook so a late-arriving
  // preload bridge (build race / HMR refresh / stale dist-electron)
  // unblocks the URL bar without a manual reload.
  const electron = useNativeRuntime().ready;
  // Body is a plain <iframe>. CSS handles visibility (display:none
  // for inactive tabs preserves history + scroll + JS heap). Design
  // Mode picker is auto-injected by main on did-frame-finish-load
  // and controlled via postMessage; only the chip's element
  // thumbnail capture takes an IPC hop. See use-iframe-webview.ts.
  // Persisted URLs are still treated as untrusted input: only canonical http(s)
  // pages are restored. External http(s) sites are valid browser content.
  const safeTabUrl = normalizeBrowserUrl(tab.url ?? "") ?? "";
  const frameName = `zeros-browser-${tab.id}`;
  const webview = useIframeWebview({
    initialUrl: safeTabUrl,
    frameName,
  });
  const effectiveUrl = webview.state.currentUrl || safeTabUrl;
  const localToolsEnabled = isLoopbackUrl(effectiveUrl);
  const chipVisible = localToolsEnabled && webview.selectedElements.length > 0;
  const designModeActive = webview.designModeActive;
  const setWebviewDesignMode = webview.setDesignMode;

  // Mirror iframe picker selection to workspace store for MCP + @selection.
  useEffect(() => {
    if (!active || !localToolsEnabled) return;
    const primary = webview.selectedElements[0];
    if (!primary) {
      dispatch({ type: "SET_BROWSER_PICKER_SELECTION", selection: null });
    } else {
      dispatch({
        type: "SET_BROWSER_PICKER_SELECTION",
        selection: {
          selector: primary.selector,
          tag: primary.tag,
          componentName: primary.componentName,
          styles: primary.styles,
        },
      });
    }
    // Switching to another Browser/File/system tab must not leave a stale
    // element globally available to @selection or MCP consumers.
    return () => {
      dispatch({ type: "SET_BROWSER_PICKER_SELECTION", selection: null });
    };
  }, [active, localToolsEnabled, webview.selectedElements, dispatch]);

  // Leaving loopback immediately exits both local-only modes. Persisting Canvas
  // off prevents an external page from retaining an invisible canvas state that
  // unexpectedly reappears on a later localhost navigation.
  useEffect(() => {
    if (localToolsEnabled) return;
    if (designModeActive) setWebviewDesignMode(false);
    if (tab.canvasMode) {
      updateTab({ canvasMode: false });
    }
  }, [
    localToolsEnabled,
    designModeActive,
    setWebviewDesignMode,
    tab.canvasMode,
    updateTab,
  ]);

  // ── ⌥+click direct-to-composer (Phase 4.5) ───────────────
  //
  // The preload sets `altKey=true` when the user holds Option while
  // clicking. The hook routes those to a separate one-shot slot
  // (`altClickedElement`) instead of the multi-select array — so
  // ⌥+click never opens the chip. We consume the slot here: format
  // the element context as a short single-line block and append it
  // to the active chat's composer via pendingComposerAppend.
  // AgentChat picks that up (see agent-chat.tsx) and merges into
  // its local input state — the user can keep typing around the
  // inserted block before submitting.
  // No active chat → toast. Cursor parity: never silently spawn one.
  useEffect(() => {
    if (!active) return;
    const el = webview.altClickedElement;
    if (!el) return;
    if (!localToolsEnabled) {
      webview.clearAltClickedElement();
      return;
    }
    const activeChatId = useWorkspaceStore.getState().activeChatId;
    if (!activeChatId) {
      toast.error("No active chat to append this element to.", {
        description: "Open or create a chat first.",
      });
      webview.clearAltClickedElement();
      return;
    }
    const append: PendingComposerAppend = {
      id: `elemAppend-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: formatElementForComposer(el, effectiveUrl),
      chatId: activeChatId,
      source: "element-picker",
    };
    dispatch({ type: "ENQUEUE_COMPOSER_APPEND", append });
    webview.clearAltClickedElement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, webview.altClickedElement]);

  // ── Persist URL + title back to the tab ──────────────────
  // The webview drives canonical state (final URL after redirects,
  // page title once <title> resolves). Mirror to the tab so the
  // tab strip label updates and a reload restores the right URL.
  useEffect(() => {
    const url = webview.state.currentUrl;
    if (!webview.state.isLoading && url && url !== tab.url) {
      updateTab({ url });
    }
  }, [
    webview.state.currentUrl,
    webview.state.isLoading,
    tab.url,
    updateTab,
  ]);

  useEffect(() => {
    const t = webview.state.title;
    if (!webview.state.isLoading && t && t !== tab.title) {
      updateTab({ title: t });
    }
  }, [
    webview.state.title,
    webview.state.isLoading,
    tab.title,
    updateTab,
  ]);

  // ── ⌘+Shift+D global shortcut ────────────────────────────
  //
  // Two listening paths because the keystroke can land in either
  // context:
  //   (1) DOM-level keydown on `window` — fires when focus is in
  //       the React renderer (chrome row, URL bar, tab strip).
  //       Only active tab listens; inactive ones bail.
  //   (2) Picker-forwarded postMessage — when focus is inside the
  //       iframe, our picker script intercepts ⌘+Shift+D and posts
  //       `zeros:picker:toggle-request` to the parent. The hook
  //       turns that into setDesignModeActive toggle (see
  //       use-iframe-webview.ts). Only the tab whose iframe sent
  //       the message gets the toggle, since each tab's hook has
  //       its own message listener scoped to its iframe.
  useEffect(() => {
    if (!active || !localToolsEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.code === "KeyD") {
        e.preventDefault();
        webview.setDesignMode(!webview.designModeActive);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, localToolsEnabled, webview]);

  // ── Escape exits Design Mode (renderer-side) ─────────────
  //
  // Two-layer Escape per user request:
  //   1st Escape → dismiss chip (handled by ElementChip's own
  //      keydown listener; stops propagation so this handler
  //      doesn't fire)
  //   2nd Escape → exit Design Mode (this handler)
  //
  // The picker also handles Escape inside the iframe and posts
  // `zeros:picker:exited` which flips designModeActive in the
  // hook. This handler covers the case where focus is in the
  // React shell (e.g., after the chip dismisses, focus may settle
  // on body before the user clicks back into the page).
  useEffect(() => {
    if (!active || !localToolsEnabled || !webview.designModeActive) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ElementChip stops propagation on its own Escape, so if
        // this fires the chip is already gone (or was never up).
        e.preventDefault();
        webview.setDesignMode(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, localToolsEnabled, webview.designModeActive, webview]);

  const hasUrl = Boolean(webview.state.currentUrl || safeTabUrl);

  // ── Canvas mode (Phase 5) ───────────────────────────────
  //
  // Canvas mode (Palette button in chrome / ⌘\) reframes the
  // body so the iframe becomes a centered resizable "frame"
  // inside a scrollable area, with viewport presets on the
  // right column edge and a height-reset indicator below.
  // In fill mode (default) the iframe edges = column edges as
  // before.
  //
  // Important: the iframe element must stay mounted across
  // mode toggles. We achieve that by always rendering the
  // <iframe> in the same JSX position, and only changing
  // wrapper className/style based on mode. The chip is also
  // a sibling of the iframe inside the same wrapper so its
  // click-coord-based positioning stays correct in both modes.
  const canvasMode = localToolsEnabled && (tab.canvasMode ?? false);
  const persistedW = tab.viewportWidth ?? BROWSER_DEFAULT_WIDTH;
  const persistedH = tab.viewportHeight ?? BROWSER_DEFAULT_HEIGHT;
  // Drag state — live dims during a pointer drag for smooth
  // updates without per-move dispatch. On pointerup we persist
  // via UPDATE_COLUMN3_TAB. While not dragging this is null and
  // we read straight from the tab record.
  const [dragDims, setDragDims] = useState<{
    w: number;
    h: number;
    axis: CanvasKnobAxis;
  } | null>(null);
  const effW = dragDims?.w ?? persistedW;
  const effH = dragDims?.h ?? persistedH;
  const isResizing = dragDims !== null;

  const persistViewport = useCallback(
    (w: number, h: number) => {
      updateTab({ viewportWidth: w, viewportHeight: h });
    },
    [updateTab],
  );

  // ── Infinite canvas viewport (Phase 5.2) ────────────────
  //
  // Figma-style controls on top of an infinite canvas. State:
  //   - `canvasViewport.x/y` translates the frame in screen px
  //   - `canvasViewport.zoom` scales it (0.2–2)
  //
  // Pan: Space + drag (window-level keydown tracking + pointer
  // capture on the canvas body). Zoom: ⌘/Ctrl + wheel, anchored
  // at the cursor so the point under the cursor stays fixed.
  // Frame canvas position is always (0, 0); on every transition
  // into canvas mode the viewport is reset to center the frame
  // at zoom 1. We don't persist pan/zoom — width/height of the
  // frame already persist, which is what the user asked for.
  const [canvasViewport, setCanvasViewport] = useState({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const canvasBodyRef = useRef<HTMLDivElement>(null);
  // viewport.zoom snapshot at resize-drag start. Pointer deltas
  // are in screen px; logical (frame) deltas are screen / zoom.
  const dragZoomRef = useRef(1);

  const startResize = useCallback(
    (e: React.PointerEvent, axis: CanvasKnobAxis, handle: HTMLElement) => {
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = effW;
      const startH = effH;
      const zoom = canvasViewport.zoom;
      dragZoomRef.current = zoom;
      let lastW = startW;
      let lastH = startH;
      setDragDims({ w: startW, h: startH, axis });

      const onMove = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / zoom;
        const dy = (ev.clientY - startY) / zoom;
        let newW = startW;
        let newH = startH;
        if (axis === "right") newW = startW + dx;
        if (axis === "left") newW = startW - dx;
        if (axis === "bottom") newH = startH + dy;
        lastW = Math.max(BROWSER_MIN_WIDTH, Math.round(newW));
        lastH = Math.max(BROWSER_MIN_HEIGHT, Math.round(newH));
        setDragDims({ w: lastW, h: lastH, axis });
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setDragDims(null);
        persistViewport(lastW, lastH);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [effW, effH, persistViewport, canvasViewport.zoom],
  );

  // Center the frame in the visible canvas area and auto-fit the
  // zoom so both the frame AND the preset rail (which sits to the
  // right of the frame, also inside the wrapper so it pans/zooms
  // with the frame) are visible. We never zoom in past 1; only
  // zoom out when the natural-size frame would overflow.
  const centerFrame = useCallback(() => {
    const el = canvasBodyRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const PADDING = 40;
    const variants = tab.variants ?? EMPTY_BROWSER_VARIANTS;
    const totalW = browserCanvasStripWidth(effW, variants);
    const totalH = effH;
    const zoomW = (rect.width - PADDING * 2) / totalW;
    const zoomH = (rect.height - PADDING * 2) / totalH;
    const zoom = Math.max(0.2, Math.min(1, zoomW, zoomH));
    const x = (rect.width - totalW * zoom) / 2;
    const y = (rect.height - effH * zoom) / 2;
    setCanvasViewport({ x, y, zoom });
  }, [effW, effH, tab.variants]);

  // Snap-center on every canvas-mode entry. We watch canvasMode
  // directly; the ref-guard ensures we don't re-center mid-session
  // when the user has pan/zoomed elsewhere (only on the false →
  // true transition).
  const wasCanvasModeRef = useRef(false);
  useEffect(() => {
    // A retained browser can first mount while its workspace is hidden. Wait
    // until it has real layout bounds before calculating the initial framing.
    if (!active) return;
    if (canvasMode && !wasCanvasModeRef.current) {
      // Defer one tick so the canvas body has its layout rect.
      const t = window.setTimeout(centerFrame, 0);
      wasCanvasModeRef.current = true;
      return () => window.clearTimeout(t);
    }
    if (!canvasMode) {
      wasCanvasModeRef.current = false;
    }
  }, [active, canvasMode, centerFrame]);

  // Space-key tracking — only when this tab is active AND canvas
  // mode is on, so we don't fight global app shortcuts.
  useEffect(() => {
    if (!active || !canvasMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't hijack space when the user is typing in the URL bar
      // or any input. matches() lets us check by tag.
      const t = e.target as HTMLElement | null;
      if (t && t.matches("input, textarea, [contenteditable]")) return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [active, canvasMode]);

  // Wheel listener for ⌘/Ctrl + wheel zoom. Plain wheel passes
  // through so the iframe content still scrolls normally when
  // the cursor is over it.
  useEffect(() => {
    if (!active || !canvasMode) return;
    const el = canvasBodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setCanvasViewport((v) => {
        // Anchor zoom at cursor: keep the logical point under the
        // cursor at the same screen position before and after.
        const delta = -e.deltaY * 0.005;
        const newZoom = Math.max(0.2, Math.min(2, v.zoom * (1 + delta)));
        if (newZoom === v.zoom) return v;
        const k = newZoom / v.zoom;
        return {
          x: cx - (cx - v.x) * k,
          y: cy - (cy - v.y) * k,
          zoom: newZoom,
        };
      });
    };
    // passive:false is required to call preventDefault on wheel
    // in modern browsers.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [active, canvasMode]);

  // Space + drag = pan. Attached to the canvas body so any
  // pointer-down in the body (over the frame, the background,
  // or empty space) starts a pan when space is held.
  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!spaceHeld) return;
      const hit = e.target as HTMLElement;
      if (
        hit.closest(
          "[data-zeros-browser-variant], [data-zeros-canvas-chrome], [data-zeros-element-chip]",
        )
      ) {
        return;
      }
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      setIsPanning(true);
      const startX = e.clientX;
      const startY = e.clientY;
      const startVX = canvasViewport.x;
      const startVY = canvasViewport.y;
      const onMove = (ev: PointerEvent) => {
        setCanvasViewport((v) => ({
          ...v,
          x: startVX + (ev.clientX - startX),
          y: startVY + (ev.clientY - startY),
        }));
      };
      const onUp = () => {
        target.releasePointerCapture(e.pointerId);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
        setIsPanning(false);
      };
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
    },
    [spaceHeld, canvasViewport.x, canvasViewport.y],
  );

  // ── ⌘+\ — toggle canvas mode (Phase 5) ──────────────────
  useEffect(() => {
    if (!active || !localToolsEnabled) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        updateTab({ canvasMode: !canvasMode });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, localToolsEnabled, canvasMode, updateTab]);

  const setCanvasMode = useCallback(
    (next: boolean) => {
      updateTab({ canvasMode: next });
    },
    [updateTab],
  );

  const applyPresetWidth = useCallback(
    (width: number) => {
      persistViewport(width, persistedH);
    },
    [persistViewport, persistedH],
  );

  const resetHeight = useCallback(() => {
    persistViewport(persistedW, BROWSER_DEFAULT_HEIGHT);
  }, [persistViewport, persistedW]);

  const tabVariants = tab.variants ?? EMPTY_BROWSER_VARIANTS;

  const deleteVariant = useCallback(
    (variantId: string) => {
      updateTab({
        variants: tabVariants.filter((v) => v.id !== variantId),
      });
    },
    [tabVariants, updateTab],
  );

  const renameVariant = useCallback(
    (variantId: string, name: string) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId ? { ...v, name } : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  const resizeVariant = useCallback(
    (variantId: string, width: number, contentHeight: number) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId
            ? {
                ...v,
                sourceViewportWidth: width,
                sourceContentHeight: contentHeight,
              }
            : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  const moveVariant = useCallback(
    (variantId: string, offsetX: number, offsetY: number) => {
      updateTab({
        variants: tabVariants.map((v) =>
          v.id === variantId ? { ...v, offsetX, offsetY } : v,
        ),
      });
    },
    [tabVariants, updateTab],
  );

  /** Nudge canvas pan so the full strip (live frame + variants) stays in view. */
  const panToRevealStrip = useCallback(
    (variants: BrowserTabVariant[]) => {
      const el = canvasBodyRef.current;
      if (!el || !canvasMode) return;
      const PADDING = 40;
      const bodyW = el.clientWidth;
      setCanvasViewport((prev) => {
        const stripLogicalW = browserCanvasStripWidth(effW, variants);
        const stripScreenW = stripLogicalW * prev.zoom;
        let x = prev.x;
        if (x + stripScreenW > bodyW - PADDING) {
          x = bodyW - PADDING - stripScreenW;
        }
        if (x > PADDING) x = PADDING;
        return { ...prev, x };
      });
    },
    [canvasMode, effW],
  );

  const handleForkVariant = useCallback(async () => {
    if (!canvasMode || !webview.designModeActive) return;
    const elements = webview.selectedElements;
    if (elements.length === 0) return;

    const anchorIndex = elements.length - 1;
    const anchor = elements[anchorIndex];
    const result = await webview.requestForkSnapshot(
      anchor.selector,
      anchorIndex,
    );
    const snapshot = result.snapshot;
    if (!snapshot) {
      const reason = result.error;
      if (reason === "cancelled" || reason === "superseded") return;
      const description =
        reason === "element-not-found"
          ? "The selected element is no longer in the page. Click it again in design mode."
          : reason === "timeout"
            ? "Fork timed out — the page may be large. Reload the tab and try again."
            : reason === "capture-failed" || reason === "capture-error"
              ? "Capture failed. Reload the browser tab, re-enter design mode, and select the element again."
              : "Reload the browser tab, enter design mode (⌘+Shift+D), and select the element again.";
      toast.error("Could not fork this element.", { description });
      return;
    }

    const forkWidth = Math.max(BROWSER_VARIANT_MIN_WIDTH, Math.round(effW));
    const forkHeight = Math.max(BROWSER_VARIANT_MIN_HEIGHT, Math.round(effH));

    const variantName = anchor.componentName
      ? `${anchor.componentName} Fork ${tabVariants.length + 1}`
      : `Component Fork ${tabVariants.length + 1}`;

    const variant: BrowserTabVariant = {
      id: `bvar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: variantName,
      html: snapshot.html,
      css: snapshot.css,
      sourceSelector: snapshot.sourceSelector,
      sourceUrl:
        webview.state.currentUrl || safeTabUrl || anchor.href || "",
      componentName: snapshot.componentName ?? anchor.componentName,
      sourceViewportWidth: forkWidth,
      sourceContentHeight: forkHeight,
      offsetX: 0,
      offsetY: 0,
      createdAt: Date.now(),
      ...applyForkManifestFields({
        name: variantName,
        behaviorManifest: snapshot.behaviorManifest,
      }),
    };

    const nextVariants = [...tabVariants, variant];

    updateTab({ variants: nextVariants });

    if (snapshot.cssTruncated) {
      toast.warning("Variant forked with truncated CSS", {
        description:
          "Stylesheet was large — some rules were omitted. Preview may differ slightly.",
      });
    } else if (variantNeedsLiveLayer(variant)) {
      const count = variant.behaviorManifest?.behaviors.length ?? 0;
      toast.success("Variant forked (static + live catalog)", {
        description: `${count} JS behavior${count === 1 ? "" : "s"} catalogued for future .tsx live layer.`,
      });
    } else if (snapshot.extractionMode === "precision-local") {
      toast.success("Variant forked (precision)", {
        description: "Full localhost stylesheets captured.",
      });
    } else {
      toast.success("Variant forked");
    }

    requestAnimationFrame(() => {
      panToRevealStrip(nextVariants);
    });
  }, [
    canvasMode,
    webview,
    safeTabUrl,
    tabVariants,
    effW,
    effH,
    updateTab,
    panToRevealStrip,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg1">
      <BrowserChrome
        webview={webview}
        electron={electron}
        localToolsEnabled={localToolsEnabled}
        canvasMode={canvasMode}
        onToggleCanvasMode={() => setCanvasMode(!canvasMode)}
      />
      {/* Browser body — a real <iframe>. CSS positions it; in
          canvas mode the iframe becomes a centered explicit-sized
          frame with edge resize handles and a viewport preset
          rail; otherwise it fills the column. Sandbox attribute
          matches Cursor's permissive set — allow-same-origin
          keeps cookies/localStorage usable for the user's dev
          server, allow-scripts/forms/popups/modals lets typical
          web apps run normally, allow-popups-to-escape-sandbox
          is required so OAuth and similar window.open flows can
          land in a fresh tab/window without being trapped inside
          the iframe. X-Frame-Options + CSP frame-ancestors are
          stripped for http(s) responses (see
          electron/iframe-headers.ts) so most arbitrary URLs load. */}
      <div
        ref={canvasBodyRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onPointerDown={canvasMode ? onCanvasPointerDown : undefined}
        style={
          canvasMode
            ? {
                cursor: spaceHeld
                  ? isPanning
                    ? "grabbing"
                    : "grab"
                  : "default",
              }
            : undefined
        }
      >
        {electron && !hasUrl ? (
          <EmptyState onNavigate={webview.navigate} />
        ) : (
          <>
            {/* Canvas background — dot grid that pans/zooms with
                the viewport. Only painted in canvas mode. */}
            {canvasMode && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, var(--border1) 1px, transparent 1px)",
                  backgroundSize: `${24 * canvasViewport.zoom}px ${24 * canvasViewport.zoom}px`,
                  backgroundPosition: `${canvasViewport.x}px ${canvasViewport.y}px`,
                  opacity: 0.6,
                }}
              />
            )}
            {/* Iframe wrapper — same React tree position in both
                modes, only the style differs. Stays mounted across
                mode toggles so page nav + scroll + JS heap survive.
                In fill mode: inset:0 fills the body. In canvas mode:
                absolute-positioned with the viewport transform. */}
            <div
              className={canvasMode ? "absolute flex items-start" : "absolute"}
              style={
                canvasMode
                  ? {
                      left: canvasViewport.x,
                      top: canvasViewport.y,
                      transform: `scale(${canvasViewport.zoom})`,
                      transformOrigin: "top left",
                      gap: BROWSER_VARIANT_GAP_PX,
                    }
                  : { inset: 0 }
              }
            >
              <div
                className={
                  canvasMode ? "relative shrink-0" : "absolute inset-0"
                }
                style={canvasMode ? { width: effW, height: effH } : undefined}
                data-zeros-canvas-chrome
              >
                <iframe
                  key={webview.frameNavigationKey}
                  ref={webview.ref}
                  name={frameName}
                  src={
                    hasUrl
                      ? webview.frameSrc || safeTabUrl || ""
                      : "about:blank"
                  }
                  // `title` is the iframe's accessible name for screen readers.
                  // (A hover Tooltip over the full page body would pop a chip on
                  // every hover and can stick open, since the iframe swallows
                  // pointerleave — so the frame name stays a plain attribute.)
                  title={tab.title}
                  // Pinned to its pre-gesture size during seam drags even
                  // while VISIBLE (resize-gesture-freeze.ts): resizing an
                  // iframe re-lays-out the guest document every frame, the
                  // most expensive thing a drag can trigger. It clips/shows
                  // surface bg mid-drag and snaps once on release — the
                  // standard webview treatment during sash drags. Inline px
                  // from the freeze beat size-full; in canvas mode the size
                  // is already fixed, so the pin is a no-op there — but only
                  // because the freeze normalizes its measurement by the
                  // wrapper's scale(zoom): pinning the raw (visual) rect
                  // would resize the iframe to zoom×layout for the drag.
                  data-zeros-resize-freeze=""
                  className="absolute inset-0 block size-full border-0 bg-bg1"
                  // Block pointer events on the iframe while a
                  // resize drag is happening so the drag pointer
                  // doesn't get captured by the iframe content.
                  // Also block while the element chip is open — in
                  // Electron, sibling overlays don't always win hit
                  // testing over iframes; the input still works via
                  // autoFocus but fork/close clicks were falling
                  // through to the page underneath.
                  // During Space+pan, block iframe so canvas pan wins.
                  style={{
                    pointerEvents:
                      isResizing || chipVisible || spaceHeld ? "none" : "auto",
                  }}
                  sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-pointer-lock allow-presentation allow-storage-access-by-user-activation allow-downloads"
                  // M13: don't advertise clipboard-read / geolocation / camera /
                  // microphone to visited sites; the main-process permission
                  // handler denies them anyway. Keep only low-risk features.
                  allow="clipboard-write; fullscreen"
                />
                {chipVisible && (
                  <ElementChip
                    elements={webview.selectedElements}
                    onDismiss={webview.clearSelectedElements}
                    onRemoveAt={webview.removeSelectedElementAt}
                    forkEnabled={
                      canvasMode &&
                      webview.designModeActive &&
                      webview.selectedElements.length > 0
                    }
                    forkPending={webview.forkPending}
                    onFork={() => void handleForkVariant()}
                    onSubmit={(text) => {
                      submitElementsToChat({
                        text,
                        elements: webview.selectedElements,
                        tabUrl: webview.state.currentUrl || safeTabUrl || "",
                        activeChatId: useWorkspaceStore.getState().activeChatId,
                        dispatch,
                      });
                      webview.clearSelectedElements();
                    }}
                  />
                )}
                {canvasMode && (
                  <CanvasKnobHandles
                    axes={["left", "right", "bottom"]}
                    activeAxis={dragDims?.axis ?? null}
                    onStart={startResize}
                  />
                )}
                {canvasMode && (
                  <CanvasHeightIndicator
                    height={effH}
                    isResizing={isResizing}
                    onReset={resetHeight}
                  />
                )}
                {canvasMode && (
                  <CanvasPresetRail
                    width={effW}
                    onApplyWidth={applyPresetWidth}
                  />
                )}
              </div>
              {canvasMode &&
                tabVariants.map((variant) => (
                  <BrowserVariantFrame
                    key={variant.id}
                    variant={variant}
                    canvasZoom={canvasViewport.zoom}
                    onDelete={deleteVariant}
                    onRename={renameVariant}
                    onResize={resizeVariant}
                    onMove={moveVariant}
                  />
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Chrome row (back/forward/reload + URL + design mode + ⋯) ──

interface BrowserChromeProps {
  webview: ReturnType<typeof useIframeWebview>;
  electron: boolean;
  localToolsEnabled: boolean;
  canvasMode: boolean;
  onToggleCanvasMode: () => void;
}

function BrowserChrome({
  webview,
  electron,
  localToolsEnabled,
  canvasMode,
  onToggleCanvasMode,
}: BrowserChromeProps) {
  const {
    state,
    navigate,
    back,
    forward,
    reload,
    hardReload,
    clearCache,
    clearCookies,
    designModeActive,
    setDesignMode,
  } = webview;
  const inputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(() => state.currentUrl);
  const [focused, setFocused] = useState(false);

  // Sync the address to the webview's canonical URL when the user isn't editing.
  // Without this guard, an internal navigation would yank the cursor
  // out mid-typing.
  useEffect(() => {
    if (!focused) setAddress(state.currentUrl);
  }, [state.currentUrl, focused]);

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const url = normalizeBrowserUrl(address);
      if (!url) {
        toast.error("Enter a valid http(s) URL");
        return;
      }
      setAddress(url);
      navigate(url);
    },
    [address, navigate],
  );

  return (
    // 36px (h-9) chrome — 24px (size-6) icon buttons + the 24px search bar sit
    // centered with breathing room.
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border1 bg-bg1 px-2">
      {/* Navigation buttons */}
      <Tooltip label="Back">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-fg2 hover:text-fg1 disabled:opacity-40"
          disabled={!state.canGoBack}
          onClick={back}
          aria-label="Back"
        >
          <ChevronLeft size={14} />
        </Button>
      </Tooltip>
      <Tooltip label="Forward">
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-fg2 hover:text-fg1 disabled:opacity-40"
          disabled={!state.canGoForward}
          onClick={forward}
          aria-label="Forward"
        >
          <ChevronRight size={14} />
        </Button>
      </Tooltip>
      <Tooltip label={state.isLoading ? "Loading…" : "Reload"}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 text-fg2 hover:text-fg1"
          onClick={reload}
          aria-label="Reload"
        >
          {state.isLoading ? <ZerosSpinner size={16} /> : <RotateCw size={14} />}
        </Button>
      </Tooltip>

      {/* URL omnibox — accepts canonical or scheme-less http(s) addresses. */}
      <form onSubmit={handleSubmit} className="min-w-0 flex-1">
        <div
          className={[
            "bg-bg2 flex h-6 w-full items-center rounded-sm border border-transparent px-2 transition-colors",
            electron ? "focus-within:border-highlighted-bright" : "opacity-60",
          ].join(" ")}
          onMouseDown={(e) => {
            // Clicking anywhere in the bar routes focus to the address.
            if (e.target !== inputRef.current) {
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              setFocused(true);
              // Select all on focus so the user can retype the address
              // immediately (Chrome/Cursor parity).
              e.currentTarget.select();
            }}
            onBlur={() => {
              setFocused(false);
              setAddress(state.currentUrl);
            }}
            placeholder={electron ? "Enter URL" : "Mac app only"}
            disabled={!electron}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Browser URL"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-fg1 outline-none placeholder:text-fg2 disabled:cursor-not-allowed"
          />
        </div>
      </form>

      {/* Design Mode toggle — element picker. When on, the
          in-iframe picker (auto-injected on every iframe load by
          main's did-frame-finish-load hook) starts handling hover
          and click events. Clicking pops the ElementChip in the
          BrowserTab body. */}
      {localToolsEnabled && (
        <>
          <Tooltip label="Design Mode" shortcut="⌘⇧D">
            <Button
              variant="ghost"
              size="icon-sm"
              className={[
                "size-6",
                designModeActive
                  ? "bg-bg2-hover text-fg1"
                  : "text-fg2 hover:text-fg1",
                // Design/Canvas are plain toggles over the live iframe. Avoid a
                // focus-visible carry-over when focus bounces through the page.
                "focus-visible:border-transparent focus-visible:ring-0",
              ].join(" ")}
              onClick={() => setDesignMode(!designModeActive)}
              disabled={!electron}
              aria-pressed={designModeActive}
              aria-label="Toggle Design Mode"
            >
              <MousePointer2 size={14} />
            </Button>
          </Tooltip>

          <Tooltip label="Canvas Mode" shortcut={"⌘\\"}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={[
                "size-6",
                canvasMode
                  ? "bg-bg2-hover text-fg1"
                  : "text-fg2 hover:text-fg1",
                "focus-visible:border-transparent focus-visible:ring-0",
              ].join(" ")}
              onClick={onToggleCanvasMode}
              aria-pressed={canvasMode}
              aria-label="Toggle Canvas Mode"
            >
              <Palette size={14} />
            </Button>
          </Tooltip>
        </>
      )}

      {/* Iframe migration — Radix DropdownMenu z-indexes naturally
          over the iframe body. No more native menu, no overlay-lock,
          no screenshot backdrop. */}
      <DropdownMenu>
        <Tooltip label="More">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={[
                "text-fg2 hover:text-fg1 size-6",
                "data-[state=open]:bg-bg2-hover data-[state=open]:text-fg1",
              ].join(" ")}
              disabled={!electron}
              aria-label="More browser actions"
            >
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem onClick={hardReload} disabled={!electron}>
            Hard Reload
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => void clearCache()}
            disabled={!electron}
          >
            Clear Cache
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void clearCookies()}
            disabled={!electron}
          >
            Clear Cookies
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ── Design Mode element chip ─────────────────────────────

interface ElementChipProps {
  elements: SelectedElement[];
  onSubmit: (text: string) => void;
  onDismiss: () => void;
  onRemoveAt: (index: number) => void;
  forkEnabled?: boolean;
  forkPending?: boolean;
  onFork?: () => void;
}

/** Approximate chip dimensions — used for viewport-bounds clamping
 *  so the chip doesn't disappear off-screen when the user clicks
 *  something near a window edge. The canvas inspector uses the
 *  same pattern (`feedback-pill.ts:100-137`). */
// ── Canvas-mode sub-components (Phase 5) ─────────────────

interface CanvasPresetRailProps {
  width: number;
  onApplyWidth: (width: number) => void;
}

/** Viewport preset rail anchored to the RIGHT EDGE OF THE FRAME
 *  (not the column). The rail is a child of the frame wrapper, so
 *  it inherits the wrapper's CSS transform — pans/zooms with the
 *  frame, exactly like the height indicator below. Shows the
 *  current width as a pill plus one button per preset (Desktop /
 *  Laptop / Tablet / Mobile). Active preset (width within ±20px
 *  of preset value) gets the accent background. */
function CanvasPresetRail({ width, onApplyWidth }: CanvasPresetRailProps) {
  return (
    <div
      className="pointer-events-none absolute top-1/2 z-20 ml-6 flex -translate-y-1/2 flex-col items-end gap-1"
      style={{ left: "100%" }}
    >
      <div className="pointer-events-auto rounded-sm border border-border1 bg-bg2 px-2.5 py-0.5 text-xs font-medium tabular-nums text-fg2 shadow-sm">
        {width}px
      </div>
      {BROWSER_VIEWPORT_PRESETS.map((p) => {
        const active = Math.abs(width - p.width) < 20;
        return (
          <Tooltip key={p.label} label={`${p.label} (${p.width}px)`}>
            <button
              type="button"
              onClick={() => onApplyWidth(p.width)}
              className={[
                "pointer-events-auto rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-bg2-hover text-fg1"
                  : "text-fg2 hover:bg-bg1-hover hover:text-fg1",
              ].join(" ")}
            >
              {p.label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

interface CanvasHeightIndicatorProps {
  height: number;
  isResizing: boolean;
  onReset: () => void;
}

/** Below-iframe pill showing the current height and a Reset
 *  button when it's not the default. Fades in during a drag so
 *  the user has live feedback even while at the default. */
function CanvasHeightIndicator({
  height,
  isResizing,
  onReset,
}: CanvasHeightIndicatorProps) {
  const isDefault = height === BROWSER_DEFAULT_HEIGHT;
  const visible = isResizing || !isDefault;
  return (
    <div
      className="absolute left-1/2 top-full z-10 mt-3 flex -translate-x-1/2 items-center gap-2 transition-opacity duration-150"
      style={{
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {!isDefault && (
        <Tooltip label="Reset to default height">
          <button
            type="button"
            onClick={onReset}
            className="rounded-sm bg-fg1 px-2.5 py-1 text-xs font-medium text-primary-button-fg shadow-sm hover:bg-fg1/90"
          >
            Reset ({BROWSER_DEFAULT_HEIGHT}px)
          </button>
        </Tooltip>
      )}
      <div className="rounded-sm border border-border1 bg-bg2 px-2.5 py-0.5 text-xs font-medium tabular-nums text-fg2 shadow-sm">
        {height}px
      </div>
    </div>
  );
}

const CHIP_WIDTH = 340;
const CHIP_HEIGHT_BASE = 76; // base row (tags) + (input row when expanded)
const CHIP_GAP = 12;

/** Floating popover anchored to the most-recently-clicked element.
 *  Rendered as a sibling of the iframe; click coords come from the
 *  picker (iframe-local CSS px) and are already in this container's
 *  coord space because the iframe sits at inset:0 of the container.
 *  Edge-flips when overflowing right or bottom of the container.
 *
 *  Phase 4.5: shows ALL selected elements as removable tags, plus
 *  an "+ Add" button to pick another element. Submit fires one
 *  combined chat message with every element. */
function ElementChip({
  elements,
  onSubmit,
  onDismiss,
  onRemoveAt,
  forkEnabled = false,
  forkPending = false,
  onFork,
}: ElementChipProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Anchor to the LAST element clicked (most recent intent).
  const anchor = elements[elements.length - 1];

  // requestAnimationFrame ensures the input is mounted, the parent
  // overlay-lock has triggered the visibility flip, and the DOM is
  // painted before we claim focus. Plain `autoFocus` and synchronous
  // .focus() in useEffect both race the layout and intermittently
  // miss — the canvas inspector uses this exact pattern
  // (`feedback-pill.ts:442`).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [anchor?.selector, anchor?.click.x, anchor?.click.y]);

  // Outside-click dismiss. Capture phase on document so we beat
  // the canvas pan handler. Use composedPath so slotted/shadow
  // targets still count as inside the chip.
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent) => {
      const chip = containerRef.current;
      if (!chip) return;
      const path = e.composedPath();
      if (path.includes(chip)) return;
      onDismiss();
    };
    const t = window.setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
    };
  }, [onDismiss]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      return;
    }
    // ⌘+L or Ctrl+L — Cursor's "send to active chat" shortcut.
    // Also Enter (without Shift) submits. Shift/Option variants are
    // rejected so this plain chord can't double-fire alongside other
    // L-key chords (⇧⌘L is the internal copy-logs shortcut).
    const isCmdL =
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "l" || e.key === "L");
    const isEnter = e.key === "Enter" && !e.shiftKey;
    if (isCmdL || isEnter) {
      e.preventDefault();
      onSubmit(text);
    }
  };

  // Position the chip near the LAST clicked element. Edge-flip if
  // it would overflow right or bottom of the placeholder.
  const placeholder = containerRef.current?.parentElement;
  const placeW = placeholder?.clientWidth ?? 800;
  const placeH = placeholder?.clientHeight ?? 600;
  let left = (anchor?.click.x ?? 8) + CHIP_GAP;
  let top = (anchor?.click.y ?? 8) + CHIP_GAP;
  if (left + CHIP_WIDTH > placeW - 8) {
    left = Math.max(8, (anchor?.click.x ?? 8) - CHIP_WIDTH - CHIP_GAP);
  }
  if (top + CHIP_HEIGHT_BASE > placeH - 8) {
    top = Math.max(8, (anchor?.click.y ?? 8) - CHIP_HEIGHT_BASE - CHIP_GAP);
  }

  if (!anchor) return null;

  const anyShadow = elements.some((e) => e.hasShadowRoot);

  return (
    <div
      ref={containerRef}
      data-zeros-element-chip
      className="absolute z-50 pointer-events-auto"
      style={{ left, top, width: CHIP_WIDTH }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-1.5 rounded-lg border border-border1 bg-bg3 p-2 shadow-lg">
        {/* Tag row: one removable pill per selected element + the
            "+" add-another button. flex-wrap so the row grows
            vertically when many elements are selected. */}
        <div className="flex flex-wrap items-center gap-1">
          {elements.map((el, i) => (
            <Tooltip key={`${el.selector}-${i}`} label={`${el.selector}`}>
              <span className="inline-flex items-center gap-1 rounded-sm bg-bg3-hover px-1.5 py-0.5 text-xs text-fg1">
                {/* Prefer human-readable component name (React fiber,
                    Vue, data-component, CSS module, aria-label, semantic
                    tag) — falls back to <tag> when no better name is
                    detectable. Mono only on the tag fallback so component
                    names read as natural text. */}
                {el.componentName ? (
                  <span className="font-medium">{el.componentName}</span>
                ) : (
                  <span>{`<${el.tag}>`}</span>
                )}
                <button
                  type="button"
                  onClick={() => onRemoveAt(i)}
                  className="-mr-0.5 inline-flex size-3 items-center justify-center rounded-sm text-fg2 hover:bg-bg4 hover:text-fg1"
                  aria-label={`Remove ${el.componentName || el.tag}`}
                >
                  <X size={9} />
                </button>
              </span>
            </Tooltip>
          ))}
        </div>
        {/* Input + fork + dismiss row */}
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              elements.length === 1
                ? "Describe the change or ⌘L to add to chat"
                : `Describe (${elements.length} elements) or ⌘L`
            }
            spellCheck={false}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm text-fg1 outline-none placeholder:text-fg2"
          />
          {onFork && (
            <Tooltip
              label={forkEnabled ? "Fork variant" : "Canvas mode only"}
            >
              <button
                type="button"
                aria-disabled={!forkEnabled || forkPending}
                onClick={() => {
                  if (!forkEnabled || forkPending) return;
                  onFork();
                }}
                className={`inline-flex size-7 items-center justify-center rounded-sm text-fg2 hover:bg-bg2-hover hover:text-fg1 ${
                  !forkEnabled || forkPending
                    ? "cursor-not-allowed opacity-40"
                    : ""
                }`}
                aria-label="Fork variant"
              >
                {forkPending ? (
                  <ZerosSpinner size={12} />
                ) : (
                  <GitFork size={12} />
                )}
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex size-7 items-center justify-center rounded-sm text-fg2 hover:bg-bg2-hover hover:text-fg1"
            aria-label="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      {anyShadow && (
        <p className="mt-1 ml-1 text-xs text-fg2">
          {elements.length === 1
            ? "Inside shadow-DOM — selector may be brittle."
            : "One or more elements are inside shadow-DOM — selectors may be brittle."}
        </p>
      )}
    </div>
  );
}

/** Format an element capture for inline insertion into a composer
 *  draft (⌥+click flow). The chat submission flow uses a richer
 *  multi-line block; this one targets a single compact paragraph
 *  the user can comfortably edit around. */
function formatElementForComposer(el: SelectedElement, tabUrl: string): string {
  const url = tabUrl || el.href;
  const styleSummary = el.styles
    ? Object.entries(el.styles)
        .filter(
          ([, v]) =>
            v && v !== "auto" && v !== "normal" && v !== "none" && v !== "0px",
        )
        .slice(0, 5)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
    : "";
  // Lead with component name when known; fall back to bare tag.
  const ident = el.componentName ? `${el.componentName} <${el.tag}>` : `<${el.tag}>`;
  const head = `[${ident} ${el.selector}${url ? ` @ ${url}` : ""}]`;
  return styleSummary ? `${head} { ${styleSummary} }` : head;
}

// ── Submit to active chat ─────────────────────────────────

/** Narrow dispatch shape — we only emit the one action so we don't
 *  need to import the (unexported) full reducer Action union. The
 *  store's real dispatch is `Dispatch<Action>`, which is
 *  contravariantly assignable to this narrower function type
 *  because every concrete Action covers this one. */
type EnqueueDispatch = (action: {
  type: "ENQUEUE_CHAT_SUBMISSION";
  submission: PendingChatSubmission;
}) => void;

interface SubmitArgs {
  text: string;
  elements: SelectedElement[];
  tabUrl: string;
  activeChatId: string | null;
  dispatch: EnqueueDispatch;
}

/** Format ONE element as a markdown-ish block for the chat message.
 *  Includes selector, URL, shadow-DOM note, and computed styles
 *  subset so the agent can phrase concrete diffs. */
function elementBlock(el: SelectedElement, fallbackUrl: string): string {
  const styleLines = el.styles
    ? Object.entries(el.styles)
        .filter(([, v]) => v && v !== "auto" && v !== "normal" && v !== "none")
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n")
    : "";
  // Lead with the component name when we have one — that's the
  // identifier the user actually sees in the chip and recognizes
  // from their own code. Fall back to the bare tag otherwise.
  const heading = el.componentName
    ? `${el.componentName} (<${el.tag}>)`
    : `<${el.tag}>`;
  return (
    `${heading}\n` +
    `  selector: ${el.selector}\n` +
    `  url: ${el.href || fallbackUrl}` +
    (el.hasShadowRoot ? "\n  note: inside shadow-DOM" : "") +
    (styleLines ? `\n  computed styles:\n${styleLines}` : "")
  );
}

/** Build a chat submission payload from the user's typed
 *  description + ALL captured elements + their screenshot
 *  attachments. Cursor parity: ALWAYS target the active chat —
 *  never silently spawn a new one. If there's no active chat,
 *  surface a clear failure via the bottom-right toast. */
function submitElementsToChat({
  text,
  elements,
  tabUrl,
  activeChatId,
  dispatch,
}: SubmitArgs): void {
  if (!activeChatId) {
    toast.error("No active chat to attach this element to.", {
      description: "Open or create a chat first.",
    });
    return;
  }
  if (elements.length === 0) return;
  const userText = text.trim();
  // Header switches voice based on count: 1 element → "Selected
  // element"; N elements → "Selected N elements", numbered list.
  const header =
    elements.length === 1
      ? `Selected element: ${elementBlock(elements[0], tabUrl)}`
      : `Selected ${elements.length} elements:\n\n` +
        elements
          .map((el, i) => `${i + 1}. ${elementBlock(el, tabUrl)}`)
          .join("\n\n");
  const body = userText ? `${userText}\n\n${header}` : header;

  // Browser captures enter the SAME staged-attachment pipeline as paste/drop.
  // It writes the full-resolution bytes to the active chat's disk namespace,
  // sends them as vision content, and persists only the returned path.
  const composerAttachments: ComposerAttachment[] = [];
  elements.forEach((el, i) => {
    if (!el.screenshot) return;
    const m = el.screenshot.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return;
    composerAttachments.push({
      // The id is part of the durable filename. Include entropy so two
      // submissions in the same millisecond cannot overwrite an older chat
      // image and silently change what that older message renders.
      id: `browser-${Date.now().toString(36)}-${i + 1}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      name: `${el.tag}-${i + 1}.jpg`,
      mimeType: m[1],
      kind: "image",
      data: m[2],
      size: Math.floor((m[2].length * 3) / 4),
      validation: { ok: true },
    });
  });

  dispatch({
    type: "ENQUEUE_CHAT_SUBMISSION",
    submission: {
      id: `elem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      text: body,
      source: "manual",
      composerAttachments:
        composerAttachments.length > 0 ? composerAttachments : undefined,
    },
  });
}

function EmptyState({ onNavigate }: { onNavigate: (url: string) => void }) {
  const suggestions: Array<{ label: string; url: string }> = [
    { label: "localhost:3000", url: "http://localhost:3000" },
    { label: "localhost:5173", url: "http://localhost:5173" },
    { label: "localhost:8080", url: "http://localhost:8080" },
  ];
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg1 px-10 text-center">
      <Globe className="size-7 text-fg2" />
      <p className="m-0 text-sm text-fg2">Open a site or preview your app</p>
      <p className="m-0 max-w-[420px] text-xs leading-[1.55] text-fg2">
        Enter any http(s) URL in the address bar. Design and Canvas tools appear
        automatically for locally running sites.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
        {suggestions.map((s) => (
          <button
            key={s.url}
            type="button"
            onClick={() => onNavigate(s.url)}
            className="rounded-sm border border-border1 bg-bg1 px-2 py-1 text-xs text-fg2 transition-colors hover:bg-bg2-hover hover:text-fg1"
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

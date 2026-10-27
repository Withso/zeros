// ──────────────────────────────────────────────────────────
// Floating Browser previews over the chat column
// ──────────────────────────────────────────────────────────
//
// Each floated Browser tab gets one bottom-right slot. The tab itself moves its
// live viewport into the slot (see browser-float-store.ts), so this stack only
// owns geometry, resizing and the hover islands. The agent browser picture in
// picture keeps the corner; floated tabs stack above it.

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AppWindow, PanelRightOpen, X } from "lucide-react";

import { useWorkspaceDispatch, useWorkspaceStore } from "../../state/store";
import { workbenchScopeKey } from "../../state/workspace-store";
import { cn } from "../../shared/ui/cn";
import { toast } from "../../shared/ui/primitives/elements";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Toolbar, Tooltip } from "../../shared/ui/primitives";
import { requestWorkbenchRestore } from "../../shell/workbench/workbench-visibility-controller";
import { beginDesignPointerGesture } from "../design-workspace/design-pointer-gesture";
import { browserPictureInPictureSize, browserPictureInPictureTitle } from "./browser-agent-picture-in-picture";
import {
  clampBrowserFloatViewport,
  closeBrowserFloat,
  dockBrowserTab,
  registerBrowserFloatSlot,
  resizeBrowserFloat,
  useBrowserAgentPipSurface,
  useBrowserFloatEntries,
  type BrowserFloatEntry,
  type BrowserFloatViewport,
} from "./browser-float-store";
import {
  browserWindowUnavailableReason,
  openBrowserWindow,
} from "./browser-window-actions";

const STACK_EDGE_PX = 16;
const STACK_GAP_PX = 8;
/** Smallest float a resize makes; the action island still fits. */
const MIN_FLOAT_WIDTH = 160;
const MIN_FLOAT_HEIGHT = 100;
/** A corner resize never enlarges the page past its actual size. */
const MAX_FLOAT_SCALE = 1;
/** Narrower floats show only the action island. */
const FLOAT_TITLE_MIN_WIDTH = 200;

export type BrowserFloatResizeHandle =
  | "left"
  | "top"
  | "top-left"
  | "top-right"
  | "bottom-left";

/** Largest float one stack share holds, keeping the stack's edge gutters. */
export function browserFloatMaxSize(input: {
  availableWidth: number;
  availableHeight: number;
}): { width: number; height: number } {
  return {
    width: Math.max(1, input.availableWidth - 2 * STACK_EDGE_PX),
    height: Math.max(1, input.availableHeight - 2 * STACK_EDGE_PX),
  };
}

/** Fits a float to the shared picture-in-picture budget while keeping the
 * page's exact aspect ratio (the PiP minimums would otherwise crop tall,
 * phone-sized viewports). A tall page still floats at least as wide as the
 * smallest resize while the height allows. A resized float keeps its own
 * scale and shrinks only while the available area cannot hold it. */
export function browserFloatSize(input: {
  availableWidth: number;
  availableHeight: number;
  viewport: BrowserFloatViewport;
  scale?: number;
}): { width: number; height: number; scale: number } {
  const max = browserFloatMaxSize(input);
  const fit = Math.min(
    max.width / input.viewport.width,
    max.height / input.viewport.height,
  );
  let scale: number;
  if (input.scale === undefined) {
    const budget = browserPictureInPictureSize({
      availableWidth: input.availableWidth,
      availableHeight: input.availableHeight,
      sourceViewport: input.viewport,
    });
    scale = Math.max(
      Math.min(
        budget.width / input.viewport.width,
        budget.height / input.viewport.height,
      ),
      Math.min(MIN_FLOAT_WIDTH / input.viewport.width, fit),
    );
  } else {
    scale = Math.min(input.scale, fit);
  }
  return {
    width: Math.max(1, Math.round(input.viewport.width * scale)),
    height: Math.max(1, Math.round(input.viewport.height * scale)),
    scale,
  };
}

/** One resize step from the gesture's start. The float is anchored at its
 * bottom-right corner, so the left and top edges follow the pointer and
 * reflow the page at a fixed scale. A corner keeps the page's layout and
 * scales it, following the free edge the pointer pulls furthest. Limits the
 * start size already breaks widen to it, so the first move never jumps. */
export function browserFloatResize(
  start: {
    handle: BrowserFloatResizeHandle;
    viewport: BrowserFloatViewport;
    scale: number;
    maxWidth: number;
    maxHeight: number;
  },
  dx: number,
  dy: number,
): { viewport: BrowserFloatViewport; scale: number } {
  const { handle, viewport, scale } = start;
  const width = Math.max(1, viewport.width * scale);
  const height = Math.max(1, viewport.height * scale);
  const minWidth = Math.min(MIN_FLOAT_WIDTH, width);
  const minHeight = Math.min(MIN_FLOAT_HEIGHT, height);
  const maxWidth = Math.max(start.maxWidth, width);
  const maxHeight = Math.max(start.maxHeight, height);
  const clamp = (value: number, low: number, high: number) =>
    Math.min(high, Math.max(low, value));
  if (handle === "left") {
    return {
      viewport: clampBrowserFloatViewport({
        width: clamp(width - dx, minWidth, maxWidth) / scale,
        height: viewport.height,
      }),
      scale,
    };
  }
  if (handle === "top") {
    return {
      viewport: clampBrowserFloatViewport({
        width: viewport.width,
        height: clamp(height - dy, minHeight, maxHeight) / scale,
      }),
      scale,
    };
  }
  const growX = (width - dx) / width;
  const growY = (height - dy) / height;
  const grow =
    handle === "top-left"
      ? Math.max(growX, growY)
      : handle === "top-right"
        ? growY
        : growX;
  const lowest = Math.max(minWidth / width, minHeight / height);
  const highest = Math.min(
    maxWidth / width,
    maxHeight / height,
    Math.max(1, MAX_FLOAT_SCALE / scale),
  );
  return { viewport, scale: scale * clamp(grow, lowest, highest) };
}

/** Bottom offset that clears the agent PiP when it holds the corner. */
export function browserFloatStackBottom(agentPipHeight: number): number {
  return agentPipHeight > 0
    ? STACK_EDGE_PX + agentPipHeight + STACK_GAP_PX
    : STACK_EDGE_PX;
}

/** The floated site's name: its host, keeping the port that tells local dev
 * servers apart, else the page title. */
export function browserFloatTitle(
  title: string | undefined,
  url: string | undefined,
): string {
  try {
    const host = url ? new URL(url).host.replace(/^www\./, "") : "";
    if (host) return host;
  } catch {
    // Not an absolute URL; fall back to the title.
  }
  return browserPictureInPictureTitle(title, url);
}

function useElementHeight(element: HTMLElement | null): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    if (!element) {
      setHeight(0);
      return;
    }
    const update = () => setHeight(Math.round(element.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return height;
}

export function BrowserFloatStack({
  onRevealWorkbench,
}: {
  onRevealWorkbench: () => void;
}) {
  const scope = useWorkspaceStore(workbenchScopeKey);
  const entries = useBrowserFloatEntries(scope);
  const agentPip = useBrowserAgentPipSurface();
  const agentPipHeight = useElementHeight(agentPip);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const hasEntries = entries.length > 0;

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!hasEntries || !overlay) return;
    const update = () => {
      const rect = overlay.getBoundingClientRect();
      setBounds((current) =>
        current.width === Math.round(rect.width) &&
        current.height === Math.round(rect.height)
          ? current
          : { width: Math.round(rect.width), height: Math.round(rect.height) },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [hasEntries]);

  if (!hasEntries) return null;
  const bottom = browserFloatStackBottom(agentPipHeight);
  const heightShare = Math.max(
    1,
    Math.floor((bounds.height - (bottom - STACK_EDGE_PX)) / entries.length),
  );
  return (
    <div
      ref={overlayRef}
      className="z-chrome pointer-events-none absolute inset-0"
      data-testid="browser-float-stack"
    >
      <div
        className="absolute right-4 flex flex-col-reverse items-end gap-2"
        style={{ bottom }}
      >
        {entries.map((entry) => {
          const available = {
            availableWidth: bounds.width,
            availableHeight: heightShare,
          };
          return (
            <BrowserFloatBox
              key={entry.key}
              entry={entry}
              size={browserFloatSize({
                ...available,
                viewport: entry.viewport,
                scale: entry.scale,
              })}
              maxSize={browserFloatMaxSize(available)}
              onRevealWorkbench={onRevealWorkbench}
            />
          );
        })}
      </div>
    </div>
  );
}

// Resize zones straddle the float's free sides by 4px. The right and bottom
// sides are anchored to the stack, so they have none.
const FLOAT_RESIZE_HANDLES: readonly {
  handle: BrowserFloatResizeHandle;
  cursor: string;
  className: string;
}[] = [
  { handle: "left", cursor: "ew-resize", className: "top-2 bottom-2 -left-1 w-2 cursor-ew-resize" },
  { handle: "top", cursor: "ns-resize", className: "-top-1 right-2 left-2 h-2 cursor-ns-resize" },
  { handle: "top-left", cursor: "nwse-resize", className: "-top-1 -left-1 size-3 cursor-nwse-resize" },
  { handle: "top-right", cursor: "nesw-resize", className: "-top-1 -right-1 size-3 cursor-nesw-resize" },
  { handle: "bottom-left", cursor: "nesw-resize", className: "-bottom-1 -left-1 size-3 cursor-nesw-resize" },
];

const FLOAT_ISLAND_HIDDEN = "pointer-events-none opacity-0 transition-opacity duration-150";
// Focus inside the islands reveals them; focus inside the page does not.
const FLOAT_ISLAND_REVEAL =
  "group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within/float-islands:pointer-events-auto group-focus-within/float-islands:opacity-100";

function BrowserFloatBox({
  entry,
  size,
  maxSize,
  onRevealWorkbench,
}: {
  entry: BrowserFloatEntry;
  size: { width: number; height: number; scale: number };
  maxSize: { width: number; height: number };
  onRevealWorkbench: () => void;
}) {
  const dispatch = useWorkspaceDispatch();
  const tab = useWorkspaceStore((state) =>
    state.workbenchByScope[entry.scope]?.tabs.find(
      (candidate) => candidate.id === entry.tabId,
    ),
  );
  const slotRef = useCallback(
    (element: HTMLDivElement | null) => registerBrowserFloatSlot(entry.key, element),
    [entry.key],
  );
  const title = browserFloatTitle(tab?.title, tab?.url);
  const windowInput = {
    frameName: `zeros-browser-${entry.tabId}`,
    url: tab?.url ?? "",
    scope: entry.scope,
    agentPreview: Boolean(tab?.previewSource),
    title: tab?.title,
  };
  const windowUnavailable = browserWindowUnavailableReason(windowInput);
  const openInPanel = () => {
    dockBrowserTab(entry.key);
    dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: entry.tabId, scope: entry.scope });
    onRevealWorkbench();
  };
  const closeFloat = () => {
    if (closeBrowserFloat(entry.key)) requestWorkbenchRestore();
  };

  // One resize at a time. Escape, window blur and lost capture restore the
  // start size; unmounting mid-drag cancels the same way.
  const [resizeCursor, setResizeCursor] = useState<string | null>(null);
  const resizeCancelRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => () => resizeCancelRef.current?.(), []);
  const startResize = (
    event: React.PointerEvent<HTMLDivElement>,
    handle: BrowserFloatResizeHandle,
    cursor: string,
  ) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCancelRef.current?.();
    const start = {
      handle,
      viewport: entry.viewport,
      scale: size.scale,
      maxWidth: maxSize.width,
      maxHeight: maxSize.height,
    };
    const restore = { viewport: entry.viewport, scale: entry.scale };
    const startX = event.clientX;
    const startY = event.clientY;
    setResizeCursor(cursor);
    const settle = () => {
      resizeCancelRef.current = null;
      setResizeCursor(null);
    };
    resizeCancelRef.current = beginDesignPointerGesture({
      target: event.currentTarget,
      pointerId: event.pointerId,
      cursor,
      onMove: (move) =>
        resizeBrowserFloat(
          entry.key,
          browserFloatResize(start, move.clientX - startX, move.clientY - startY),
        ),
      onFinish: settle,
      onCancel: () => {
        resizeBrowserFloat(entry.key, restore);
        settle();
      },
    });
  };
  const reveal = resizeCursor === null && FLOAT_ISLAND_REVEAL;

  return (
    <section
      className="group pointer-events-auto relative shrink-0"
      style={
        {
          width: size.width,
          height: size.height,
          "--zeros-browser-float-scale": String(size.scale),
        } as React.CSSProperties
      }
      aria-label={`Floating preview: ${title}`}
      data-testid="browser-tab-float"
    >
      {/* A ring, unlike a border, leaves the whole box to the scaled page. */}
      <div className="ring-border2 bg-bg1 absolute inset-0 isolate overflow-hidden rounded-lg shadow-[var(--shadow-dropdown)] ring-1">
        {/* Receives the tab's live viewport host; React never renders into it. */}
        <div ref={slotRef} className="absolute inset-0" />
        {resizeCursor !== null && (
          // Keeps the page from taking the pointer or the cursor mid-resize.
          <div className="absolute inset-0 z-1" style={{ cursor: resizeCursor }} />
        )}
      </div>
      {/* Outside the clip and end-aligned, so a float narrower than its
          actions still shows every action. */}
      <div className="group/float-islands pointer-events-none absolute inset-x-2 top-2 z-2 flex items-stretch justify-end gap-2">
        {size.width >= FLOAT_TITLE_MIN_WIDTH && (
          <Tooltip label={tab?.url || title} side="bottom" align="start">
            <div
              className={cn(
                "border-border2 bg-bg2 text-fg1 mr-auto flex max-w-1/2 min-w-0 items-center rounded-lg border px-2.5 shadow-[var(--shadow-xl)]",
                FLOAT_ISLAND_HIDDEN,
                reveal,
              )}
            >
              <span className="text-2xxs min-w-0 truncate">{title}</span>
            </div>
          </Tooltip>
        )}
        <Toolbar
          aria-label="Floating preview actions"
          className={cn("shrink-0", FLOAT_ISLAND_HIDDEN, reveal)}
        >
          <Tooltip label="Dock preview">
            <IconButton size="compact" onClick={openInPanel} label="Open in right panel">
              <PanelRightOpen aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <Tooltip label={windowUnavailable ?? "Preview window"}>
            <IconButton
              size="compact"
              disabled={windowUnavailable !== null}
              onClick={() => {
                void openBrowserWindow(windowInput).then((result) => {
                  if (!result.ok) toast.error(result.message);
                });
              }}
              label="Open in preview window"
            >
              <AppWindow aria-hidden="true" />
            </IconButton>
          </Tooltip>
          <IconButton
            size="compact"
            onClick={closeFloat}
            label="Close floating preview"
          >
            <X aria-hidden="true" />
          </IconButton>
        </Toolbar>
      </div>
      {FLOAT_RESIZE_HANDLES.map(({ handle, cursor, className }) => (
        <div
          key={handle}
          aria-hidden="true"
          data-float-resize={handle}
          className={cn("absolute touch-none", className)}
          onPointerDown={(event) => startResize(event, handle, cursor)}
        />
      ))}
    </section>
  );
}

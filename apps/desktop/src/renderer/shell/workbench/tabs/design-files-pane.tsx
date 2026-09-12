// ──────────────────────────────────────────────────────────
// DesignFilesPane — the Files tab's stacked "Design files" section
// ──────────────────────────────────────────────────────────
//
// The workspace's committed design document gets its own section UNDER the
// code tree: a light-DOM header (rule, chevron, "Design files") over a second
// WorkspaceFileTree that shows nothing but the design document. The code tree
// above hides it (see design-files-section.ts for why the split, and for the
// rule that decides which folder is the document).
//
// Sizing: OPEN, the section is exactly half the column, whatever it holds — one
// folder row or a deep expanded document — and scrolls on its own past that.
// Collapsed, it is just its header. A fixed split, not a content-sized pane: an
// earlier version sized the pane to its rows (capped), which made the header
// jump around as folders opened and closed and reopened at whatever height the
// previous state left; a stable 50/50 is what the Files tab wants. Two scroll
// areas is the trade.
//
// Open and close SLIDE: the section's height transitions between its header
// and the half-column, clipping the tree as it goes, and the body fades with it.
// Height is animatable here because both ends are lengths (a pixel header, a
// percentage of a definite column) — no `auto`. The tree is hidden
// (display: none) only once a collapse has SETTLED, so it is still there to be
// clipped during the slide and reappears at full width the instant an open
// starts. Reduced motion turns the transition off.
//
// The header is the collapse toggle. Collapsed state persists per workspace in
// localStorage (a real preference, like the Changes tab's scope), and defaults
// to OPEN: the section exists to make the design document visible. Collapsing
// HIDES the tree rather than unmounting it, so the folders you opened and where
// you had scrolled are exactly as you left them when you open it again.
//
// The section is rendered only when the listing evidences a design document.
// That decision is the host's, from the same cached listing the trees read, so
// a repo without one has exactly the Files tab it had before — one tree, no
// header, no reserved space.
// ──────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";
import {
  loadWorkspaceFiles,
  peekWorkspaceFiles,
} from "../../workspace-files-cache";
import {
  DESIGN_FILES_LABEL,
  designSectionDirectories,
} from "./design-files-section";
import { WorkspaceFileTree } from "./workspace-file-tree";

/** Share of the sidebar column the OPEN section takes — always, regardless of
 *  content. Must match the pane's `h-1/2` class. */
export const DESIGN_PANE_OPEN_FRACTION = 0.5;
/** The header row: rule on top, chevron + label. */
export const DESIGN_PANE_HEADER_HEIGHT = 32;
/** The section's top rule, part of its box. */
const DESIGN_PANE_BORDER = 1;
/** The open/close slide. Short and decelerating: a reveal, not a bounce. Must
 *  match the section's `duration-200` class; the settle timer below is the
 *  fallback for when no transitionend arrives (reduced motion, a hidden tab). */
export const DESIGN_PANE_SLIDE_MS = 200;
/** Air between the header and the first row. The header already separates the
 *  section from what's above, so the tree needs less than a top-of-column tree. */
export const DESIGN_PANE_TREE_PAD_TOP = 4;

// ── Collapsed-state persistence ──────────────────────────
const STORAGE_KEY = "zeros:design-files-collapsed:v1";
const MAX_PERSISTED = 128;

function readCollapsedMap(): Record<string, true> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, true> = {};
    for (const [key, val] of Object.entries(
      parsed as Record<string, unknown>,
    ).slice(-MAX_PERSISTED)) {
      if (key.length > 0 && val === true) out[key] = true;
    }
    return out;
  } catch {
    return {};
  }
}

/** Whether `cwd`'s section was collapsed. Default OPEN. */
export function loadDesignPaneCollapsed(cwd: string): boolean {
  if (!cwd) return false;
  return readCollapsedMap()[cwd] === true;
}

/** Persist the toggle. Only collapsed workspaces are stored — open is the
 *  default, so an entry is never needed to express it. */
export function saveDesignPaneCollapsed(cwd: string, collapsed: boolean): void {
  if (!cwd) return;
  try {
    const map = readCollapsedMap();
    delete map[cwd];
    if (collapsed) map[cwd] = true;
    const keys = Object.keys(map);
    if (keys.length > MAX_PERSISTED) delete map[keys[0]];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode / no localStorage — just won't persist */
  }
}

// ── Does this workspace have a section? ──────────────────
/** True when `cwd`'s tracked listing evidences a root-level design document.
 *  Reads the same cache the trees do: synchronously when it is warm, otherwise
 *  after the shared load lands (the tree's own load joins that request). */
export function useHasDesignSection(
  cwd: string | undefined,
  reloadKey: number | undefined,
  active: boolean,
): boolean {
  const [state, setState] = useState<{ cwd: string | undefined; has: boolean }>(
    () => ({ cwd, has: hasDesignDocument(cwd) }),
  );
  useEffect(() => {
    if (!active) return;
    if (!cwd) {
      setState({ cwd, has: false });
      return;
    }
    let cancelled = false;
    void loadWorkspaceFiles(cwd)
      .then((files) => {
        if (cancelled) return;
        const has = designSectionDirectories(files).length > 0;
        setState((current) =>
          current.cwd === cwd && current.has === has ? current : { cwd, has },
        );
      })
      .catch(() => {
        /* keep the last answer; a refresh retries */
      });
    return () => {
      cancelled = true;
    };
  }, [active, cwd, reloadKey]);
  // A reused fiber can be handed another workspace before the effect runs:
  // answer from the new cwd's warm cache, never from the previous workspace.
  return state.cwd === cwd ? state.has : hasDesignDocument(cwd);
}

function hasDesignDocument(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const warm = peekWorkspaceFiles(cwd);
  return warm ? designSectionDirectories(warm).length > 0 : false;
}

// ── The pane ─────────────────────────────────────────────
export interface DesignFilesPaneProps {
  active: boolean;
  cwd: string;
  reloadKey: number;
  initialSelectedPath?: string | null;
  selectedPath?: string | null;
  scrollMemoryKey: string;
  onOpenFile: (path: string) => void;
  onOpenInNewTab?: (path: string) => void;
}

export function DesignFilesPane({
  active,
  cwd,
  reloadKey,
  initialSelectedPath,
  selectedPath,
  scrollMemoryKey,
  onOpenFile,
  onOpenInNewTab,
}: DesignFilesPaneProps) {
  const [collapsed, setCollapsed] = useState(() =>
    loadDesignPaneCollapsed(cwd),
  );
  // True once a collapse has finished sliding (or when the pane mounted
  // collapsed). Opening clears it immediately so the tree is visible for the
  // slide; collapsing sets it on transitionend, with a timer as the fallback.
  const [settled, setSettled] = useState(collapsed);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSettleTimer = () => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  };
  const toggle = useCallback(() => {
    if (!collapsed) {
      saveDesignPaneCollapsed(cwd, true);
      setCollapsed(true);
      return;
    }
    saveDesignPaneCollapsed(cwd, false);
    // Two steps on open: un-hide the body first, then start the slide on the
    // next frame. A `display: none` element has no computed opacity to
    // transition FROM, so flipping both in one commit slides the height but
    // pops the tree in at full opacity instead of fading it with the slide.
    setSettled(false);
    requestAnimationFrame(() => setCollapsed(false));
  }, [collapsed, cwd]);
  useEffect(() => {
    clearSettleTimer();
    if (!collapsed) {
      setSettled(false);
      return;
    }
    settleTimerRef.current = setTimeout(
      () => setSettled(true),
      DESIGN_PANE_SLIDE_MS + 50,
    );
    return clearSettleTimer;
  }, [collapsed]);
  const onTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.propertyName !== "height") return;
      if (collapsed) setSettled(true);
    },
    [collapsed],
  );

  return (
    <section
      data-testid="design-files-section"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={DESIGN_FILES_LABEL}
      // The open height must match DESIGN_PANE_OPEN_FRACTION. The column is a
      // flex column with a definite height, so the percentage resolves;
      // `shrink-0` keeps the code tree above from squeezing it, and
      // `overflow-hidden` is what clips the tree during the slide.
      className="border-border1 flex shrink-0 flex-col overflow-hidden border-t transition-[height] duration-200 ease-out motion-reduce:transition-none"
      style={{
        height: collapsed
          ? DESIGN_PANE_HEADER_HEIGHT + DESIGN_PANE_BORDER
          : `${DESIGN_PANE_OPEN_FRACTION * 100}%`,
      }}
      onTransitionEnd={onTransitionEnd}
    >
      <button
        type="button"
        data-testid="design-files-header"
        aria-expanded={!collapsed}
        onClick={toggle}
        // `group` so the collapsed chevron can key off the header's hover.
        className="group text-fg2 hover:bg-bg1-hover hover:text-fg1 flex w-full shrink-0 items-center gap-1 px-2.5 text-left text-xs font-medium transition-colors duration-120 ease-out"
        style={{ height: DESIGN_PANE_HEADER_HEIGHT }}
      >
        <span className="truncate">{DESIGN_FILES_LABEL}</span>
        {/* The chevron trails the label. Open, it is always shown (the
            section's state is worth a glance). Collapsed, the header reads as
            a plain footer label and the affordance appears only on hover or
            keyboard focus — it is still in the DOM for the hit target. */}
        {collapsed ? (
          <ChevronRight className="size-3.5 shrink-0 opacity-0 transition-opacity duration-120 ease-out group-hover:opacity-100 group-focus-visible:opacity-100" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
      </button>
      <div
        data-testid="design-files-body"
        // Fills the rest of the half-column under the header; `min-h-0` is
        // what lets the tree inside scroll instead of overflowing. Fades with
        // the slide; hidden (not unmounted — see the header note) only once a
        // collapse has settled.
        className={cn(
          "min-h-0 flex-1 transition-opacity duration-200 ease-out motion-reduce:transition-none",
          collapsed ? "opacity-0" : "opacity-100",
          collapsed && settled && "hidden",
        )}
      >
        <WorkspaceFileTree
          // Inactive while hidden: the tree stops observing and loading, and
          // its model — expansion, selection, scroll — waits untouched.
          active={active && !collapsed}
          cwd={cwd}
          reloadKey={reloadKey}
          designFilter="only-design"
          initialSelectedPath={initialSelectedPath}
          selectedPath={selectedPath}
          scrollMemoryKey={scrollMemoryKey}
          onOpenFile={onOpenFile}
          onOpenInNewTab={onOpenInNewTab}
          paddingTop={DESIGN_PANE_TREE_PAD_TOP}
          className="h-full"
        />
      </div>
    </section>
  );
}

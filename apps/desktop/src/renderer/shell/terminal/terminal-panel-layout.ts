// ──────────────────────────────────────────────────────────
// Terminal-panel layout — global terminal panel size + expansion state
// ──────────────────────────────────────────────────────────
//
// Terminal panel's height and collapsed state are shared across every workspace and
// repo, exactly like the repository panel and conversation pane widths: resize it once and
// switching workspaces is a clean switch with no layout jump. Terminal
// sessions and the selected terminal tab remain per-workspace in
// terminal-store.ts; this store owns layout only.

import { create } from "zustand";

export const TERMINAL_PANEL_DEFAULT_PCT = 50;
export const TERMINAL_PANEL_MIN_PCT = 5;
export const TERMINAL_PANEL_MAX_PCT = 95;

// ── Seam geometry ─────────────────────────────────────────
// These live in this leaf module (not in the resizer component) because
// BOTH the drag clamp and the panel's CSS `flex-basis: clamp(...)` are
// built from them. Two spellings of the same floor is how a drag ends up
// clamping against one bound while CSS renders another — the snap-back
// the proportional-columns work removed. See the lockstep test in
// apps/desktop/src/renderer/shell/__tests__/workspace-pane-sizing.test.ts.

/** The panel's own pixel floor while expanded. */
export const TERMINAL_PANEL_MIN_PX = 140;
/** Workbench's pixel floor — the panel may never grow past it. */
export const WORKBENCH_CONTENT_MIN_PX = 180;
/** The 1px seam between workbench and the panel. */
export const TERMINAL_SEAM_PX = 1;
/** Panel height beyond which workbench would breach its floor. */
export const TERMINAL_PANEL_MAX_OFFSET_PX =
  WORKBENCH_CONTENT_MIN_PX + TERMINAL_SEAM_PX;

/** The panel's committed height, as a percentage of workbench. The seam uses a
 *  direct `flex-basis` override during live movement, then writes this once on
 *  release; changing an inherited custom property every frame would otherwise
 *  invalidate the complete xterm descendant tree. */
export const TERMINAL_PANEL_HEIGHT_VAR = "--zeros-terminal-panel-height";

const STORAGE_KEY = "zeros:terminal-panel:layout-v2";
/** Pre-global per-folder layouts; superseded by the single shared layout. */
const LEGACY_STORAGE_KEY = "zeros:terminal-panel:layout-by-folder-v1";

export interface TerminalPanelLayout {
  expanded: boolean;
  heightPct: number;
}

export const DEFAULT_TERMINAL_PANEL_LAYOUT: Readonly<TerminalPanelLayout> =
  Object.freeze({
    expanded: true,
    heightPct: TERMINAL_PANEL_DEFAULT_PCT,
  });

export function clampTerminalPanelHeightPct(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_PANEL_DEFAULT_PCT;
  return Math.max(
    TERMINAL_PANEL_MIN_PCT,
    Math.min(TERMINAL_PANEL_MAX_PCT, value),
  );
}

/** Validate a persisted layout without trusting arbitrary localStorage data. */
export function normalizeTerminalPanelLayout(
  value: unknown,
): TerminalPanelLayout {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...DEFAULT_TERMINAL_PANEL_LAYOUT };
  const record = value as Record<string, unknown>;
  return {
    expanded: typeof record.expanded === "boolean" ? record.expanded : true,
    heightPct: clampTerminalPanelHeightPct(
      typeof record.heightPct === "number"
        ? record.heightPct
        : TERMINAL_PANEL_DEFAULT_PCT,
    ),
  };
}

/** The persisted layout, validated. Exported because the pre-render boot
 *  path publishes the height as an inherited CSS variable before React's
 *  first render — see apps/desktop/src/renderer/shell/boot-layout-vars.ts. */
export function readPersistedTerminalPanelLayout(): TerminalPanelLayout {
  return loadLayout();
}

function loadLayout(): TerminalPanelLayout {
  if (typeof window === "undefined")
    return { ...DEFAULT_TERMINAL_PANEL_LAYOUT };
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw
      ? normalizeTerminalPanelLayout(JSON.parse(raw))
      : { ...DEFAULT_TERMINAL_PANEL_LAYOUT };
  } catch {
    return { ...DEFAULT_TERMINAL_PANEL_LAYOUT };
  }
}

function persistLayout(layout: TerminalPanelLayout): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is non-essential (quota / private mode).
  }
}

interface TerminalPanelLayoutState {
  layout: TerminalPanelLayout;
  setExpanded(expanded: boolean): void;
  setHeightPct(heightPct: number): void;
  /** Double-click behavior: expanded, exactly centered. */
  reset(): void;
}

export const useTerminalPanelLayoutStore = create<TerminalPanelLayoutState>(
  (set) => ({
    layout: loadLayout(),

    setExpanded(expanded) {
      set((state) => {
        if (state.layout.expanded === expanded) return state;
        const layout = { ...state.layout, expanded };
        persistLayout(layout);
        return { layout };
      });
    },

    setHeightPct(heightPct) {
      const clamped = clampTerminalPanelHeightPct(heightPct);
      set((state) => {
        if (state.layout.heightPct === clamped) return state;
        const layout = { ...state.layout, heightPct: clamped };
        persistLayout(layout);
        return { layout };
      });
    },

    reset() {
      set((state) => {
        if (
          state.layout.expanded &&
          state.layout.heightPct === TERMINAL_PANEL_DEFAULT_PCT
        )
          return state;
        const layout = { ...DEFAULT_TERMINAL_PANEL_LAYOUT };
        persistLayout(layout);
        return { layout };
      });
    },
  }),
);

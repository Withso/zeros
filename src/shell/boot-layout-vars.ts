// ──────────────────────────────────────────────────────────
// Boot layout variables — persisted panel sizes, before first render
// ──────────────────────────────────────────────────────────
//
// Why this exists (the launch-time "resize glitch"):
//
// Column 2's grow factor reads `--zeros-column-2-ratio`, and the variable
// used to be written ONLY by a layout effect on the two-column row. Layout
// effects run child-before-parent, and a child that measures — ChatPane's
// split-availability `getBoundingClientRect()` in column2-panes.tsx — forces
// a style + layout flush BEFORE that write lands. So the browser resolved
// column 2 once at the `0.5` fallback (a 50/50 split), and the ratio write
// that followed was a *second* style change on an element that already had
// a resolved value. A second style change with a different computed value is
// exactly what starts a CSS transition, so every launch animated the columns
// from 50/50 to the user's saved split.
//
// Writing the variable onto <html> before React's first render fixes the
// cause rather than the symptom: the flush already sees the real value, the
// row's own write is a no-op, and nothing can transition. The row-scoped
// write still wins during a drag (an inline value on a descendant shadows
// the inherited one), so per-frame drag updates stay scoped to the two
// columns exactly as before.
//
// Keep this module dependency-light: it is imported by main.tsx on the
// critical boot path, so it must not drag the chat tree in behind it.

import { COLUMN_2_RATIO_VAR, readPersistedColumn2Ratio } from "./column2-ratio";
import {
  DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
  readPersistedDesignWorkspaceSidebarRatio,
} from "../zeros/panels/design-workspace-width";
import {
  TERMINAL_PANEL_HEIGHT_VAR,
  readPersistedTerminalPanelLayout,
} from "./terminal/terminal-panel-layout";

/** Publish every persisted layout size as an inherited CSS variable, so the
 *  first style resolution of the app already has the user's real layout.
 *  Idempotent and safe to call before the DOM has any app content.
 *
 *  Both variables are re-published later on the elements that own them (the
 *  two-column row, the terminal panel), which is what a drag updates. These
 *  root-level values exist only so that nothing resolves against the CSS
 *  fallback first — an inline value on a descendant shadows them. */
export function applyBootLayoutVars(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  try {
    root.style.setProperty(
      COLUMN_2_RATIO_VAR,
      String(readPersistedColumn2Ratio()),
    );
    root.style.setProperty(
      DESIGN_WORKSPACE_SIDEBAR_RATIO_VAR,
      String(readPersistedDesignWorkspaceSidebarRatio()),
    );
    root.style.setProperty(
      TERMINAL_PANEL_HEIGHT_VAR,
      `${readPersistedTerminalPanelLayout().heightPct}%`,
    );
  } catch {
    // A missing/again-restricted localStorage already falls back to the
    // default inside the readers; a failed style write just means the CSS
    // fallback applies, which is the pre-existing behaviour.
  }
}

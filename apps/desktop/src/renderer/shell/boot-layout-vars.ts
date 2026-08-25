// ──────────────────────────────────────────────────────────
// Boot layout variables — persisted panel sizes, before first render
// ──────────────────────────────────────────────────────────
//
// Why this exists (the launch-time "resize glitch"):
//
// Conversation pane's grow factor reads `--zeros-column-2-ratio`, and the variable
// used to be written ONLY by a layout effect on the two-column row. Layout
// effects run child-before-parent, and a child that measures — ChatPane's
// split-availability `getBoundingClientRect()` in conversation/pane-layout.tsx — forces
// a style + layout flush BEFORE that write lands. So the browser resolved
// conversation pane once at the `0.5` fallback (a 50/50 split), and the ratio write
// that followed was a *second* style change on an element that already had
// a resolved value. A second style change with a different computed value is
// exactly what starts a CSS transition, so every launch animated the columns
// from 50/50 to the user's saved split.
//
// Writing the variable onto <html> before React's first render fixes the
// cause rather than the symptom: the flush already sees the real value, the
// row's own write is a no-op, and nothing can transition. During a drag the
// two column flex items receive direct `flex-grow` overrides; on release the
// row publishes the final committed variable once and those overrides are
// removed without changing the resolved geometry.
//
// Keep this module dependency-light: it is imported by main.tsx on the
// critical boot path, so it must not drag the chat tree in behind it.

import {
  CONVERSATION_RATIO_VAR,
  readPersistedConversationRatio,
} from "./conversation/pane-sizing";
import {
  DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
  DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
  readPersistedDesignWorkspaceLayersWidth,
  readPersistedDesignWorkspaceStyleWidth,
} from "../features/design-workspace/design-workspace-width";
import {
  TERMINAL_PANEL_HEIGHT_VAR,
  readPersistedTerminalPanelLayout,
} from "./terminal/terminal-panel-layout";

/** Publish every persisted layout size as an inherited CSS variable, so the
 *  first style resolution of the app already has the user's real layout.
 *  Idempotent and safe to call before the DOM has any app content.
 *
 *  Both variables are re-published later on the elements that own them (the
 *  two-column row and terminal panel) when a drag commits. Live frames use
 *  direct standard flex properties, so these root-level values only ensure
 *  that nothing resolves against the CSS fallback first. */
export function applyBootLayoutVars(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  try {
    root.style.setProperty(
      CONVERSATION_RATIO_VAR,
      String(readPersistedConversationRatio()),
    );
    root.style.setProperty(
      DESIGN_WORKSPACE_LAYERS_WIDTH_VAR,
      `${readPersistedDesignWorkspaceLayersWidth()}px`,
    );
    root.style.setProperty(
      DESIGN_WORKSPACE_STYLE_WIDTH_VAR,
      `${readPersistedDesignWorkspaceStyleWidth()}px`,
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

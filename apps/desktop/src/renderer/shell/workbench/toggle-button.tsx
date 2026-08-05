// ──────────────────────────────────────────────────────────
// Workbench toggle button
// ──────────────────────────────────────────────────────────
//
// The design-panel collapse control can be rendered as a DOM descendant of
// whichever header owns its geographic slot:
//
//   Workbench toggle  → inside Workbench's header drag region when workbench is open;
//                   inside Conversation pane's topbar (at the right) when workbench is
//                   collapsed.
//
// Why descendants, not absolute overlays:
//
//   Electron's `-webkit-app-region: no-drag` only subtracts from a
//   drag rect when the no-drag element is a DOM descendant of that
//   drag rect's element. Sibling no-drag overlays in a different
//   subtree (the old WindowChrome pattern) DON'T subtract — the OS
//   hit-test treats clicks at that geographic point as window-drag
//   intents and the React onClick never fires. Nesting the controls
//   inside the drag rect is the only arrangement Chromium's hit-test
//   honours, and it is what shipping Electron title bars converge on.
//
// The Zeros Foundation Button styling stays identical to the old WindowChrome
// overlays — only the DOM home changes.
// ──────────────────────────────────────────────────────────

import React from "react";
import { PanelRight } from "lucide-react";
import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";

// 2026-05-28 — chrome icon recipe: 24 × 24 container, 16 × 16 icon
// glyph (16 px is the Button base via `[&_svg]:size-4`), 1 px stroke.
const TOGGLE_BTN_CLS =
  "size-6 shrink-0 text-fg2 hover:text-fg1 [&_svg]:stroke-[1]";

interface WorkbenchToggleButtonProps {
  workbenchCollapsed: boolean;
  onToggle: () => void;
}

export function WorkbenchToggleButton({
  workbenchCollapsed,
  onToggle,
}: WorkbenchToggleButtonProps) {
  return (
    <Tooltip label={workbenchCollapsed ? "Show panel" : "Hide panel"} shortcut="⌥⌘B">
      <Button
        variant="ghost"
        size="icon-sm"
        className={TOGGLE_BTN_CLS}
        onClick={onToggle}
        aria-label={workbenchCollapsed ? "Show design panel" : "Hide design panel"}
      >
        <PanelRight strokeWidth={1} />
      </Button>
    </Tooltip>
  );
}

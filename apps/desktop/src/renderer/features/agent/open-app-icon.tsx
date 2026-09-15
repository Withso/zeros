// ──────────────────────────────────────────────────────────
// OpenAppIcon — the mark for an "Open in …" app row
// ──────────────────────────────────────────────────────────
//
// One renderer for every menu that lists apps a path can be opened with
// (the workspace header's Open-in split button + pane submenu, the settings
// page's per-agent config card). Shows the REAL installed-app icon when
// detection extracted one (open-apps.ts — Finder, Xcode, Cursor, …) and falls
// back to a bundled/lucide mark otherwise, so Finder is the blue smiley
// everywhere instead of a generic folder glyph in one place.
// ──────────────────────────────────────────────────────────

import { Code, Folder, Terminal as TerminalIcon } from "lucide-react";

import {
  FINDER_APP_ID,
  TERMINAL_APP_ID,
  type DetectedOpenApp,
} from "../../platform/open-apps";
import { AgentIcon } from "./agent-icon";

/** An app's mark: the real installed-app icon when detection extracted
 *  one, else a bundled/lucide fallback per app. */
export function OpenAppIcon({ app }: { app: DetectedOpenApp }) {
  if (app.iconDataUrl) {
    return (
      <img
        src={app.iconDataUrl}
        alt=""
        draggable={false}
        className="size-4 shrink-0"
      />
    );
  }
  if (app.id === FINDER_APP_ID) return <Folder className="text-fg2 size-3.5" />;
  if (app.id === TERMINAL_APP_ID)
    return <TerminalIcon className="text-fg2 size-3.5" />;
  // Reuse bundled monochrome marks when a CLI has no application bundle or
  // native icon extraction misses.
  if (app.id === "opencode" || app.id === "cursor") {
    return (
      <AgentIcon
        agentId={app.id}
        iconUrl={null}
        size={14}
        monochrome
        className="text-fg2"
      />
    );
  }
  return <Code className="text-fg2 size-3.5" />;
}

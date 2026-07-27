// ──────────────────────────────────────────────────────────
// Sticky defaults — persisted choices for the empty composer
// ──────────────────────────────────────────────────────────
//
// Remembers the agent / folder / model / effort / permission-mode
// the user last picked in the "New Chat" surface, so the empty
// composer doesn't lose state across reloads. Lives in its own
// module (not inside empty-composer.tsx) so that file can export
// only React components — required for Vite Fast Refresh.
// ──────────────────────────────────────────────────────────

import type { ChatEffort, ChatPermissionMode } from "../zeros/store/store";
import { getSetting, setSetting } from "../native/settings";

const STICKY_DEFAULTS_KEY = "new-agent-sticky-defaults";

export interface StickyDefaults {
  agentId: string | null;
  folder: string | null;
  model: string | null;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
}

const STICKY_FALLBACK: StickyDefaults = {
  agentId: null, folder: null, model: null, effort: "high", permissionMode: "auto",
};

const VALID_EFFORTS = new Set<ChatEffort>([
  "low", "medium", "high", "xhigh", "max", "ultracode",
]);
const VALID_MODES = new Set<ChatPermissionMode>([
  "plan", "auto", "tool-approval", "danger",
]);

export function loadStickyDefaults(): StickyDefaults {
  const raw = getSetting<Partial<StickyDefaults> | null>(STICKY_DEFAULTS_KEY, null);
  if (!raw || typeof raw !== "object") return STICKY_FALLBACK;
  return {
    agentId: typeof raw.agentId === "string" ? raw.agentId : null,
    folder: typeof raw.folder === "string" ? raw.folder : null,
    model: typeof raw.model === "string" ? raw.model : null,
    effort: raw.effort && VALID_EFFORTS.has(raw.effort) ? raw.effort : "high",
    permissionMode:
      raw.permissionMode && VALID_MODES.has(raw.permissionMode) ? raw.permissionMode : "auto",
  };
}

export function saveStickyDefaults(d: StickyDefaults): void {
  setSetting(STICKY_DEFAULTS_KEY, d);
}

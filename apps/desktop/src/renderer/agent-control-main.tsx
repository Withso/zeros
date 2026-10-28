// ──────────────────────────────────────────────────────────
// Zeros desktop renderer — agent control bar entry
// ──────────────────────────────────────────────────────────
//
// Loaded by agent-control.html into the small transparent view that main
// stacks over a page an agent is controlling
// (apps/desktop/electron/agent-control/overlay.ts). The page gets only the
// agent-control preload, never the app's native bridge.
// ──────────────────────────────────────────────────────────

import { createRoot } from "react-dom/client";
import "../../../../styles/zeros-tokens.css";
import "../../../../styles/semantic-tokens.css";
import "../../../../styles/globals.css";
import "./shared/ui/focus-navigation";
import {
  AgentControlOverlay,
  type AgentControlOverlayBridge,
} from "./features/agent-control/agent-control-overlay";

declare global {
  interface Window {
    __ZEROS_AGENT_CONTROL__?: AgentControlOverlayBridge;
  }
}

// Main mirrors the app's appearance mode into nativeTheme.themeSource, which
// is what prefers-color-scheme reports here. No pre-paint stamp is needed:
// the bar starts hidden.
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () =>
  document.documentElement.setAttribute(
    "data-theme",
    prefersDark.matches ? "dark" : "light",
  );
applyTheme();
prefersDark.addEventListener("change", applyTheme);

const bridge = window.__ZEROS_AGENT_CONTROL__;
const rootEl = document.getElementById("root");
if (bridge && rootEl) {
  createRoot(rootEl).render(<AgentControlOverlay bridge={bridge} />);
}

// ──────────────────────────────────────────────────────────
// Zeros Mac App — Entry Point (Electron renderer + Vite browser dev)
// ──────────────────────────────────────────────────────────
//
// This is loaded by index.html, which Electron opens in app mode
// and which Vite serves in `pnpm dev` for
// browser-based iteration. One entry, one layout.
// ──────────────────────────────────────────────────────────

import { createRoot } from "react-dom/client";
import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";
import { AppShell } from "./app-shell";
import { ErrorBoundary } from "./zeros/ui/error-boundary";
import { initRendererLogCapture } from "./zeros/logging/renderer-log";

// Structured log capture FIRST — everything the renderer logs from here on
// (React warnings, bridge chatter, agent lifecycle) lands in the shared
// app.jsonl store that feedback submissions can attach. No-op outside Electron.
initRendererLogCapture();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

// Guard: refuse to mount when this document is loaded inside an
// iframe (window.parent !== window). The Mac app's column-3 browser
// uses an <iframe>; iframes don't receive the Electron preload, so a
// Zeros copy loaded inside one would lack `window.__ZEROS_NATIVE__`
// and fire the "Native runtime not detected" toast immediately. It
// would also spawn a duplicate WebSocket bridge, session provider,
// and toast layer — invisible to the user but consuming resources
// and racing the parent for engine state. The most common way to hit
// this is the user typing the Vite dev URL (or any URL that resolves
// to it via the omnibox shorthand) into the in-app browser. Render
// a small notice instead so the cause is unambiguous.
if (window.parent !== window) {
  // Plain innerHTML (not React) because this fires before mounting
  // anything else — keep the path dependency-free. Token CSS is
  // already imported above so semantic classes resolve correctly.
  rootEl.innerHTML = `
    <div class="flex h-screen flex-col items-center justify-center gap-2 bg-bg1 p-6 text-center text-fg1">
      <div class="text-sm font-medium">
        Zeros can't run inside an embedded browser.
      </div>
      <div class="max-w-sm text-xs text-fg3">
        Open Zeros from its Dock icon or main window. Loading the
        dev URL into the Column&nbsp;3 browser tab spawns a duplicate
        copy without the native runtime.
      </div>
    </div>
  `;
} else {
  // Wrap the whole app in an error boundary. A runtime throw anywhere
  // in the tree (a half-applied HMR update, a null-deref in a renderer,
  // a bad module after a dependency change) otherwise unmounts React
  // entirely and leaves #root empty — an indistinguishable-from-dead
  // black window. The boundary replaces that void with a recoverable
  // error surface instead.
  //
  // Desktop/Electron is the only target now (the web app + relay were removed).
  // AppShell gates login internally (email-OTP / OAuth).
  const Root = AppShell;
  createRoot(rootEl).render(
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>,
  );
}


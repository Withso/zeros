// ──────────────────────────────────────────────────────────
// Developer Tools — availability, toggle mode, self-XSS guard
// ──────────────────────────────────────────────────────────
//
// HISTORY. Packaged builds used to slam DevTools shut the instant anything
// opened it:
//
//   win.webContents.on("devtools-opened", () => win.webContents.closeDevTools());
//
// The intent was to stop token/secret extraction at an unattended machine. The
// effect was that ⌥⌘I in Alpha, Beta and Production opened DevTools, squeezed
// the three-column layout to make room for the docked panel, and then tore it
// all back down a frame later — a visible jolt, and no usable DevTools on any
// shipped build. That block is gone; this module is what replaced it.
//
// THE TRADE, STATED HONESTLY. The block was not pure theatre. `keychain_get`,
// `auth_get_access_token` and friends are on the preload allowlist
// (electron/preload.ts), so an open console really can read live credentials out
// of a signed-in app — the block genuinely raised the cost of walking up to an
// unattended, unlocked machine and lifting a DURABLE token (as opposed to just
// using the already-signed-in app in front of you).
//
// It is still the wrong trade:
//
//   • The control that actually addresses "unattended unlocked machine" is the
//     OS screen lock. DevTools is one path of several; the preload bridge is
//     reachable from any renderer-side code execution, which is precisely why
//     the allowlist + sandbox + contextIsolation exist. The IPC boundary is
//     already designed for an untrusted renderer.
//   • The cost was total: no debugging on Alpha, Beta or Production — the builds
//     whose bugs matter most and the ones a maintainer can least afford to be
//     blind on. Field bugs that only reproduce in a packaged build had no
//     inspection path at all.
//
// The threat an open console uniquely enables — and the one worth mitigating
// here — is SELF-XSS: "paste this in the console and you'll unlock X". That is
// social engineering, and the industry-standard answer is a loud console
// banner, not a disabled console. See installDevToolsGuard below.
//
// If Production ever needs re-gating, do it deliberately rather than by
// re-adding the force-close: mirror a staff/internal flag into
// <userData>/app-settings.json (electron/ipc/commands/app.ts) so MAIN can read
// it — main cannot see renderer localStorage — and gate the menu item on that.
//
// DETACHED, ALWAYS. DevTools opens in its own window, never docked. This app's
// renderer is a three-column layout with hard per-column minimums summing to
// MAIN_WINDOW_MIN_WIDTH, under a `titleBarStyle: "hiddenInset"` custom titlebar.
// A docked DevTools panel steals width from the live viewport, pushing it under
// those minimums — the columns overlap and the traffic-light inset lands in the
// wrong place. Detaching sidesteps all of it, and matches what dev has always
// done (`ZEROS_DEVTOOLS=1` opens `{ mode: "detach" }`). The mode argument only
// applies at open time: DevTools' own "Dock side" control still works for
// anyone who wants it docked for a session.
//
// Type-only `electron` import ON PURPOSE — it keeps this module loadable under
// vitest (the `electron` module cannot be required outside an Electron host,
// which is why electron/__tests__/updater-channel-feeds.test.ts has to parse
// source text instead of importing).
// ──────────────────────────────────────────────────────────

import type { BrowserWindow } from "electron";
import { channel, type Channel } from "../src/engine/runtime";
import { IS_PACKAGED } from "./runtime-mode";

/** The DevTools chord, per platform. Chromium's own default and the one every
 *  user already has in muscle memory: ⌥⌘I on macOS, Ctrl+Shift+I elsewhere.
 *  Spelled out rather than left to `role: "toggleDevTools"` because the menu
 *  item now carries a custom click handler (detached mode + window resolution),
 *  and a custom item gets no accelerator for free. Pure — exported for tests. */
export function devToolsAccelerator(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I";
}

/** Should opening DevTools print the self-XSS banner?
 *
 *  Production ONLY. Alpha and Beta are the maintainer/dogfood channels — the
 *  people opening DevTools there are the people who wrote the app, and nagging
 *  them on every open would train them to ignore the banner by the time they
 *  see it somewhere it matters. Dev likewise. Pure — exported for tests. */
export function shouldWarnOnDevToolsOpen(
  packaged: boolean,
  ch: Channel,
): boolean {
  return packaged && ch === "stable";
}

/** The banner, as a self-contained IIFE evaluated in the renderer.
 *
 *  Runs through the renderer's PATCHED console (src/zeros/logging/renderer-log.ts)
 *  by design: the original console still runs, so the styling lands in DevTools,
 *  AND one record per open lands in app.jsonl — a free audit trail of "DevTools
 *  was opened on this install", which the feedback log export carries.
 *
 *  Wrapped in try/catch so a console shape we didn't anticipate can never turn a
 *  DevTools open into a renderer exception. Exported for tests. */
export const SELF_XSS_CONSOLE_SCRIPT = `(() => {
  try {
    const headline = [
      "color:#fff",
      "background:#b3261e",
      "font-size:26px",
      "font-weight:700",
      "padding:6px 14px",
      "border-radius:6px",
    ].join(";");
    const body = "font-size:13px;line-height:1.6";
    console.log("%cStop", headline);
    console.log(
      "%cThis is a developer console.\\n\\n" +
        "If someone told you to paste something here, it is a scam. Pasting code " +
        "here can hand them your Zeros account, your connected Git provider, and " +
        "every credential this app holds.\\n\\n" +
        "Nothing legitimate ever asks you to do that.",
      body,
    );
  } catch {
    /* the banner must never break the renderer */
  }
})()`;

/** Wire a window's DevTools policy. Call once per BrowserWindow.
 *
 *  Deliberately does NOT close DevTools — see the header. All this installs is
 *  the Production self-XSS banner. `channel()` is read INSIDE the handler, not
 *  at install time, because main.ts seeds `process.env.ZEROS_CHANNEL` during
 *  boot and reading it early would bake in the wrong answer (the same lazy-read
 *  rule electron/deep-link.ts follows for the URL scheme). */
export function installDevToolsGuard(win: BrowserWindow): void {
  win.webContents.on("devtools-opened", () => {
    if (!shouldWarnOnDevToolsOpen(IS_PACKAGED, channel())) return;
    if (win.isDestroyed()) return;
    void win.webContents
      .executeJavaScript(SELF_XSS_CONSOLE_SCRIPT, true)
      .catch(() => {
        /* best-effort — a banner that failed to print must not surface */
      });
  });
}

/** Toggle DevTools for `win`, opening DETACHED.
 *
 *  Null/destroyed-safe so callers don't have to re-check: the menu's window
 *  resolution can legitimately come up empty (all windows closed on macOS while
 *  the app stays alive). */
export function toggleDevTools(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const contents = win.webContents;
  if (contents.isDevToolsOpened()) {
    contents.closeDevTools();
    // Closing a DETACHED DevTools window leaves macOS focus wherever it lands —
    // often on whatever app was behind it, since the window that had focus just
    // ceased to exist. Pull the app window back so ⌥⌘I reads as a toggle
    // rather than as "the app went away".
    if (!win.isDestroyed()) win.focus();
    return;
  }
  contents.openDevTools({ mode: "detach" });
}

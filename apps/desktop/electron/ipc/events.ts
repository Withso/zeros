// ──────────────────────────────────────────────────────────
// Zeros Electron — event bus (main → renderer)
// ──────────────────────────────────────────────────────────
//
// Electron has no app-wide renderer event analogue by default.
// We channel all events through a single IPC message ("zeros:event")
// tagged with a name, so the preload can route them to the renderer's
// subscribers by name. This lets the same facade code in the renderer
// subscribe to `project-changed`, `deep-link`, etc.
// subscribe through one native-shell abstraction.
//
// Event names (canonical across native-shell emissions):
//   project-changed    { root: string, port: number }
//   project-opening    { root: string } (early "folder picked" signal, pre-respawn)
//   menu-open-project  {} (File → Open Folder / Cmd+O → renderer openProject)
//   deep-link          string
//   engine-restarted   { port: number }
//   engine-crash       { ... } (watchdog could not respawn)
//   gh:device-code     { ... } (GitHub device-flow verification code)
//   auth-error / auth-handoff   (legacy deep-link OAuth handoff)
//   auth-signin-complete / auth-signin-error (main-owned WorkOS hosted flow)
//   updater-status     { ... } (auto-updater progress)
//   main-process-error { ... }
//   browser-confirmation-request { ... } (trusted consequence prompt)
//   browser-session-state { ... } (Zeros-owned browser activity)
//   browser-frame-navigated { frameName, url, title, loading, inPage?, cancelled?, cancelledUrl? }
//   browser-frame-favicon { frameName, pageUrl, faviconDataUrl }
// ──────────────────────────────────────────────────────────

import type { BrowserWindow } from "electron";

export const IPC_EVENT_CHANNEL = "zeros:event";

export interface ZerosEventEnvelope {
  name: string;
  payload: unknown;
}

let mainWindow: BrowserWindow | null = null;

// COLD-LAUNCH BUFFER. When the app is launched BY a zeros:// deep link (e.g. an
// OAuth handoff `zeros://auth/callback#code=…`), the URL is handled before the
// BrowserWindow exists, so a naive send would drop silently and the sign-in
// would never complete. We buffer events emitted before the FIRST window binds
// and flush them once the renderer has loaded (+ a short grace so its React
// subscribers have mounted). Bounded, and only active until the first window —
// a mid-session window close/reopen does NOT buffer (avoids replaying stale
// agent/pty traffic). The auth-handoff payload is single-use (code + nonce), so
// a slightly-late delivery is safe.
let everHadWindow = false;
const preWindowBuffer: ZerosEventEnvelope[] = [];
const MAX_PRE_WINDOW_EVENTS = 50;
const PRE_WINDOW_FLUSH_DELAY_MS = 800;

/** The live main window, or null when none is open (macOS keeps the app running
 *  with every window closed).
 *
 *  The app only ever owns ONE window, and this module already tracks it for
 *  event delivery — so this is the authoritative handle for anything outside
 *  main.ts that needs to act on "the app window". Prefer it over
 *  `BrowserWindow.getFocusedWindow()`, which can hand back a window we did not
 *  create: a DETACHED DevTools window holds focus the whole time the user is
 *  typing in the console, and toggling DevTools on THAT opens
 *  DevTools-on-DevTools instead of closing the panel. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Called once from main.ts after BrowserWindow creation. */
export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (!everHadWindow) {
    everHadWindow = true;
    if (preWindowBuffer.length > 0) {
      const pending = preWindowBuffer.splice(0, preWindowBuffer.length);
      // Flush after the renderer document has loaded, plus a short grace so the
      // renderer's event subscribers (e.g. AuthProvider's auth-handoff listener)
      // have mounted before we send.
      win.webContents.once("did-finish-load", () => {
        setTimeout(() => {
          if (win.isDestroyed()) return;
          for (const envelope of pending) {
            win.webContents.send(IPC_EVENT_CHANNEL, envelope);
          }
        }, PRE_WINDOW_FLUSH_DELAY_MS);
      });
    }
  }
}

/** Resolve once the renderer can actually receive events.
 *
 *  The cold-launch buffer above only covers emitters that run BEFORE the first
 *  window binds. A deep-link handler that awaits anything (`app.whenReady()`,
 *  safeStorage, a network call) resumes AFTER main.ts created the window in the
 *  same whenReady turn, so `emitEvent` takes the direct-send path into a
 *  document whose JS has not run yet and the event is dropped. Awaiting this
 *  first restores the buffer's guarantee — same `did-finish-load` + subscriber
 *  grace, so it holds for a mid-session window too. */
export async function whenRendererReady(): Promise<void> {
  const win = getMainWindow();
  if (!win) return; // No window yet → emitEvent still buffers.
  if (win.webContents.isLoadingMainFrame()) {
    await new Promise<void>((resolve) => {
      // Settle on any terminal outcome, and detach all three so repeated calls
      // cannot accumulate listeners on a long-lived window.
      const done = () => {
        win.webContents.off("did-finish-load", done);
        win.webContents.off("did-fail-load", done);
        win.off("closed", done);
        resolve();
      };
      win.webContents.once("did-finish-load", done);
      win.webContents.once("did-fail-load", done);
      win.once("closed", done);
    });
    if (win.isDestroyed()) return;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, PRE_WINDOW_FLUSH_DELAY_MS),
    );
  }
}

/** Emit a named event to the renderer. Safe to call before the window exists or
 *  after it's closed. Before the FIRST window it buffers (cold-launch deep
 *  links); otherwise it drops silently. */
export function emitEvent(name: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!everHadWindow && preWindowBuffer.length < MAX_PRE_WINDOW_EVENTS) {
      preWindowBuffer.push({ name, payload });
    }
    return;
  }
  const envelope: ZerosEventEnvelope = { name, payload };
  mainWindow.webContents.send(IPC_EVENT_CHANNEL, envelope);
}

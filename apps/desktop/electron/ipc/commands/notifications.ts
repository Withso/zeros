// ──────────────────────────────────────────────────────────
// IPC command: native notification via Electron's Notification API.
// ──────────────────────────────────────────────────────────
//
// The renderer's notify() facade (apps/desktop/src/renderer/platform/app.ts)
// routes to this command in the Mac app. macOS's
// NSUserNotificationCenter is reached via Electron's built-in
// Notification class — no plugin, no permission plumbing: the
// OS surfaces its own permission prompt on first display.
// ──────────────────────────────────────────────────────────

import { Notification } from "electron";
import type { CommandHandler } from "../router";

export const notifySend: CommandHandler = (args) => {
  // (Low) Cap renderer-supplied text so a buggy/compromised renderer can't spam
  // the notification center or spoof a long phishing OS notification.
  const title = String(args.title ?? "Zeros").slice(0, 200);
  const body =
    args.body !== undefined ? String(args.body).slice(0, 1000) : undefined;
  // Notification.isSupported() returns false in environments without
  // a notification center (CI, headless). Silent no-op matches the
  // native path's behavior when permission is denied.
  if (!Notification.isSupported()) return;
  const notif = new Notification({ title, body, silent: false });
  notif.show();
};

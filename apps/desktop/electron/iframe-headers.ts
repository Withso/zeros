// ──────────────────────────────────────────────────────────
// Iframe header stripping — make arbitrary URLs loadable as iframes
// ──────────────────────────────────────────────────────────
//
// Browser previews use an `<iframe>` so they participate in the renderer's DOM
// stacking and layout. The session removes only the framing restrictions that
// would otherwise prevent user-selected development URLs from loading there.
//
// What gets stripped from HTTP(S) subframe document responses:
//   1. `X-Frame-Options` — DENY / SAMEORIGIN responses would otherwise
//      refuse to render inside our iframe at all. Stripping removes
//      the framing restriction so any URL loads.
//   2. `Content-Security-Policy: frame-ancestors …` directive — same
//      problem at the CSP level. We surgically remove just the
//      `frame-ancestors` directive from the CSP string and leave the
//      rest of the policy intact. Other CSP directives (script-src,
//      img-src, etc.) keep the page's own security posture; we only
//      drop the bit that controls who's allowed to embed it.
//
// Scope: the session listener sees HTTP(S) traffic but mutates only resources
// whose Electron type is `subFrame`. The renderer document and scripts, XHR,
// styles, images, and other subresources retain their original headers.
//
// Iframe trade-offs:
//   - Lose per-tab Chromium process isolation. All iframes share the
//     main renderer process. A bad iframe can affect others. For an
//     embedded preview the accepted boundary is a URL explicitly selected by
//     the user, with the renderer sandbox and navigation policy still intact.
//   - Lose `webContents.debugger` (CDP) access. The element picker
//     uses `executeJavaScript` via `WebFrameMain.executeJavaScript`
//     instead — same capability for the inspect-element use case,
//     just one API level up.
//   - Some sites use JavaScript frame-busting (`if (top !== self) …`).
//     We don't try to defeat those; they just won't load. Primary
//     use case is the user's own dev server (no busting), so it's a
//     rare hit.
//
// This policy stays isolated because weakening upstream framing controls is a
// security-sensitive browser-session decision, not ordinary renderer layout.

import { type Session } from "electron";

/** Strip iframe-blocking headers from this session's http(s)
 *  responses. Idempotent — calling twice replaces the listener.
 *  Pass `win.webContents.session` from createMainWindow(). */
export function installIframeHeaderStripping(session: Session): void {
  session.webRequest.onHeadersReceived(
    // Filter: only http(s) — file:// renderer assets pass through.
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      // Only strip framing protections for subframe documents (the
      // browser-tab iframes, which must be able to frame arbitrary sites). The
      // app's own document and its sub-resources (scripts/xhr/styles) keep their
      // headers, so a stray framed resource elsewhere isn't silently un-protected.
      if (details.resourceType !== "subFrame") {
        callback({ cancel: false });
        return;
      }
      const headers = details.responseHeaders ?? {};
      const next: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (lower === "x-frame-options") {
          // Drop entirely.
          continue;
        }
        if (lower === "content-security-policy") {
          // Surgical: only remove `frame-ancestors` directive(s);
          // keep the rest of the CSP intact (script-src, img-src,
          // etc. still apply). The directive can be at any position,
          // semi-separated.
          const values = Array.isArray(value) ? value : [value];
          const stripped = values
            .map((v) => v.replace(/(?:^|;)\s*frame-ancestors[^;]*/gi, ""))
            .map((v) => v.replace(/^;\s*/, "").trim())
            .filter((v) => v.length > 0);
          if (stripped.length > 0) next[key] = stripped;
          continue;
        }
        next[key] = Array.isArray(value) ? value : [value];
      }
      callback({ cancel: false, responseHeaders: next });
    },
  );
}

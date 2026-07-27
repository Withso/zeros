// ──────────────────────────────────────────────────────────
// Iframe header stripping — make arbitrary URLs loadable as iframes
// ──────────────────────────────────────────────────────────
//
// Roadmap 03b — Phase 2 architectural pivot. We replaced
// `WebContentsView` (native overlay above all DOM) with `<iframe>`
// (DOM element, natural z-index). Cursor and Replit both ship
// iframe-based previews; the original Phase 2 rejection of iframes
// (cited "fails on CSP, cookies, cross-origin") goes away once you
// strip the two headers below.
//
// What gets stripped, on every http(s) response, before the
// renderer sees it:
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
// Scope: applied to ALL http/https responses in the session, not just
// browser-tab iframes. This is safe because:
//   - The Mac app's own renderer is loaded from file:// (prod) or
//     http://localhost:5193 (dev). file:// isn't matched by the http(s)
//     URL filter so the strip is a no-op there. localhost:5193's
//     responses don't carry X-Frame-Options or frame-ancestors anyway
//     (Vite doesn't set them), so the strip is also a no-op.
//   - The only http(s) responses that DO carry these headers are
//     external sites loaded into browser-tab iframes — exactly the
//     ones we want to strip for.
//
// Trade-off accepted (vs. WebContentsView):
//   - Lose per-tab Chromium process isolation. All iframes share the
//     main renderer process. A bad iframe can affect others. For an
//     IDE-embedded browser the trade-off is reasonable — we control
//     which URLs load (the user types them) and the IDE itself isn't
//     long-lived enough to accumulate cross-tab interference.
//   - Lose `webContents.debugger` (CDP) access. The element picker
//     uses `executeJavaScript` via `WebFrameMain.executeJavaScript`
//     instead — same capability for the inspect-element use case,
//     just one API level up.
//   - Some sites use JavaScript frame-busting (`if (top !== self) …`).
//     We don't try to defeat those; they just won't load. Primary
//     use case is the user's own dev server (no busting), so it's a
//     rare hit.
//
// Why this lives in its own file: the Phase 2 webview.ts was 700+ lines
// and is going away in the migration cleanup. Putting the iframe
// support in a separate file makes the intent obvious and keeps the
// delete trivial.

import { type Session } from "electron";

/** Strip iframe-blocking headers from this session's http(s)
 *  responses. Idempotent — calling twice replaces the listener.
 *  Pass `win.webContents.session` from createMainWindow(). */
export function installIframeHeaderStripping(session: Session): void {
  session.webRequest.onHeadersReceived(
    // Filter: only http(s) — file:// renderer assets pass through.
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      // M2: only strip framing protections for SUBFRAME documents (the
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

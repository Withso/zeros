// ──────────────────────────────────────────────────────────
// resolve-tokens — read CSS variables as concrete RGB strings
// ──────────────────────────────────────────────────────────
//
// Some embedded views (xterm.js terminals, sandboxed <iframe>
// previews, Canvas) need actual RGB color strings — they can't read
// the document's CSS variables directly. This helper resolves a CSS
// variable to its computed value via getComputedStyle, which collapses
// the entire `var()` chain (and any oklch() / color-mix() expressions
// in modern browsers) to a concrete `rgb(...)` string consumers can
// paste into their config.
//
// Use sparingly — every such read pulls a value out of the live token
// system, so it has to be re-read whenever the theme changes (the
// caller subscribes to the appearance store and re-applies). For
// regular DOM elements the standard `var(--bg1)` reference is
// always preferred — it auto-updates.
// ──────────────────────────────────────────────────────────

/** Read a CSS custom property (e.g. "--background") from <html>
 *  and return the computed value. Returns null only if the variable
 *  is unset; otherwise returns whatever the browser computed (an
 *  rgb(…), oklch(…), hex, or rgba(…) string).
 *
 *  Modern Safari/Chromium resolve oklch() to rgb() in
 *  getComputedStyle output, so callers that need hex/rgb (xterm.js,
 *  iframe HTML, canvas fillStyle) can pass the result through. */
export function resolveTokenValue(varName: string): string | null {
  if (typeof document === "undefined") return null;
  const cs = getComputedStyle(document.documentElement);
  const v = cs.getPropertyValue(varName).trim();
  return v.length > 0 ? v : null;
}

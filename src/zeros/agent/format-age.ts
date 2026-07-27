// ──────────────────────────────────────────────────────────
// formatCompactAge — ultra-short "time since" label
// ──────────────────────────────────────────────────────────
//
// Renders a timestamp as a single-unit compact age for the
// user-message hover actions row: "now", "6s", "6m", "6h",
// "6d", "6y". Deliberately terser than column2's
// `formatRelativeTime` ("6m ago") — the chat bubble row wants a
// glanceable badge, not a sentence.
//
// Computed at render time (hover-only surface), so no live tick.
// The full timestamp is exposed separately via a title tooltip.
// ──────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

/**
 * Compact single-unit age for a millisecond epoch timestamp.
 *   <1s   → "now"
 *   <1m   → "Ns"
 *   <1h   → "Nm"
 *   <1d   → "Nh"
 *   <1y   → "Nd"
 *   else  → "Ny"
 * Future timestamps (clock skew) clamp to "now".
 */
export function formatCompactAge(ts: number, now = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const delta = Math.max(0, now - ts);
  if (delta < SEC) return "now";
  if (delta < MIN) return `${Math.floor(delta / SEC)}s`;
  if (delta < HOUR) return `${Math.floor(delta / MIN)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < YEAR) return `${Math.floor(delta / DAY)}d`;
  return `${Math.floor(delta / YEAR)}y`;
}

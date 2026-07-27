// ──────────────────────────────────────────────────────────
// Analytics consent (opt-out model)
// ──────────────────────────────────────────────────────────
//
// Zeros uses an OPT-OUT model for anonymous usage analytics: data
// is collected by default, the user is told on first run, and they
// can turn it off in Settings → Privacy at any time. Everything we
// send is anonymous metadata — never code, prompts, paths, or keys
// (see docs/posthog-analytics-integration.md).
//
// These flags live in localStorage via the native settings shim so
// they're readable synchronously at boot (before the engine is up)
// and survive across the dev/prod isolation boundary unchanged.
// ──────────────────────────────────────────────────────────

import { getSetting, setSetting } from "../../native/settings";

const OPT_OUT_KEY = "analytics:opt-out";
const NOTICE_SEEN_KEY = "analytics:notice-seen";

/** True when the user has explicitly turned analytics OFF. Defaults
 *  to false (opted-in) — this is an opt-out model. */
export function isAnalyticsOptedOut(): boolean {
  return getSetting<boolean>(OPT_OUT_KEY, false);
}

export function setAnalyticsOptedOut(optedOut: boolean): void {
  setSetting(OPT_OUT_KEY, optedOut);
}

/** True once the first-run privacy notice has been shown. */
export function analyticsNoticeSeen(): boolean {
  return getSetting<boolean>(NOTICE_SEEN_KEY, false);
}

export function markAnalyticsNoticeSeen(): void {
  setSetting(NOTICE_SEEN_KEY, true);
}

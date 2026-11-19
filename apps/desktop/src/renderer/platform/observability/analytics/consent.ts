
import { getSetting, setSetting } from "../../settings";

const OPT_OUT_KEY = "analytics:opt-out";
const NOTICE_SEEN_KEY = "analytics:notice-seen";

/** Read the persisted opt-out synchronously before the engine is available. */
export function isAnalyticsOptedOut(): boolean {
  return getSetting<boolean>(OPT_OUT_KEY, false);
}

export function setAnalyticsOptedOut(optedOut: boolean): void {
  setSetting(OPT_OUT_KEY, optedOut);
}

export function analyticsNoticeSeen(): boolean {
  return getSetting<boolean>(NOTICE_SEEN_KEY, false);
}

export function markAnalyticsNoticeSeen(): void {
  setSetting(NOTICE_SEEN_KEY, true);
}

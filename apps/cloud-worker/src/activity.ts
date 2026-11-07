/** How long a terminal byte, save or Git mutation keeps reporting the
 * workspace busy. A minute spans one report heartbeat, so the control plane's
 * 20-minute idle stop runs from the last real activity. */
export const RECENT_ACTIVITY_MS = 60_000;

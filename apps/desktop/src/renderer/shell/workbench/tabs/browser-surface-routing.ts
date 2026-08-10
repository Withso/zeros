import { isLoopbackUrl, normalizeBrowserUrl } from "./localhost-url";

export interface BrowserSurfaceRoute {
  id: string;
  url?: string;
  browserSessionId?: string;
}

const USER_BROWSER_PREFIX = "user-browser:";

/** Public sites run in Electron's native WebContentsView. The iframe remains
 * only for blank and loopback design/canvas tabs, where DOM overlays and CSS
 * transforms are product features. */
export function shouldUseNativeBrowserSurface(
  tab: BrowserSurfaceRoute,
): boolean {
  if (tab.browserSessionId) return true;
  const url = normalizeBrowserUrl(tab.url ?? "");
  return Boolean(url && !isLoopbackUrl(url));
}

/** A workbench tab id is durable, so deriving the user-owned native session
 * from it lets main recreate the same browser surface after an app restart. */
export function browserNativeSessionId(tab: BrowserSurfaceRoute): string {
  if (tab.browserSessionId) return tab.browserSessionId;
  const safeId = tab.id.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 180);
  return `${USER_BROWSER_PREFIX}${safeId || "tab"}`;
}

export function userBrowserTabId(taskId: string): string | null {
  return taskId.startsWith(USER_BROWSER_PREFIX)
    ? taskId.slice(USER_BROWSER_PREFIX.length)
    : null;
}

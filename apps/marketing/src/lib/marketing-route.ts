export type MarketingRoute =
  | "home"
  | "changelog"
  | "privacy"
  | "terms"
  | "not-found";

/** Match the static marketing routes with the same case-insensitive,
 * trailing-slash-tolerant behavior used by the previous browser router. */
export function resolveMarketingPath(pathname: string): MarketingRoute {
  const normalized =
    pathname.length > 1 ? pathname.replace(/\/+$/, "").toLowerCase() : pathname;

  switch (normalized) {
    case "/":
      return "home";
    case "/changelog":
      return "changelog";
    case "/privacy":
      return "privacy";
    case "/terms":
      return "terms";
    default:
      return "not-found";
  }
}

/** Subscribe the router to browser history changes. */
export function subscribeToMarketingHistory(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

type NavigationClick = Pick<
  MouseEvent,
  "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/** True only for an unmodified primary-button click that should stay in-app. */
export function shouldHandleMarketingNavigation(
  event: NavigationClick,
): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** Publish an in-app route change and notify the router's history subscriber. */
export function navigateMarketingPath(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

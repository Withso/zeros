import { useSyncExternalStore } from "react";
import { HomePage } from "./pages/HomePage";
import { ChangelogPage } from "./pages/ChangelogPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { TermsPage } from "./pages/TermsPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import {
  resolveMarketingPath,
  subscribeToMarketingHistory,
} from "./lib/marketing-route";

// KEEP IN SYNC: every non-"/" route added here must also be listed as an SPA
// fallback in public/_redirects AND in MARKETING_SPA_PATHS in
// apps/web/functions/_middleware.ts (and its SPA_REDIRECTS twin in
// apps/web/scripts/assemble-marketing.mjs) — otherwise deep links to it
// 404 on zeros.build.
const readPathname = () => window.location.pathname;

export function MarketingRouter() {
  const pathname = useSyncExternalStore(
    subscribeToMarketingHistory,
    readPathname,
    () => "/",
  );

  switch (resolveMarketingPath(pathname)) {
    case "home":
      return <HomePage />;
    case "changelog":
      return <ChangelogPage />;
    case "privacy":
      return <PrivacyPage />;
    case "terms":
      return <TermsPage />;
    default:
      return <NotFoundPage />;
  }
}

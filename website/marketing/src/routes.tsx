import { createBrowserRouter } from "react-router-dom";
import { HomePage } from "./pages/HomePage";
import { ChangelogPage } from "./pages/ChangelogPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { TermsPage } from "./pages/TermsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

// KEEP IN SYNC: every non-"/" route added here must also be listed as an SPA
// fallback in public/_redirects AND in MARKETING_SPA_PATHS in
// website/web-app/functions/_middleware.ts (and its SPA_REDIRECTS twin in
// website/web-app/scripts/assemble-marketing.mjs) — otherwise deep links to it
// 404 on zeros.build.
export const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/changelog", element: <ChangelogPage /> },
  { path: "/privacy", element: <PrivacyPage /> },
  { path: "/terms", element: <TermsPage /> },
  { path: "*", element: <NotFoundPage /> },
]);

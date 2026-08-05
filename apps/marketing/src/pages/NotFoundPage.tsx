import type { MouseEvent } from "react";
import { Nav } from "../components/Nav";
import { Footer } from "../components/Footer";
import {
  navigateMarketingPath,
  shouldHandleMarketingNavigation,
} from "../lib/marketing-route";

/** Client-side 404 (catch-all route). Server-side unknown paths are answered
 *  by the static 404.html in apps/web/public — this page only shows for
 *  in-app navigations or SPA-fallback paths that have no matching route. */
export function NotFoundPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <Nav />

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col items-center justify-center px-5 py-24 text-center sm:px-8">
        <p className="text-fg3 text-[13px] tracking-[0.08em]">404</p>
        <h1 className="text-fg1 mt-2 text-[28px] font-medium tracking-[-0.02em] sm:text-[34px]">
          Page not found
        </h1>
        <p className="text-fg3 mt-3 text-[14px]">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <a
          href="/"
          onClick={(event: MouseEvent<HTMLAnchorElement>) => {
            if (!shouldHandleMarketingNavigation(event.nativeEvent)) {
              return;
            }
            event.preventDefault();
            navigateMarketingPath("/");
          }}
          className="bg-primary-button-bg text-primary-button-fg hover:bg-primary-button-hover mt-8 inline-flex items-center justify-center rounded-full px-5 py-2.5 text-[14px] font-medium transition-colors"
        >
          Go home
        </a>
      </main>

      <Footer />
    </div>
  );
}

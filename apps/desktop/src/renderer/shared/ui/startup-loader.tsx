import { useEffect, useLayoutEffect } from "react";

export const STARTUP_LOADER_ID = "zeros-boot";

/** The Island Z's four rows as mask cells, each repeating every four cells so
 * the Weave's first and last frames are the resting Z. index.html carries the
 * same rows (a test keeps them equal) and the critical styles. */
export const STARTUP_LOGO_WEAVE_ROWS = [
  { className: "zeros-boot-row-r", d: "M-4 0h1v1h-1ZM-2 0h3v1h-3ZM2 0h2v1h-2Z" },
  { className: "zeros-boot-row-l zeros-boot-beat-1", d: "M2 1h1v1h-1ZM6 1h1v1h-1Z" },
  { className: "zeros-boot-row-r zeros-boot-beat-2", d: "M-3 2h1v1h-1ZM1 2h1v1h-1Z" },
  { className: "zeros-boot-row-l zeros-boot-beat-3", d: "M0 3h2v1h-2ZM3 3h3v1h-3ZM7 3h1v1h-1Z" },
] as const;

const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

type LoaderDocument = Pick<Document, "getElementById">;

function currentDocument(): LoaderDocument | undefined {
  return typeof document === "undefined" ? undefined : document;
}

/** True while either the HTML-owned startup loader or its React fallback exists. */
export function isStartupLoaderMounted(
  loaderDocument: LoaderDocument | undefined = currentDocument(),
): boolean {
  return loaderDocument?.getElementById(STARTUP_LOADER_ID) != null;
}

/** Remove the HTML-owned loader after a replacement surface has committed. */
export function dismissStartupLoader(
  loaderDocument: LoaderDocument | undefined = currentDocument(),
): void {
  loaderDocument?.getElementById(STARTUP_LOADER_ID)?.remove();
}

/**
 * Dismiss in the layout phase so Chromium cannot paint a blank frame between
 * the startup logo and the login/app/error surface that replaces it.
 */
export function useDismissStartupLoader(ready: boolean): void {
  useClientLayoutEffect(() => {
    if (ready) dismissStartupLoader();
  }, [ready]);
}

/**
 * Used only if React enters its loading state without the HTML loader (for
 * example after an error-boundary retry or a state-resetting Fast Refresh).
 * The critical styling stays in index.html, so this is visually identical.
 */
export function StartupLogoLoader() {
  return (
    <div
      id={STARTUP_LOADER_ID}
      role="status"
      aria-live="polite"
      aria-label="Loading Zeros"
    >
      <svg className="zeros-boot-mark" viewBox="0 0 4 4" aria-hidden="true">
        <defs>
          <linearGradient id="zeros-boot-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--zeros-boot-top)" }} />
            <stop offset="1" style={{ stopColor: "var(--zeros-boot-bottom)" }} />
          </linearGradient>
          <mask id="zeros-boot-weave" maskUnits="userSpaceOnUse" x="0" y="0" width="4" height="4">
            {STARTUP_LOGO_WEAVE_ROWS.map((row) => (
              <path key={row.d} fill="white" className={row.className} d={row.d} />
            ))}
          </mask>
        </defs>
        <rect width="4" height="4" mask="url(#zeros-boot-weave)" fill="url(#zeros-boot-fade)" />
      </svg>
    </div>
  );
}

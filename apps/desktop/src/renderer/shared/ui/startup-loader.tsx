import { useEffect, useLayoutEffect } from "react";

export const STARTUP_LOADER_ID = "zeros-boot";

const STARTUP_LOGO_HALFTONE_LAYERS = [
  "base",
  "dots",
  "checks",
  "hatch",
  "blocks",
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
      <span className="zeros-boot-logo" aria-hidden="true">
        <span className="zeros-boot-halftone">
          {STARTUP_LOGO_HALFTONE_LAYERS.map((layer) => (
            <span
              className={`zeros-boot-halftone-layer zeros-boot-halftone--${layer}`}
              key={layer}
            />
          ))}
        </span>
      </span>
    </div>
  );
}

import { nativeImage, type Session } from "electron";

import {
  fetchBrowserFaviconDataUrl,
  orderedBrowserFaviconCandidates,
} from "./browser/surface";

const MAX_IFRAME_FAVICON_BYTES = 192 * 1024;
const MAX_ADVERTISED_IFRAME_FAVICONS = 4;

function safeWebOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Resolve page-declared artwork against the committed page URL, then include
 * conventional origin paths. Non-web/data candidates never cross the fetch
 * boundary, and a page cannot create an unbounded request list. */
export function resolveIframeFaviconCandidates(
  pageUrl: string,
  advertised: readonly string[] = [],
): string[] {
  const safeAdvertised: string[] = [];
  if (!safeWebOrigin(pageUrl)) return [];
  for (const candidate of advertised) {
    if (safeAdvertised.length >= MAX_ADVERTISED_IFRAME_FAVICONS) break;
    try {
      const url = new URL(candidate, pageUrl);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username &&
        !url.password &&
        url.href.length <= 8_192
      ) {
        safeAdvertised.push(url.href);
      }
    } catch {
      // One malformed page declaration must not suppress conventional paths.
    }
  }
  return orderedBrowserFaviconCandidates(pageUrl, safeAdvertised);
}

export function iframeFaviconNavigationDisposition(
  currentUrl: string,
  targetUrl: string,
): "retain" | "reset" {
  const currentOrigin = safeWebOrigin(currentUrl);
  const targetOrigin = safeWebOrigin(targetUrl);
  return currentOrigin && currentOrigin === targetOrigin ? "retain" : "reset";
}

export async function resolveIframeFaviconDataUrl(input: {
  browserSession: Session;
  pageUrl: string;
  advertised?: readonly string[];
}): Promise<string | null> {
  const candidates = resolveIframeFaviconCandidates(
    input.pageUrl,
    input.advertised,
  );
  for (const candidate of candidates) {
    const resolved = await fetchBrowserFaviconDataUrl({
      url: candidate,
      pageUrl: input.pageUrl,
      fetch: (requestUrl, init) =>
        input.browserSession.fetch(requestUrl, init),
      maximumBytes: MAX_IFRAME_FAVICON_BYTES,
      normalizeRaster: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) return null;
        const size = image.getSize();
        const normalized =
          size.width > 64 || size.height > 64
            ? image.resize({ width: 32, height: 32, quality: "best" })
            : image;
        return normalized.toPNG();
      },
    });
    if (resolved) return resolved;
  }
  return null;
}

/** Read only passive favicon declarations from the child page. This script
 * performs no mutation and returns bounded strings; main still validates every
 * candidate URL and fetch response before publishing renderer artwork. */
export async function declaredIframeFaviconUrls(
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>,
): Promise<string[]> {
  try {
    const value = await executeJavaScript(
      `Array.from(document.querySelectorAll('link[rel~="icon"]')).map((link) => link.href).filter((href) => typeof href === "string").slice(0, 4)`,
      false,
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(0, 4)
      : [];
  } catch {
    return [];
  }
}

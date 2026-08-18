import { useCallback, useSyncExternalStore } from "react";

const MAX_BROWSER_TAB_FAVICONS = 256;
const MAX_FAVICON_DATA_URL_LENGTH = Math.ceil((192 * 1024 * 4) / 3) + 100;
const SAFE_FAVICON_DATA_URL =
  /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/i;

interface BrowserTabFaviconEntry {
  origin: string;
  dataUrl: string | null;
}

const faviconByFrameName = new Map<string, BrowserTabFaviconEntry>();
const faviconByOrigin = new Map<string, string>();
const listenersByFrameName = new Map<string, Set<() => void>>();

function browserTabOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function validFaviconDataUrl(value: string): boolean {
  return (
    value.length <= MAX_FAVICON_DATA_URL_LENGTH &&
    SAFE_FAVICON_DATA_URL.test(value)
  );
}

function setBounded<K, V>(target: Map<K, V>, key: K, value: V): void {
  target.delete(key);
  target.set(key, value);
  while (target.size > MAX_BROWSER_TAB_FAVICONS) {
    const oldest = target.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    target.delete(oldest);
  }
}

function notifyBrowserTabFavicon(frameName: string): void {
  for (const listener of listenersByFrameName.get(frameName) ?? []) listener();
}

/** Begin an exact-tab navigation synchronously. Same-origin routes retain the
 * confirmed icon; a cross-origin target clears it before the destination can
 * paint so artwork never leaks between sites. */
export function beginBrowserTabFaviconNavigation(
  frameName: string,
  url: string,
): string | null {
  const origin = browserTabOrigin(url);
  if (!frameName || !origin) return null;
  const previous = faviconByFrameName.get(frameName);
  const dataUrl =
    previous?.origin === origin
      ? previous.dataUrl
      : (faviconByOrigin.get(origin) ?? null);
  if (previous?.origin === origin && previous.dataUrl === dataUrl) return dataUrl;
  setBounded(faviconByFrameName, frameName, { origin, dataUrl });
  notifyBrowserTabFavicon(frameName);
  return dataUrl;
}

/** Accept a trusted main-process favicon only while this frame still points at
 * the exact origin that requested it. This rejects late fetch completion after
 * rapid A → B navigation. */
export function publishBrowserTabFavicon(
  frameName: string,
  pageUrl: string,
  dataUrl: string,
): boolean {
  const origin = browserTabOrigin(pageUrl);
  const current = faviconByFrameName.get(frameName);
  if (!origin || current?.origin !== origin || !validFaviconDataUrl(dataUrl)) {
    return false;
  }
  setBounded(faviconByOrigin, origin, dataUrl);
  if (current.dataUrl === dataUrl) return true;
  setBounded(faviconByFrameName, frameName, { origin, dataUrl });
  notifyBrowserTabFavicon(frameName);
  return true;
}

export function currentBrowserTabFavicon(
  frameName: string | undefined,
): string | null {
  return frameName
    ? (faviconByFrameName.get(frameName)?.dataUrl ?? null)
    : null;
}

export function forgetBrowserTabFavicon(frameName: string): void {
  if (!faviconByFrameName.delete(frameName)) return;
  notifyBrowserTabFavicon(frameName);
}

export function useBrowserTabFavicon(
  frameName: string | undefined,
): string | null {
  const key = frameName ?? "";
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => undefined;
      let listeners = listenersByFrameName.get(key);
      if (!listeners) {
        listeners = new Set();
        listenersByFrameName.set(key, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners!.delete(listener);
        if (listeners!.size === 0) listenersByFrameName.delete(key);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(
    () => currentBrowserTabFavicon(key),
    [key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function browserTabFaviconStoreSizesForTests(): {
  frames: number;
  origins: number;
} {
  return {
    frames: faviconByFrameName.size,
    origins: faviconByOrigin.size,
  };
}

export function resetBrowserTabFaviconsForTests(): void {
  faviconByFrameName.clear();
  faviconByOrigin.clear();
}

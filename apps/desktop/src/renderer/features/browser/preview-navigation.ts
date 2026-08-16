const MAX_PENDING_PREVIEW_NAVIGATIONS = 32;
const PREVIEW_NAVIGATION_TTL_MS = 60_000;
const PREVIEW_RUNTIME_TTL_MS = 24 * 60 * 60_000;
const PREVIEW_EXPIRY_SKEW_MS = 60_000;
const PREVIEW_REDACTION_GRACE_MS = 60 * 60_000;

interface PendingPreviewNavigation {
  readonly url: string;
  readonly admissionUrl: string;
  readonly expiresAt: number;
}

export interface PreviewNavigationInput {
  readonly url: string;
  readonly admissionUrl: string;
  readonly expiresAt?: number;
}

interface NormalizedPreviewNavigation {
  readonly url: URL;
  readonly admission: URL;
  readonly runtime: URL;
  readonly expiresAt: number;
}

const pending = new Map<string, PendingPreviewNavigation>();
const runtimes = new Map<
  string,
  {
    readonly persistedUrl: string;
    readonly runtimeUrl: string;
    readonly runtimeOrigin: string;
    readonly volatileOrigin: boolean;
    readonly expiresAt: number;
  }
>();

function parsedHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`preview ${label} is invalid`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`preview ${label} must be an HTTP URL`);
  }
  return url;
}

function purgeExpired(now = Date.now()): void {
  for (const [tabId, value] of pending) {
    if (value.expiresAt > now) continue;
    pending.delete(tabId);
  }
  for (const [tabId, value] of runtimes) {
    // Keep only non-authority origin text briefly after authorization expiry so
    // a late Electron navigation/title event still cannot persist a signed
    // provider hostname while renewal retries.
    if (value.expiresAt + PREVIEW_REDACTION_GRACE_MS > now) continue;
    runtimes.delete(tabId);
  }
}

function isLoopbackLogicalUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function normalizedPreviewNavigation(
  input: PreviewNavigationInput,
  now: number,
): NormalizedPreviewNavigation {
  const url = parsedHttpUrl(input.url, "URL");
  const admission = parsedHttpUrl(input.admissionUrl, "admission URL");
  if (url.origin !== admission.origin && !isLoopbackLogicalUrl(url)) {
    throw new Error("preview logical URL must be localhost");
  }
  if (
    url.searchParams.has("__zsr_cap") ||
    !admission.searchParams.get("__zsr_cap")
  ) {
    throw new Error("preview admission capability is invalid");
  }
  if (
    input.expiresAt !== undefined &&
    (!Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= now ||
      input.expiresAt > now + PREVIEW_RUNTIME_TTL_MS + PREVIEW_EXPIRY_SKEW_MS)
  ) {
    throw new Error("preview authorization expiry is invalid");
  }
  const runtime = new URL(admission);
  runtime.searchParams.delete("__zsr_cap");
  return {
    url,
    admission,
    runtime,
    expiresAt: input.expiresAt ?? now + PREVIEW_RUNTIME_TTL_MS,
  };
}

/** Validate a navigation without retaining its bearer. Used to authorize a
 * replacement cloud origin in Electron before committing volatile state. */
export function previewNavigationDescriptor(
  input: PreviewNavigationInput,
): {
  runtimeOrigin: string;
  volatileOrigin: boolean;
  expiresAt: number;
} {
  const normalized = normalizedPreviewNavigation(input, Date.now());
  return {
    runtimeOrigin: normalized.runtime.origin,
    volatileOrigin: normalized.runtime.origin !== normalized.url.origin,
    expiresAt: normalized.expiresAt,
  };
}

/** Stage a one-use URL outside Zustand/persistence. The Browser tab retains
 * only `url`; its mount consumes `admissionUrl` synchronously for the initial
 * iframe navigation, after which the gateway redirects to the safe URL. */
export function stagePreviewNavigation(
  tabId: string,
  input: PreviewNavigationInput,
): {
  runtimeOrigin: string;
  volatileOrigin: boolean;
  expiresAt: number;
} {
  if (!tabId || tabId.length > 256) throw new Error("preview tab id is invalid");
  const now = Date.now();
  const normalized = normalizedPreviewNavigation(input, now);
  const { url, admission, runtime, expiresAt } = normalized;
  purgeExpired(now);
  pending.delete(tabId);
  pending.set(tabId, {
    url: url.toString(),
    admissionUrl: admission.toString(),
    expiresAt: now + PREVIEW_NAVIGATION_TTL_MS,
  });
  runtimes.set(tabId, {
    persistedUrl: url.toString(),
    runtimeUrl: runtime.toString(),
    runtimeOrigin: runtime.origin,
    volatileOrigin: runtime.origin !== url.origin,
    expiresAt,
  });
  while (pending.size > MAX_PENDING_PREVIEW_NAVIGATIONS) {
    const oldest = pending.keys().next().value as string | undefined;
    if (!oldest) break;
    pending.delete(oldest);
    runtimes.delete(oldest);
  }
  while (runtimes.size > MAX_PENDING_PREVIEW_NAVIGATIONS) {
    const oldest = runtimes.keys().next().value as string | undefined;
    if (!oldest) break;
    runtimes.delete(oldest);
    pending.delete(oldest);
  }
  return {
    runtimeOrigin: runtime.origin,
    volatileOrigin: runtime.origin !== url.origin,
    expiresAt,
  };
}

export function previewRuntimeStateForTab(
  tabId: string,
  persistedUrl: string,
): {
  origin: string;
  expiresAt: number;
  volatileOrigin: boolean;
} | null {
  purgeExpired();
  const runtime = runtimes.get(tabId);
  if (!runtime) return null;
  try {
    if (new URL(persistedUrl).toString() !== runtime.persistedUrl) return null;
    return {
      origin: runtime.runtimeOrigin,
      expiresAt: runtime.expiresAt,
      volatileOrigin: runtime.volatileOrigin,
    };
  } catch {
    return null;
  }
}

export function previewNavigationForTab(
  tabId: string,
  persistedUrl: string,
): string | null {
  purgeExpired();
  const value = pending.get(tabId);
  const runtime = runtimes.get(tabId);
  try {
    const normalized = new URL(persistedUrl).toString();
    if (value && normalized === value.url) return value.admissionUrl;
    if (
      runtime &&
      runtime.expiresAt > Date.now() &&
      normalized === runtime.persistedUrl
    ) {
      return runtime.runtimeUrl;
    }
  } catch {
    return null;
  }
  return null;
}

export function previewRuntimeOriginForTab(
  tabId: string,
  persistedUrl: string,
): string | null {
  return previewRuntimeStateForTab(tabId, persistedUrl)?.origin ?? null;
}

export function isPreviewRuntimeUrlForTab(
  tabId: string,
  persistedUrl: string,
  candidateUrl: string,
): boolean {
  purgeExpired();
  const runtime = runtimes.get(tabId);
  if (!runtime || !runtime.volatileOrigin) return false;
  try {
    return (
      new URL(persistedUrl).toString() === runtime.persistedUrl &&
      new URL(candidateUrl).origin === runtime.runtimeOrigin
    );
  } catch {
    return false;
  }
}

export function clearPreviewRuntimeForTab(tabId: string): void {
  pending.delete(tabId);
  runtimes.delete(tabId);
}

export function redactPreviewRuntimeTextForTab(
  tabId: string,
  persistedUrl: string,
  value: string,
): string {
  purgeExpired();
  const runtime = runtimes.get(tabId);
  if (!runtime?.volatileOrigin || !value) return value;
  try {
    const persisted = new URL(persistedUrl);
    if (persisted.toString() !== runtime.persistedUrl) return value;
    const runtimeUrl = new URL(runtime.runtimeUrl);
    return value
      .replaceAll(runtimeUrl.origin, persisted.origin)
      .replaceAll(runtimeUrl.host, persisted.host)
      .slice(0, 512);
  } catch {
    return value.slice(0, 512);
  }
}

export function consumePreviewNavigation(tabId: string): void {
  pending.delete(tabId);
}

export function takePreviewNavigation(
  tabId: string,
  persistedUrl: string,
): string | null {
  purgeExpired();
  const pendingValue = pending.get(tabId);
  let value: string | null = null;
  try {
    if (
      pendingValue &&
      new URL(persistedUrl).toString() === pendingValue.url
    ) {
      value = pendingValue.admissionUrl;
    }
  } catch {
    value = null;
  }
  consumePreviewNavigation(tabId);
  return value;
}

export function clearPreviewNavigationsForTest(): void {
  pending.clear();
  runtimes.clear();
}

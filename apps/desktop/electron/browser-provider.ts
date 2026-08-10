export type BrowserProviderConfiguration =
  | { provider: "isolated" }
  | { provider: "shared-chrome"; endpoint: string }
  | { provider: "managed-cloud"; endpoint: string; bearerToken?: string }
  | { provider: "system-computer-use" };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Shared Chrome carries the user's real signed-in browser state, so its
 * DevTools endpoint is intentionally local-only. Managed remote browsers use
 * a separate provider and credential boundary rather than weakening this one. */
export function normalizeSharedChromeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Shared Chrome requires a DevTools endpoint.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Shared Chrome endpoint must be a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "ws:") {
    throw new Error("Shared Chrome endpoint must use local HTTP or WebSocket.");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Shared Chrome endpoint must resolve to this Mac.");
  }
  if (url.username || url.password) {
    throw new Error("Shared Chrome endpoint must not contain credentials.");
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeManagedCloudEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Managed cloud browser requires a DevTools endpoint.");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Managed cloud browser endpoint must be a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new Error("Managed cloud browser endpoint must use HTTPS or WSS.");
  }
  if (url.username || url.password || url.search) {
    throw new Error(
      "Managed cloud credentials must use the encrypted token field, not the endpoint URL.",
    );
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeBrowserProviderConfiguration(
  value: unknown,
): BrowserProviderConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser provider configuration must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.provider === "isolated") return { provider: "isolated" };
  if (record.provider === "system-computer-use") {
    return { provider: "system-computer-use" };
  }
  if (record.provider === "shared-chrome") {
    return {
      provider: "shared-chrome",
      endpoint: normalizeSharedChromeEndpoint(record.endpoint),
    };
  }
  if (record.provider === "managed-cloud") {
    const bearerToken =
      typeof record.bearerToken === "string" && record.bearerToken.trim()
        ? record.bearerToken.trim()
        : undefined;
    return {
      provider: "managed-cloud",
      endpoint: normalizeManagedCloudEndpoint(record.endpoint),
      ...(bearerToken ? { bearerToken } : {}),
    };
  }
  throw new Error("Unsupported browser provider.");
}

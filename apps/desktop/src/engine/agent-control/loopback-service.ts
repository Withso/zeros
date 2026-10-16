/** A per-boot capability Electron main hands the engine: a loopback HTTP
 * origin and its bearer token. */
export interface LoopbackServiceConfig {
  readonly baseUrl: string;
  readonly token: string;
}

/** Accept only a credential-free `http://` loopback origin and a bounded
 * token, so a tampered environment cannot point the engine elsewhere. */
export function loopbackServiceConfig(
  rawUrl: string | undefined,
  rawToken: string | undefined,
): LoopbackServiceConfig | null {
  const value = rawUrl?.trim();
  const token = rawToken?.trim();
  if (!value || !token || token.length > 1_024) return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost";
    if (
      url.protocol !== "http:" ||
      !loopback ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      return null;
    }
    return { baseUrl: url.origin, token };
  } catch {
    return null;
  }
}

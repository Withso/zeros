// One environment-specific web origin for every Electron main-process auth
// handoff. The release workflow bakes this into main.cjs; explicit process env
// values remain useful for local testing and take precedence.

declare const __ZEROS_APP_BASE_URL_BAKED__: string | undefined;

const PRODUCTION_APP_ORIGIN = "https://app.zeros.build";

function normalizedAppOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    return null;
  }
  return url.origin;
}

/** Exported seam for exact precedence/validation tests. */
export function resolveAppBaseUrl(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const raw = candidate.trim();
    if (!raw) continue;
    const origin = normalizedAppOrigin(raw);
    if (origin) return origin;
  }
  const production = normalizedAppOrigin(PRODUCTION_APP_ORIGIN);
  if (!production) throw new Error("Invalid production Zeros web app URL");
  return production;
}

export function appBaseUrl(): string {
  const baked =
    typeof __ZEROS_APP_BASE_URL_BAKED__ === "string"
      ? __ZEROS_APP_BASE_URL_BAKED__
      : "";
  return resolveAppBaseUrl([
    process.env.ZEROS_APP_BASE_URL ?? "",
    process.env.VITE_APP_BASE_URL ?? "",
    baked,
  ]);
}

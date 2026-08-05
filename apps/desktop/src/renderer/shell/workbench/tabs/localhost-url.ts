// ──────────────────────────────────────────────────────────
// Browser URL helpers
// ──────────────────────────────────────────────────────────
//
// Browser tabs accept ordinary http(s) URLs. Loopback classification remains
// separate because Design and Canvas are deliberately local-development tools:
// external pages may render, but never receive picker injection or those modes.

const HTTP_SCHEME_RE = /^https?:\/\//i;
const ANY_SCHEME_RE = /^[a-z][a-z\d+.-]*:\/\//i;

/** True for loopback / local-dev hostnames: `localhost` (and
 *  `*.localhost` per RFC 6761), the IPv4 loopback block 127.0.0.0/8,
 *  IPv6 `::1`, and the unspecified `0.0.0.0` dev servers bind to.
 *  Private LAN ranges are not loopback. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1") return true;
  const match = h.match(/^127(?:\.(\d{1,3})){3}$/);
  if (!match) return false;
  return h.split(".").every((octet) => Number(octet) <= 255);
}

/** True when `url` is an http(s) URL whose host is loopback/local-dev. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLoopbackHost(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** Does a quick-open query look intentionally URL-like? Plain words stay file
 *  searches; hosts, IPs, localhost ports, and explicit schemes become URLs. */
export function looksLikeBrowserUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return false;
  if (
    !HTTP_SCHEME_RE.test(value) &&
    /\.(?:[cm]?[jt]sx?|json|mdx?|css|scss|sass|less|html?|vue|svelte|py|rb|go|rs|java|swift|kt|ya?ml|toml)(?:[?#]|$)/i.test(
      value,
    )
  )
    return false;
  return (
    HTTP_SCHEME_RE.test(value) ||
    /^(?:localhost|[\w-]+\.localhost)(?::\d+)?(?:[/?#]|$)/i.test(value) ||
    /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/.test(value) ||
    /^\[[0-9a-f:]+\](?::\d+)?(?:[/?#]|$)/i.test(value) ||
    /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value)
  );
}

/** Normalize address-bar input into a loadable http(s) URL.
 *
 *  - explicit http(s) URLs are preserved (and canonicalized by URL);
 *  - loopback-looking hosts default to http;
 *  - public hosts default to https;
 *  - non-web schemes, credentials, malformed ports, and empty input are
 *    rejected rather than handed to the iframe. */
export function normalizeBrowserUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (ANY_SCHEME_RE.test(value) && !HTTP_SCHEME_RE.test(value)) return null;

  const candidate = HTTP_SCHEME_RE.test(value)
    ? value
    : `${looksLikeLocalHostInput(value) ? "http" : "https"}://${value}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function looksLikeLocalHostInput(value: string): boolean {
  const host = value.split(/[/?#]/, 1)[0].replace(/:\d+$/, "");
  return isLoopbackHost(host);
}

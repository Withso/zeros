// ──────────────────────────────────────────────────────────
// MCP gateway — OAuth URL security primitives (SSRF guard + RFC 8707 resource)
// ──────────────────────────────────────────────────────────
//
// The gateway is a long-lived server-side process that, during MCP OAuth
// discovery, fetches URLs SUPPLIED BY A REMOTE MCP SERVER (the `resource_metadata`
// URL from a 401's WWW-Authenticate, the `authorization_servers` from the
// protected-resource metadata, the authorization/token endpoints from the AS
// metadata). A malicious server can point those at cloud metadata
// (169.254.169.254), localhost, or internal IPs — a classic SSRF. The MCP spec
// (2025-11-25 Security Best Practices) MANDATES that a server-side client guard
// against this. This module is that guard, plus the RFC 8707 canonical resource
// URI used to AUDIENCE-BIND tokens (the gateway's token vault is keyed by it, so
// a token issued for server A is never sent to server B).
//
// Pure + dependency-free + unit-tested — written first so the riskiest surface
// is locked down before any networking code exists. NOTE: this catches IP
// LITERALS (the WHATWG URL parser normalizes hex/octal/decimal IPv4 to dotted
// quad in `.hostname`, so encoding tricks are covered). It does NOT resolve DNS
// names — a hostname that resolves to a private IP (DNS-rebinding) must ALSO be
// defended at fetch time by resolving → checking → pinning the address. See the
// caller (Phase 2b networking).
// ──────────────────────────────────────────────────────────

/** Lowercase, fragment-free, default-port-free, trailing-slash-free form of a
 *  server URL — the RFC 8707 `resource` value and the token-vault key. Two URLs
 *  that identify the same MCP server canonicalize identically, so a token is
 *  never mis-keyed across equivalent URLs. Throws on an unparseable URL. */
export function canonicalResourceUri(raw: string): string {
  const u = new URL(raw); // throws TypeError on garbage
  u.hash = ""; // RFC 8707 §2: the resource URI MUST NOT include a fragment
  u.username = "";
  u.password = ""; // never key/audience-bind on userinfo
  // The WHATWG URL parser already lowercases scheme + host and drops the
  // default port (443/80). Strip a trailing slash (canonical convention).
  return u.toString().replace(/\/+$/, "");
}

/** Mix-up defense (RFC 8414 §3.3 / RFC 9728): the authorization-server metadata's
 *  `issuer` MUST identically match the AS URL the metadata was discovered from —
 *  otherwise a malicious resource server could point discovery at a different AS
 *  and have the gateway send a code/token to the wrong issuer. The SDK parses
 *  `issuer` but does NOT validate it, so the gateway does (in saveDiscoveryState).
 *  Returns a reason string if they differ (caller rejects), or null if they match.
 *  Comparison is on scheme+host+path (default ports + a trailing slash ignored). */
export function issuerMismatchReason(issuer: string, authorizationServerUrl: string): string | null {
  let a: URL;
  let b: URL;
  try {
    a = new URL(issuer);
    b = new URL(authorizationServerUrl);
  } catch {
    return "issuer or authorization-server URL is not a valid absolute URL";
  }
  const norm = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  if (norm(a) !== norm(b)) {
    return `discovered issuer "${issuer}" does not match the authorization server "${authorizationServerUrl}" (mix-up guard)`;
  }
  return null;
}

/** Extract the authorization `code` (+ optional `state`) from a value pasted in
 *  the headless sign-in flow — accepts the full redirect URL (?code=…&state=…), a
 *  bare query string, or a bare code (whatever the browser gave the user). Throws
 *  only when a URL was pasted but carries no code. */
export function parseAuthorizationCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const u = new URL(trimmed);
    const code = u.searchParams.get("code");
    if (!code) throw new Error("the pasted URL has no ?code= parameter");
    return { code, state: u.searchParams.get("state") ?? undefined };
  }
  if (trimmed.includes("code=")) {
    const sp = new URLSearchParams(trimmed.replace(/^\?/, ""));
    const code = sp.get("code");
    if (code) return { code, state: sp.get("state") ?? undefined };
  }
  return { code: trimmed };
}

export interface AuthUrlGuardOptions {
  /** Permit `http://` + loopback hosts (127.0.0.1 / ::1 / localhost). Off by
   *  default — production OAuth URLs are HTTPS. Turn on only for a local/dev
   *  backend or the gateway's own loopback callback. */
  allowLoopback?: boolean;
}

/** Reason a URL is UNSAFE to fetch during OAuth discovery, or null if it's
 *  allowed. Rejects: unparseable, non-HTTPS (unless loopback+allowed), and any
 *  host that is a private / loopback / link-local / reserved IP literal. */
export function unsafeAuthUrlReason(raw: string, opts: AuthUrlGuardOptions = {}): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "not a valid absolute URL";
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    return `disallowed scheme "${u.protocol}" (only https is allowed)`;
  }
  const host = u.hostname.toLowerCase();
  const loopback = isLoopbackHost(host);

  if (scheme === "http:" && !(loopback && opts.allowLoopback)) {
    return "http:// is not allowed (use https; http is permitted only for a loopback host in dev)";
  }
  // SSRF: block IP literals in private / reserved / loopback / link-local space.
  // A loopback literal is allowed ONLY when the caller opted in (the callback
  // server / a local backend); everything else internal is refused.
  if (isReservedIpLiteral(host)) {
    if (loopback && opts.allowLoopback) return null;
    return `host "${u.hostname}" is a private/reserved/loopback address (SSRF guard)`;
  }
  return null;
}

/** Throwing variant — returns the parsed URL when safe. */
export class UnsafeAuthUrlError extends Error {
  constructor(public readonly url: string, public readonly reason: string) {
    super(`unsafe OAuth URL ${url}: ${reason}`);
    this.name = "UnsafeAuthUrlError";
  }
}
export function assertSafeAuthUrl(raw: string, opts: AuthUrlGuardOptions = {}): URL {
  const reason = unsafeAuthUrlReason(raw, opts);
  if (reason) throw new UnsafeAuthUrlError(raw, reason);
  return new URL(raw);
}

// ── host classification ──────────────────────────────────

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "ip6-localhost") return true;
  if (h === "::1" || h === "[::1]") return true;
  if (isIPv4(h)) return ipv4Octets(h)![0] === 127; // 127.0.0.0/8
  return false;
}

/** True when the host is an IP LITERAL in a non-public range (loopback,
 *  private, link-local, CGNAT, unspecified, ULA, reserved). Hostnames return
 *  false here (DNS resolution is the caller's concern — see module header). */
export function isReservedIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase(); // strip IPv6 brackets if any
  if (isIPv4(h)) return ipv4Reserved(h);
  if (h.includes(":")) return ipv6Reserved(h);
  return false;
}

function isIPv4(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && ipv4Octets(host) !== null;
}

function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts as [number, number, number, number];
}

function ipv4Reserved(host: string): boolean {
  const o = ipv4Octets(host);
  if (!o) return false;
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this network" (and 0.0.0.0)
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0/24 IETF
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

function ipv6Reserved(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  // IPv4-mapped (::ffff:a.b.c.d). NOTE: the WHATWG URL parser serializes the
  // dotted form to hex (::ffff:127.0.0.1 → ::ffff:7f00:1), so decode both.
  if (h.startsWith("::ffff:")) {
    const v4 = ipv4FromMappedTail(h.slice("::ffff:".length));
    if (v4) return ipv4Reserved(v4);
  }
  const first = h.split(":")[0] ?? "";
  if (first.startsWith("fc") || first.startsWith("fd")) return true; // fc00::/7 unique-local
  if (first.startsWith("fe8") || first.startsWith("fe9") || first.startsWith("fea") || first.startsWith("feb"))
    return true; // fe80::/10 link-local
  return false;
}

/** Decode the 32-bit tail of an IPv4-mapped IPv6 address to dotted-quad,
 *  accepting both the dotted form (`127.0.0.1`) and the WHATWG-normalized hex
 *  form (`7f00:1`). */
function ipv4FromMappedTail(tail: string): string | null {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;
  const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1]!, 16);
  const lo = parseInt(m[2]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

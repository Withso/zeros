// ──────────────────────────────────────────────────────────
// MCP gateway — SSRF-safe fetch for OAuth discovery/token requests
// ──────────────────────────────────────────────────────────
//
// `oauth-url.ts` classifies a URL's host STATICALLY (IP literals only). That is
// not enough on the wire, because two things bypass a one-shot URL check:
//
//   1. HTTP REDIRECTS. A malicious backend whose discovery/token endpoint is a
//      public HTTPS host (passes the static guard) can answer `302 Location:
//      http://169.254.169.254/…` (cloud metadata) or any internal IP, and a
//      plain `fetch` follows it transparently — the static guard never re-runs
//      on the redirect target. (CRITICAL: ssrf-redirect-follow-bypass.)
//   2. DNS REBINDING. A hostname (not an IP literal) that RESOLVES to a private
//      address sails past the literal-only classifier — the module header of
//      oauth-url.ts flags this as "the caller's concern at fetch time." This is
//      that caller. (HIGH: ssrf-dns-rebinding.)
//
// So every fetch the SDK makes during a backend's OAuth flow goes through
// `safeAuthFetch`, which:
//   • re-validates EVERY hop's URL with `unsafeAuthUrlReason` (HTTPS-only +
//     reserved-IP-literal block),
//   • DNS-resolves each hop's host and rejects if ANY resolved address is a
//     private/reserved range (fail-closed on a resolution error),
//   • follows redirects MANUALLY (bounded), only for safe methods (GET/HEAD) —
//     a non-GET 3xx (an unusual token-endpoint redirect) is refused rather than
//     re-POSTing the code+PKCE verifier somewhere new,
//   • strips `Authorization` across redirect hops (discovery/PRM/AS metadata are
//     public; never hand a credential to a redirect target).
//
// Residual TOCTOU: we resolve→check→fetch by hostname, so a racing rebind
// between the lookup and the socket connect is still theoretically possible.
// Pinning the socket to the validated IP needs a custom dispatcher the bun
// runtime can't take; this closes the practical "host points at a static
// private IP" case and the redirect case, which are the real exploits.
// ──────────────────────────────────────────────────────────

import { lookup as dnsLookupCb } from "node:dns";
import { promisify } from "node:util";
import { isLoopbackHost, isReservedIpLiteral, unsafeAuthUrlReason } from "./oauth-url";

const dnsLookup = promisify(dnsLookupCb);

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;
/** Resolve a host to its A/AAAA addresses (injected in tests). */
export type LookupAllFn = (host: string) => Promise<string[]>;

export interface SafeFetchOptions {
  /** Permit `http://` + loopback hosts (local-dev backend / tests). */
  allowLoopback?: boolean;
  /** Max redirect hops before refusing (default 5). */
  maxRedirects?: number;
  /** Injectable fetch (default global fetch). */
  fetchImpl?: FetchFn;
  /** Injectable DNS resolver (default node:dns lookup, all addresses). */
  lookupImpl?: LookupAllFn;
}

async function defaultLookupAll(host: string): Promise<string[]> {
  const res = (await dnsLookup(host, { all: true })) as Array<{ address: string }>;
  return res.map((r) => r.address);
}

/** True when the host's DNS resolution lands on any private/reserved address.
 *  An IP-literal host is skipped here (the static guard already classified it).
 *  Fails CLOSED (treats as reserved) on a resolution error. */
async function dnsResolvesToReserved(
  host: string,
  lookupAll: LookupAllFn,
  allowLoopback: boolean,
): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  // An IP literal was already classified by unsafeAuthUrlReason — no DNS needed.
  if (isReservedIpLiteral(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false;
  let addrs: string[];
  try {
    addrs = await lookupAll(h);
  } catch {
    return true; // fail closed — a host we can't resolve is one we won't fetch
  }
  if (addrs.length === 0) return true;
  for (const address of addrs) {
    if (isReservedIpLiteral(address)) {
      if (allowLoopback && isLoopbackHost(address)) continue;
      return true;
    }
  }
  return false;
}

/** Strip an `Authorization` header from a HeadersInit (case-insensitive), so a
 *  credential is never replayed to a redirect target. */
function stripAuthorization(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers) return headers;
  const h = new Headers(headers);
  h.delete("authorization");
  return h;
}

/** Fetch with the SSRF guard applied at EVERY hop. Throws (rejects) on any
 *  unsafe URL, an unsafe DNS resolution, an over-long redirect chain, or a
 *  redirect of a non-safe method. */
export async function safeAuthFetch(
  input: string | URL,
  init: RequestInit | undefined,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchFn);
  const lookupAll = opts.lookupImpl ?? defaultLookupAll;
  const maxRedirects = opts.maxRedirects ?? 5;
  const allowLoopback = !!opts.allowLoopback;

  let url = typeof input === "string" ? input : input.toString();
  const method = (init?.method ?? "GET").toUpperCase();
  let headers = init?.headers;

  for (let hop = 0; ; hop++) {
    const reason = unsafeAuthUrlReason(url, { allowLoopback });
    if (reason) throw new Error(`MCP gateway blocked an unsafe URL (${reason}): ${url}`);
    const host = new URL(url).hostname;
    if (await dnsResolvesToReserved(host, lookupAll, allowLoopback)) {
      throw new Error(
        `MCP gateway blocked an unsafe URL (host "${host}" resolves to a private/reserved address — SSRF guard): ${url}`,
      );
    }
    const res = await fetchImpl(url, { ...init, headers, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    if (hop >= maxRedirects) {
      throw new Error(`MCP gateway blocked an OAuth request after ${maxRedirects} redirects: ${url}`);
    }
    // Only follow redirects for safe methods. A token POST that 3xx's would mean
    // re-sending the authorization code + PKCE verifier to a new host — refuse.
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`MCP gateway refused to follow a ${res.status} redirect on a ${method} OAuth request: ${url}`);
    }
    url = new URL(location, url).toString();
    headers = stripAuthorization(headers); // never replay a credential to a redirect target
  }
}

// ──────────────────────────────────────────────────────────
// verify-jwt — engine-side JWT verification (account-binding)
// ──────────────────────────────────────────────────────────
//
// Account-binding for remote clients: a cloud client may present an access
// token inside the CONNECTED handshake. The engine verifies it before allowing
// privileged messages. Qualified cloud workers make this asymmetric binding
// mandatory; non-qualified/local deployments may configure optional legacy
// behavior.
//
// PROVIDER-AGNOSTIC. This is a plain JWT verifier configured entirely from
// ZEROS_ACCOUNT_JWT_* env (see buildAccountAuthFromEnv) — it has no dependency
// on any particular identity provider. Do not introduce provider-specific
// names or URL shapes here.
//
// Verification uses node:crypto (engine is Node-only — this never runs in the
// browser/RN client), supporting:
//   • HS256 — a shared JWT secret (legacy / still supported)
//   • ES256 / RS256 — asymmetric, via a configured public key (PEM or JWK)
//
// Static PEM/JWK verification is offline. The production rotation path may
// resolve a public key by `kid` from an explicitly configured HTTPS JWKS URL;
// token verification itself remains in this module and is deterministic.
// ──────────────────────────────────────────────────────────

import {
  createHmac,
  createPublicKey,
  verify as nodeVerify,
  timingSafeEqual,
  type KeyObject,
  type JsonWebKey,
} from "node:crypto";

export interface VerifiedClaims {
  /** Subject (`sub`) — the IdP-issued user id. */
  sub: string;
  email?: string;
  role?: string;
  /** Expiry (unix SECONDS). */
  exp?: number;
  iat?: number;
  nbf?: number;
  aud?: string | string[];
  iss?: string;
  [k: string]: unknown;
}

export type JwtErrorCode =
  | "MALFORMED"
  | "UNSUPPORTED_ALG"
  | "NO_KEY"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "BAD_AUDIENCE"
  | "BAD_ISSUER"
  | "NO_SUBJECT"
  | "BAD_CLIENT"
  | "MISSING_CLAIM"
  | "CLAIM_REJECTED";

export class JwtError extends Error {
  readonly code: JwtErrorCode;
  constructor(code: JwtErrorCode, message: string) {
    super(message);
    this.name = "JwtError";
    this.code = code;
  }
}

export interface JwtVerifyConfig {
  /** HS256 shared secret. */
  hs256Secret?: string;
  /** Public key for ES256/RS256 — PEM (-----BEGIN PUBLIC KEY-----) or a JWK
   *  JSON string. When `jwksUrl` is set, the per-`kid` key resolved from the
   *  JWKS is used instead (this stays as a fallback / test override). */
  publicKey?: string;
  /** JWKS endpoint for asymmetric keys (e.g.
   *  "https://<issuer>/.well-known/jwks.json"). When set, the
   *  signing key is resolved by the token's `kid` header and cached — this is
   *  the production path (handles IdP key rotation; public keys only, so
   *  no secret is shipped in the desktop binary). */
  jwksUrl?: string;
  /** Required audience. Empty disables the check — see buildAccountAuthFromEnv. */
  audience?: string;
  /** Required issuer(s) — a single value, or a comma-separated list for an IdP
   *  that may emit its canonical hostname even behind a custom domain.
   *  Optional. */
  issuer?: string;
  /** Optional exact signing algorithm. The Zeros access-token contract always
   *  pins RS256; legacy provider-neutral configurations may leave this unset. */
  algorithm?: "HS256" | "ES256" | "RS256";
  /** Optional application-token profile layered on the registered JWT checks. */
  contract?: "zeros-access-v1";
  /** Exact application client id required by the selected contract. */
  clientId?: string;
  /** Allowed clock skew in seconds (default 30). */
  clockSkewSec?: number;
}

const DEFAULT_CLOCK_SKEW_SEC = 30;
const MAX_CLOCK_SKEW_SEC = 300;

function checkedClockSkewSec(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CLOCK_SKEW_SEC;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 0 ||
    resolved > MAX_CLOCK_SKEW_SEC
  ) {
    throw new JwtError(
      "MALFORMED",
      `clock skew must be an integer from 0 through ${MAX_CLOCK_SKEW_SEC} seconds`,
    );
  }
  return resolved;
}

function b64urlToBuf(s: string): Buffer {
  // Node's "base64url" is lenient about padding; normalize defensively anyway.
  return Buffer.from(s, "base64url");
}

function decodeSegment(seg: string): Record<string, unknown> {
  const json = b64urlToBuf(seg).toString("utf-8");
  return JSON.parse(json) as Record<string, unknown>;
}

let cachedKey: { src: string; key: KeyObject } | null = null;
function loadPublicKey(src: string): KeyObject {
  if (cachedKey && cachedKey.src === src) return cachedKey.key;
  const trimmed = src.trim();
  const key = trimmed.startsWith("{")
    ? createPublicKey({ key: JSON.parse(trimmed) as JsonWebKey, format: "jwk" })
    : createPublicKey(trimmed); // PEM
  cachedKey = { src, key };
  return key;
}

/** Verify an access token. Returns its claims on success; throws JwtError
 *  otherwise. `nowMs` is injectable for deterministic tests. */
export function verifyAccountJwt(
  token: string,
  config: JwtVerifyConfig,
  nowMs: number = Date.now(),
): VerifiedClaims {
  if (typeof token !== "string" || !token) {
    throw new JwtError("MALFORMED", "token must be a non-empty string");
  }
  const clockSkewSec = checkedClockSkewSec(config.clockSkewSec);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new JwtError(
      "MALFORMED",
      "a JWS compact token must have 3 dot-separated parts",
    );
  }
  const [h, p, sig] = parts;
  let header: Record<string, unknown>;
  let claims: VerifiedClaims;
  try {
    header = decodeSegment(h);
    claims = decodeSegment(p) as VerifiedClaims;
  } catch {
    throw new JwtError(
      "MALFORMED",
      "header/payload is not valid base64url JSON",
    );
  }

  const alg = String(header.alg ?? "");
  const expectedAlgorithm =
    config.contract === "zeros-access-v1" ? "RS256" : config.algorithm;
  if (expectedAlgorithm && alg !== expectedAlgorithm) {
    throw new JwtError(
      "UNSUPPORTED_ALG",
      `JWT alg must be ${expectedAlgorithm}`,
    );
  }
  const signingInput = Buffer.from(`${h}.${p}`, "utf-8");
  const sigBuf = b64urlToBuf(sig);

  // ── 1. Signature ──────────────────────────────────────────
  if (alg === "HS256") {
    if (!config.hs256Secret) {
      throw new JwtError(
        "NO_KEY",
        "HS256 token but no shared secret is configured",
      );
    }
    const expected = createHmac("sha256", config.hs256Secret)
      .update(signingInput)
      .digest();
    if (
      expected.length !== sigBuf.length ||
      !timingSafeEqual(expected, sigBuf)
    ) {
      throw new JwtError("BAD_SIGNATURE", "HMAC signature mismatch");
    }
  } else if (alg === "ES256" || alg === "RS256") {
    if (!config.publicKey) {
      throw new JwtError(
        "NO_KEY",
        `${alg} token but no public key is configured`,
      );
    }
    let ok: boolean;
    try {
      const key = loadPublicKey(config.publicKey);
      // ES256 carries a raw r||s (IEEE-P1363) signature, not DER.
      const keyArg =
        alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" as const } : key;
      ok = nodeVerify("sha256", signingInput, keyArg, sigBuf);
    } catch (err) {
      throw new JwtError(
        "BAD_SIGNATURE",
        `signature verification error: ${(err as Error).message}`,
      );
    }
    if (!ok) throw new JwtError("BAD_SIGNATURE", `${alg} signature is invalid`);
  } else {
    throw new JwtError(
      "UNSUPPORTED_ALG",
      `unsupported JWT alg: ${alg || "(none)"}`,
    );
  }

  // ── 2. Claims ─────────────────────────────────────────────
  const skewMs = clockSkewSec * 1000;
  // An access token must carry an expiry; a validly signed token without
  // `exp` would otherwise be accepted forever (fail-open for a security
  // boundary). A conformant IdP always sets `exp`, so this rejects only malformed tokens.
  if (typeof claims.exp !== "number") {
    throw new JwtError("EXPIRED", "token has no expiry (exp) claim");
  }
  if (nowMs > claims.exp * 1000 + skewMs) {
    throw new JwtError("EXPIRED", "token has expired");
  }
  if (typeof claims.nbf === "number" && nowMs < claims.nbf * 1000 - skewMs) {
    throw new JwtError("NOT_YET_VALID", "token is not yet valid (nbf)");
  }
  if (config.audience) {
    const aud = claims.aud;
    const ok = Array.isArray(aud)
      ? aud.includes(config.audience)
      : aud === config.audience;
    if (!ok)
      throw new JwtError(
        "BAD_AUDIENCE",
        `audience mismatch (expected "${config.audience}")`,
      );
  }
  if (config.issuer) {
    const allowed = config.issuer
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      allowed.length > 0 &&
      (typeof claims.iss !== "string" || !allowed.includes(claims.iss))
    ) {
      throw new JwtError(
        "BAD_ISSUER",
        `issuer mismatch (expected one of "${allowed.join(", ")}")`,
      );
    }
  }
  if (!claims.sub || typeof claims.sub !== "string") {
    throw new JwtError("NO_SUBJECT", "token has no subject (sub) claim");
  }
  if (config.contract === "zeros-access-v1") {
    const exactIssuer = config.issuer?.trim();
    const exactAudience = config.audience?.trim();
    const exactClientId = config.clientId?.trim();
    if (
      !exactIssuer ||
      exactIssuer.includes(",") ||
      !exactAudience ||
      !exactClientId
    ) {
      throw new JwtError(
        "MALFORMED",
        "Zeros access-token verifier configuration is incomplete",
      );
    }
    for (const key of [
      "sub",
      "sid",
      "jti",
      "client_id",
      "https://zeros.build/email",
    ]) {
      const value = claims[key];
      if (typeof value !== "string" || !value.trim()) {
        throw new JwtError(
          "MISSING_CLAIM",
          `token is missing required string claim ${key}`,
        );
      }
    }
    if (claims.client_id !== exactClientId) {
      throw new JwtError("BAD_CLIENT", "token client id is not allowed");
    }
    if (claims["https://zeros.build/email_verified"] !== true) {
      throw new JwtError(
        "CLAIM_REJECTED",
        "token does not assert a verified email",
      );
    }
    if (
      typeof claims.iat !== "number" ||
      !Number.isFinite(claims.iat) ||
      claims.iat <= 0 ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= claims.iat
    ) {
      throw new JwtError(
        "CLAIM_REJECTED",
        "token issue and expiry timestamps are invalid",
      );
    }
  }
  return claims;
}

// ── JWKS-by-kid resolution (production asymmetric path) ─────────────────────
//
// IdPs sign access tokens with rotating ES256 keys exposed at the tenant's
// JWKS endpoint. We resolve the signing key by the token's `kid` header and feed
// it to verifyAccountJwt (reusing the proven node:crypto verification core — no
// extra dependency). The JWKS is cached in-process and only re-fetched when a
// token presents an unknown `kid` (rotation) or the cache is stale, with a short
// cooldown so a bad/forged kid can't trigger a fetch storm.

interface JwkLike {
  kid?: string;
  [k: string]: unknown;
}
let jwksCache: {
  url: string;
  keys: Map<string, JwkLike>;
  fetchedAt: number;
} | null = null;
let jwksLastFetchAttempt: { url: string; at: number } | null = null;
const jwksFetchFlights = new Map<string, Promise<Map<string, JwkLike>>>();
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const MAX_JWKS_BODY_BYTES = 1024 * 1024;
const MAX_JWKS_KEYS = 128;
const MAX_JWKS_KID_CODE_UNITS = 256;

async function readBoundedJwksJson(
  response: Response,
  signal: AbortSignal,
): Promise<{ keys?: JwkLike[] }> {
  if (!response.body) {
    throw new JwtError("NO_KEY", "JWKS response has no body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new JwtError("NO_KEY", "JWKS response body is invalid");
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JWKS_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The byte limit is already decisive; cancellation is best-effort.
        }
        throw new JwtError("NO_KEY", "JWKS response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof JwtError) throw error;
    throw new JwtError(
      "NO_KEY",
      signal.aborted
        ? "JWKS response timed out"
        : "JWKS response body could not be read",
    );
  }

  const encoded = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    return JSON.parse(text) as { keys?: JwkLike[] };
  } catch {
    throw new JwtError("NO_KEY", "JWKS response is not valid JSON");
  }
}

function decodeHeader(token: string): { alg?: string; kid?: string } {
  const parts = token.split(".");
  if (parts.length !== 3)
    throw new JwtError(
      "MALFORMED",
      "a JWS compact token must have 3 dot-separated parts",
    );
  let header: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]);
  } catch {
    throw new JwtError("MALFORMED", "header is not valid base64url JSON");
  }
  return {
    alg: typeof header.alg === "string" ? header.alg : undefined,
    kid:
      typeof header.kid === "string" &&
      header.kid.length <= MAX_JWKS_KID_CODE_UNITS &&
      !/[\0\r\n]/.test(header.kid)
        ? header.kid
        : undefined,
  };
}

function fetchJwks(url: string, nowMs: number): Promise<Map<string, JwkLike>> {
  const existingFlight = jwksFetchFlights.get(url);
  if (existingFlight) return existingFlight;
  // Cooldown: don't hammer the endpoint when a forged/unknown kid keeps missing.
  if (
    jwksLastFetchAttempt?.url === url &&
    nowMs - jwksLastFetchAttempt.at < JWKS_COOLDOWN_MS
  ) {
    if (jwksCache?.url === url) return Promise.resolve(jwksCache.keys);
    return Promise.reject(
      new JwtError("NO_KEY", "JWKS endpoint is cooling down after a failure"),
    );
  }
  jwksLastFetchAttempt = { url, at: nowMs };
  const flight = (async (): Promise<Map<string, JwkLike>> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    timeout.unref?.();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = controller.signal.aborted;
      throw new JwtError(
        "NO_KEY",
        timedOut
          ? "JWKS fetch timed out"
          : `JWKS fetch failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      throw new JwtError("NO_KEY", `JWKS fetch failed (${res.status})`);
    }
    const contentLength = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_JWKS_BODY_BYTES) {
      throw new JwtError("NO_KEY", "JWKS response is too large");
    }
    let body: { keys?: JwkLike[] };
    const bodyTimeout = setTimeout(
      () => controller.abort(),
      JWKS_FETCH_TIMEOUT_MS,
    );
    bodyTimeout.unref?.();
    try {
      body = await readBoundedJwksJson(res, controller.signal);
    } finally {
      clearTimeout(bodyTimeout);
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(body);
    } catch {
      throw new JwtError("NO_KEY", "JWKS response is not serializable");
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Buffer.byteLength(encoded, "utf8") > MAX_JWKS_BODY_BYTES ||
      !Array.isArray(body.keys) ||
      body.keys.length > MAX_JWKS_KEYS
    ) {
      throw new JwtError("NO_KEY", "JWKS response is invalid or too large");
    }
    const keys = new Map<string, JwkLike>();
    for (const key of body.keys) {
      if (
        !key ||
        typeof key !== "object" ||
        typeof key.kid !== "string" ||
        key.kid.length < 1 ||
        key.kid.length > MAX_JWKS_KID_CODE_UNITS ||
        /[\0\r\n]/.test(key.kid) ||
        keys.has(key.kid)
      ) {
        throw new JwtError("NO_KEY", "JWKS response contains an invalid key");
      }
      keys.set(key.kid, key);
    }
    jwksCache = { url, keys, fetchedAt: nowMs };
    return keys;
  })();
  const tracked = flight.finally(() => {
    if (jwksFetchFlights.get(url) === tracked) jwksFetchFlights.delete(url);
  });
  jwksFetchFlights.set(url, tracked);
  return tracked;
}

/** Resolve the JWK for `kid` from `url`, fetching/refreshing as needed. */
async function resolveJwk(
  url: string,
  kid: string,
  nowMs: number,
): Promise<JwkLike> {
  const fresh =
    jwksCache &&
    jwksCache.url === url &&
    nowMs - jwksCache.fetchedAt < JWKS_TTL_MS;
  let keys = fresh ? jwksCache!.keys : await fetchJwks(url, nowMs);
  if (!keys.has(kid)) {
    // Unknown kid on a fresh cache → likely a rotation; force one refresh.
    keys = await fetchJwks(url, nowMs);
  }
  const jwk = keys.get(kid);
  if (!jwk) throw new JwtError("NO_KEY", `no JWKS key for kid "${kid}"`);
  return jwk;
}

/** Async sibling of verifyAccountJwt that resolves the signing key from a JWKS
 *  endpoint by the token's `kid`. Requires config.jwksUrl. Verification itself
 *  reuses verifyAccountJwt with the resolved public JWK. */
export async function verifyAccountJwtViaJwks(
  token: string,
  config: JwtVerifyConfig,
  nowMs: number = Date.now(),
): Promise<VerifiedClaims> {
  if (!config.jwksUrl)
    throw new JwtError(
      "NO_KEY",
      "verifyAccountJwtViaJwks called without jwksUrl",
    );
  if (typeof token !== "string" || !token)
    throw new JwtError("MALFORMED", "token must be a non-empty string");
  const { alg, kid } = decodeHeader(token);
  if (alg !== "ES256" && alg !== "RS256") {
    throw new JwtError(
      "UNSUPPORTED_ALG",
      `JWKS verification requires ES256 or RS256 (got ${alg ?? "none"})`,
    );
  }
  if (!kid)
    throw new JwtError(
      "NO_KEY",
      "token header has no kid (cannot resolve a JWKS key)",
    );
  const jwk = await resolveJwk(config.jwksUrl, kid, nowMs);
  const keyOps = jwk.key_ops;
  const metadataMatches =
    (jwk.alg === undefined || jwk.alg === alg) &&
    (jwk.use === undefined || jwk.use === "sig") &&
    (keyOps === undefined ||
      (Array.isArray(keyOps) && keyOps.includes("verify"))) &&
    (alg === "ES256"
      ? jwk.kty === "EC" && jwk.crv === "P-256"
      : jwk.kty === "RSA");
  if (!metadataMatches) {
    throw new JwtError(
      "NO_KEY",
      `JWKS key metadata is incompatible with ${alg}`,
    );
  }
  // Hand the resolved JWK to the proven sync verifier as the public key.
  return verifyAccountJwt(
    token,
    { ...config, publicKey: JSON.stringify(jwk), jwksUrl: undefined },
    nowMs,
  );
}

/** Test/reset hook — drop the in-process JWKS cache. */
export function resetJwksCache(): void {
  jwksCache = null;
  jwksLastFetchAttempt = null;
  jwksFetchFlights.clear();
}

export interface AccountAuth {
  config: JwtVerifyConfig;
  /** When true, a remote client MUST present a valid token (else rejected). */
  required: boolean;
}

/** A privileged cloud worker gives its remote owner the same authority as the
 * local desktop, so bearer-only or symmetric account admission is never a
 * qualified deployment. Keep this assertion in the engine as well as the
 * operator harness: a custom launcher must not be able to omit the second,
 * owner-bound asymmetric gate. */
export function assertQualifiedCloudAccountBinding(
  accountAuth: AccountAuth | null,
): AccountAuth {
  const config = accountAuth?.config;
  let secureJwks = false;
  let secureStaticKey = false;
  if (config?.jwksUrl) {
    try {
      const url = new URL(config.jwksUrl);
      secureJwks =
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash;
    } catch {
      secureJwks = false;
    }
  }
  if (config?.publicKey?.trim()) {
    try {
      loadPublicKey(config.publicKey);
      secureStaticKey = true;
    } catch {
      secureStaticKey = false;
    }
  }
  if (
    !accountAuth?.required ||
    !config ||
    Boolean(config.hs256Secret) ||
    (!secureJwks && !secureStaticKey) ||
    !config.audience?.trim()
  ) {
    throw new Error(
      "qualified cloud worker requires mandatory asymmetric account binding",
    );
  }
  return accountAuth;
}

/** Whether a remote client's message must be DROPPED because account-binding is
 *  REQUIRED but the client hasn't completed it yet. This is the enforcement
 *  gate: without it, "just never send CONNECTED" would bypass `required` (the
 *  per-message handlers don't consult the bound identity). CONNECTED (which
 *  carries the token + triggers verification) and HEARTBEAT are allowed
 *  pre-auth; every other message fails CLOSED until the client is verified.
 *  Local (trusted desktop) clients are never gated. */
export function remoteMustBindFirst(opts: {
  clientKind: "local" | "cloud";
  required: boolean;
  verified: boolean;
  msgType: string;
}): boolean {
  if (opts.clientKind === "local" || !opts.required || opts.verified)
    return false;
  return opts.msgType !== "CONNECTED" && opts.msgType !== "HEARTBEAT";
}

export type RemoteAccountVerdict =
  | "allow"
  | "reject-owner-unknown"
  | "reject-wrong-account";

/** Decide whether a remote client's VERIFIED account may bind, given the engine's
 *  owner account. Pure + unit-testable; the I/O (verify / send / close) stays in
 *  the engine. The owner is the account signed into the DESKTOP — a remote
 *  device must be that same account ("my account, my machine").
 *
 *  • optional mode (required=false) → any valid account binds (pairing-only era).
 *  • required + no owner yet (desktop not signed in / renderer hasn't seeded it)
 *    → reject as RETRYABLE (fail closed; the desktop seeds the owner at startup).
 *  • required + owner set → bind ONLY when the client's account matches.
 *
 *  FUTURE (collaboration): this is the single choke point that will widen from
 *  "is the owner" to "is the owner OR an invited collaborator" (with the
 *  collaborator getting a separate, capability-restricted session). Keep that
 *  extension here — do not scatter account checks elsewhere. */
export function remoteAccountVerdict(opts: {
  required: boolean;
  ownerSub: string | null;
  clientSub: string;
}): RemoteAccountVerdict {
  if (!opts.required) return "allow";
  if (!opts.ownerSub) return "reject-owner-unknown";
  return opts.clientSub === opts.ownerSub ? "allow" : "reject-wrong-account";
}

/** A change to the engine's owner-account state. The owner is the account
 *  signed into the DESKTOP — established from the local renderer's verified
 *  CONNECTED token and consulted by remoteAccountVerdict for every remote device. */
export type OwnerAccountEvent =
  /** The local desktop renderer (re)announced CONNECTED. `sub` is its verified
   *  account, or null when the token was missing / expired / unverifiable. */
  | { kind: "local-connected"; sub: string | null }
  /** The desktop owner explicitly signed out (OWNER_SIGNED_OUT). */
  | { kind: "signed-out" };

/** Pure transition for the engine's `ownerAccountSub`. Centralises the
 *  "my account, my machine" owner lifecycle in one tested place rather than
 *  inline in the connection handler:
 *
 *   • signed-out             → null. Forget the owner so remote clients fail
 *     closed until a new owner is seeded — this is the sign-out hardening that
 *     stops a still-valid remote token for the old account from keeping access.
 *   • local-connected w/ sub → sub. (Re)seed the owner from the verified local
 *     token (including an owner *change* when a different account signs in).
 *   • local-connected, no sub → unchanged. A transient empty / expired LOCAL
 *     token (startup race, refresh blip, renderer reload) must NEVER wipe the
 *     owner and lock out remote devices — ONLY an explicit sign-out clears it. */
export function nextOwnerAccount(
  current: string | null,
  event: OwnerAccountEvent,
): string | null {
  if (event.kind === "signed-out") return null;
  return event.sub ?? current;
}

/** Immutable account owner provisioned alongside a qualified cloud worker.
 * A cloud coordinator has no trusted local renderer from which to learn the
 * desktop owner, so required account binding must start with an orchestrator-
 * supplied subject instead of becoming permanently `desktop-unbound`. */
export function cloudOwnerSubjectFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.ZEROS_CLOUD_OWNER_SUB;
  if (raw === undefined) return null;
  const subject = raw.trim();
  if (subject.length < 1 || subject.length > 512 || /[\0\r\n]/.test(subject)) {
    throw new Error("provisioned cloud owner subject is invalid");
  }
  return subject;
}

/** Build account-binding config from the environment, or null when not
 *  configured (no secret and no public key → account-binding is off and the
 *  engine stays pairing-only). */
export function buildAccountAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AccountAuth | null {
  const hs256Secret = env.ZEROS_ACCOUNT_JWT_SECRET || undefined;
  const publicKey = env.ZEROS_ACCOUNT_JWT_PUBLIC_KEY || undefined;
  // Production path: a JWKS endpoint (asymmetric, rotation-safe, public-only).
  // Either give the full URL in ZEROS_ACCOUNT_JWT_JWKS_URL, or give just the
  // issuer origin in ZEROS_ACCOUNT_JWT_ISSUER and let it resolve to the
  // standard OIDC discovery path. Any one of {jwksUrl, publicKey, hs256Secret}
  // enables account-binding.
  //
  // Issuer-only configuration resolves the standard discovery-adjacent JWKS
  // path. The explicit URL remains available for providers with another layout.
  const jwksUrl =
    env.ZEROS_ACCOUNT_JWT_JWKS_URL?.trim() ||
    (env.ZEROS_ACCOUNT_JWT_ISSUER
      ? `${env.ZEROS_ACCOUNT_JWT_ISSUER.replace(/\/+$/, "")}/.well-known/jwks.json`
      : undefined);
  if (!hs256Secret && !publicKey && !jwksUrl) return null;
  const contractValue = env.ZEROS_ACCOUNT_JWT_CONTRACT?.trim();
  if (contractValue && contractValue !== "zeros-access-v1") {
    throw new Error("account JWT contract is not supported");
  }
  const contract: JwtVerifyConfig["contract"] =
    contractValue === "zeros-access-v1" ? contractValue : undefined;
  const clientId = env.ZEROS_ACCOUNT_JWT_CLIENT_ID?.trim() || undefined;
  if (contract === "zeros-access-v1") {
    if (!clientId) throw new Error("account JWT client id must be configured");
    if (!env.ZEROS_ACCOUNT_JWT_ISS?.trim()) {
      throw new Error("account JWT exact issuer must be configured");
    }
    if (!env.ZEROS_ACCOUNT_JWT_AUD?.trim()) {
      throw new Error("account JWT audience must be configured");
    }
  }
  const skewSource = env.ZEROS_ACCOUNT_JWT_SKEW?.trim();
  let clockSkewSec: number | undefined;
  if (skewSource) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(skewSource)) {
      throw new Error(
        `account JWT clock skew must be an integer from 0 through ${MAX_CLOCK_SKEW_SEC} seconds`,
      );
    }
    clockSkewSec = Number(skewSource);
    if (clockSkewSec > MAX_CLOCK_SKEW_SEC) {
      throw new Error(
        `account JWT clock skew must be an integer from 0 through ${MAX_CLOCK_SKEW_SEC} seconds`,
      );
    }
  }
  return {
    config: {
      hs256Secret,
      publicKey,
      jwksUrl,
      // NOT dropped despite "authenticated" being a GoTrue-ism: the verifier
      // skips the aud check entirely when this is empty (`if (config.audience)`),
      // so a non-empty fallback is what stops a deployment that forgets to set
      // ZEROS_ACCOUNT_JWT_AUD from silently validating tokens for ANY audience.
      // It fails closed — an Auth0 token is rejected — which is the safe
      // direction. Replace the sentinel only together with making aud required.
      audience: env.ZEROS_ACCOUNT_JWT_AUD || "authenticated",
      issuer: env.ZEROS_ACCOUNT_JWT_ISS || undefined,
      algorithm: contract === "zeros-access-v1" ? "RS256" : undefined,
      contract,
      clientId,
      clockSkewSec,
    },
    required:
      env.ZEROS_REQUIRE_ACCOUNT === "1" || env.ZEROS_REQUIRE_ACCOUNT === "true",
  };
}

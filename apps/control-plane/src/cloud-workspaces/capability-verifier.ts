import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { compactVerify } from "jose";

import {
  CAPABILITY_CONTRACT_VERSION,
  CAPABILITY_KEY_ID_PATTERN,
  CAPABILITY_NBF_LEEWAY_SECONDS,
  CAPABILITY_POP_DOMAIN,
  CAPABILITY_POP_REPLAY_WINDOW_MS,
  CAPABILITY_POP_TIMESTAMP_LEEWAY_MS,
  CAPABILITY_TOKEN_LIFETIME_SECONDS,
  CAPABILITY_TOKEN_PARSE_MAX_BYTES,
  CapabilityClaimsSchema,
  CapabilityHeaderSchema,
  capabilityGrantsScope,
  capabilityRequiredEpochs,
  type CapabilityAudience,
  type CapabilityClaims,
  type CapabilityErrorCode,
  type CapabilityHeader,
  type CapabilityKind,
} from "./capability-contract.js";

/**
 * The shared S1 capability verifier (contracts/s1-capabilities.md,
 * "Verification" steps 1-13, "Proof of possession", "Outage rule").
 *
 * This one source file is used by every verifier: `api` and `realtime`
 * import it inside the control plane, and the cloud engine imports this same
 * file (bundled at build time) from its cloud-only adapter
 * `apps/desktop/src/engine/cloud-capability-verifier.ts`. It lives in the
 * control plane because the control plane deploys from its own directory and
 * cannot reach a workspace package at runtime, while the engine bundles
 * relative sources; Local Personal and organization-local engines never
 * construct a verifier. Dependencies are `jose`, `node:crypto` and the
 * mirrored S1 contract only.
 *
 * Nothing here logs. A token never appears in a result, error or callback;
 * only claims do.
 */

export type CapabilityPin = Readonly<{ aud: CapabilityAudience; knd: CapabilityKind }>;
export type CapabilityRoute = "direct" | "relay";

/** The PoP fields a client sends beside its token. The verifier rebuilds the
 * signed message from its own audience, workspace and route. */
export type CapabilityProof = Readonly<{ timestampMs: number; nonce: string; signature: string }>;

export type CapabilityVerifyContext = Readonly<{
  /** The verifier's workspace (engine) or the requested one (realtime, api). */
  workspaceId: string;
  organizationId: string;
  /** The current generation; realtime and api take it from the authority
   * cache, never from the request. */
  generation: number;
  /** The verifier's own engine instance (engine) or the current one for the
   * workspace and generation (api, realtime). `null` when none exists. */
  engineInstanceId: string | null;
  /** Client tokens only: the route this connection arrived on. */
  route?: CapabilityRoute;
  proof?: CapabilityProof;
  /** Step 13: the operation's required scope, when one applies. */
  scope?: string;
}>;

export type CapabilityVerifyFailure = Readonly<{ ok: false; code: CapabilityErrorCode; step: number }>;
export type CapabilityVerifySuccess = Readonly<{ ok: true; header: CapabilityHeader; claims: CapabilityClaims }>;
export type CapabilityVerifyResult = CapabilityVerifySuccess | CapabilityVerifyFailure;

export type CapabilityPublicJwk = Readonly<{
  kty: "OKP"; crv: "Ed25519"; x: string; kid: string; use?: "sig"; alg?: "EdDSA";
  zeros_state?: "next" | "current" | "retiring";
}>;

/** S1 "Keys and rotation": the published set holds next, current and
 * retiring keys only. */
export const CAPABILITY_MAX_KEYS = 3;
/** Step 3: one refresh on an unknown kid, at most once a minute. */
export const CAPABILITY_KEY_REFRESH_INTERVAL_MS = 60_000;
/** S1 "Epoch snapshot": max token lifetime + outage grace + skew. */
export const CAPABILITY_REVOCATION_RETENTION_MS = 36 * 60_000;
/** S1 "Outage rule". */
export const CAPABILITY_OUTAGE_DETECT_MS = 30_000;
export const CAPABILITY_OUTAGE_GRACE_MS = 30 * 60_000;
export const CAPABILITY_RECOVERY_RENEWAL_MS = 60_000;

export class CapabilityKeySetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityKeySetError";
  }
}

/** Known-epoch subjects (S1 "Known-epoch state at a verifier"): `wa` and
 * `wr` per workspace, `me` per (org, user), `ac` per user, `dk` per device. */
export function capabilityEpochSubject(key: string, claims: Pick<CapabilityClaims, "wsp" | "org" | "sub" | "did">): string | null {
  const user = claims.sub.startsWith("user:") ? claims.sub.slice(5) : null;
  switch (key) {
    case "wa": return `wa:${claims.wsp}`;
    case "wr": return `wr:${claims.wsp}`;
    case "me": return user ? `me:${claims.org}:${user}` : null;
    case "ac": return user ? `ac:${user}` : null;
    case "dk": return claims.did ? `dk:${claims.did}` : null;
    default: return null;
  }
}

export type CapabilityEpochSubjects = Readonly<{
  wa?: number; wr?: number;
  members?: Readonly<Record<string, number>>;
  accounts?: Readonly<Record<string, number>>;
  devices?: Readonly<Record<string, number>>;
}>;

/** Converts an S2 `auth.sync`/`auth.epochs` epoch set for one workspace into
 * known-epoch subjects. */
export function capabilityEpochEntries(scope: Readonly<{ workspaceId: string; organizationId: string }>,
  epochs: CapabilityEpochSubjects): Array<readonly [string, number]> {
  const entries: Array<readonly [string, number]> = [];
  if (epochs.wa !== undefined) entries.push([`wa:${scope.workspaceId}`, epochs.wa]);
  if (epochs.wr !== undefined) entries.push([`wr:${scope.workspaceId}`, epochs.wr]);
  for (const [user, epoch] of Object.entries(epochs.members ?? {})) entries.push([`me:${scope.organizationId}:${user}`, epoch]);
  for (const [user, epoch] of Object.entries(epochs.accounts ?? {})) entries.push([`ac:${user}`, epoch]);
  for (const [device, epoch] of Object.entries(epochs.devices ?? {})) entries.push([`dk:${device}`, epoch]);
  return entries;
}

/** The exact S1 PoP message bytes. */
export function capabilityProofMessage(fields: Readonly<{
  aud: string; wsp: string; jti: string; timestampMs: number; nonce: string; route: CapabilityRoute;
}>): Buffer {
  return Buffer.from([CAPABILITY_POP_DOMAIN, fields.aud, fields.wsp, fields.jti, String(fields.timestampMs),
    fields.nonce, fields.route].join("\n"), "utf8");
}

/**
 * Outage state machine (S1 "Outage rule"). A full CP outage starts once the
 * uplink has been down for 30 s and the JWKS probe has failed for 30 s;
 * `outageStartedAt` is the instant both held. During it a session
 * authenticated before that instant stays open until
 * min(outageStartedAt + 30 min, exp + 30 min). Recovery (the caller applied a
 * fresh `auth.sync`, or the probe answers again) ends the outage; a session
 * that was past its `exp` at recovery must renew within 60 s.
 */
export class CapabilityOutageMonitor {
  private uplinkDownSince: number | null = null;
  private probeFailingSince: number | null = null;
  private startedAt: number | null = null;
  private last: { startedAt: number; recoveredAt: number } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  uplinkDown(at = this.now()): void { if (this.uplinkDownSince === null) this.uplinkDownSince = at; }
  /** The uplink is back and its `auth.sync` was applied. */
  uplinkRestored(at = this.now()): void { this.uplinkDownSince = null; this.recover(at); }
  probe(ok: boolean, at = this.now()): void {
    if (ok) { this.probeFailingSince = null; this.recover(at); return; }
    if (this.probeFailingSince === null) this.probeFailingSince = at;
  }

  /** The current outage start, evaluating the detection rule at `now`. */
  outageStartedAt(now = this.now()): number | null {
    if (this.startedAt === null && this.uplinkDownSince !== null && this.probeFailingSince !== null) {
      const at = Math.max(this.uplinkDownSince, this.probeFailingSince) + CAPABILITY_OUTAGE_DETECT_MS;
      if (now >= at) this.startedAt = at;
    }
    return this.startedAt;
  }

  /** The instant a session must be closed unless renewed. */
  sessionDeadline(session: Readonly<{ authenticatedAtMs: number; expMs: number }>, now = this.now()): number {
    const started = this.outageStartedAt(now);
    if (started !== null && session.authenticatedAtMs < started)
      return Math.max(session.expMs, Math.min(started + CAPABILITY_OUTAGE_GRACE_MS, session.expMs + CAPABILITY_OUTAGE_GRACE_MS));
    const last = this.last;
    if (last && session.authenticatedAtMs < last.startedAt && session.expMs <= last.recoveredAt) {
      const grace = Math.min(last.startedAt + CAPABILITY_OUTAGE_GRACE_MS, session.expMs + CAPABILITY_OUTAGE_GRACE_MS);
      return Math.min(grace, last.recoveredAt + CAPABILITY_RECOVERY_RENEWAL_MS);
    }
    return session.expMs;
  }

  private recover(at: number): void {
    const started = this.outageStartedAt(at);
    if (started !== null) this.last = { startedAt: started, recoveredAt: at };
    this.startedAt = null;
  }
}

type OpenSession = {
  claims: CapabilityClaims;
  context: CapabilityVerifyContext;
  authenticatedAtMs: number;
  kid: string;
};

export type CapabilitySessionClosure = Readonly<{ sessionId: string; code: CapabilityErrorCode }>;

export type CapabilityVerifierOptions = {
  issuer: string;
  now?: () => number;
  /** Step 3: refetches the published key set (S1 JWKS, `no-cache`). */
  fetchKeys?: () => Promise<readonly unknown[]>;
  outage?: CapabilityOutageMonitor;
  /** Sessions that a raised epoch, a revocation or a deadline closed. */
  onSessionsClosed?: (closures: readonly CapabilitySessionClosure[]) => void;
};

const COMPACT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const fail = (code: CapabilityErrorCode, step: number): CapabilityVerifyFailure => ({ ok: false, code, step });

export class CapabilityVerifier {
  private keys = new Map<string, KeyObject>();
  private lastRefreshAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<void> | null = null;
  private readonly known = new Map<string, number>();
  private readonly revoked = new Map<string, number>();
  private readonly proofsSeen = new Map<string, number>();
  private readonly sessions = new Map<string, OpenSession>();
  private readonly now: () => number;
  readonly outage: CapabilityOutageMonitor;

  constructor(private readonly options: CapabilityVerifierOptions) {
    this.now = options.now ?? Date.now;
    this.outage = options.outage ?? new CapabilityOutageMonitor(this.now);
  }

  /** A fetched or pushed set replaces the verifier's set (S1); sessions
   * admitted under a key that left the set close with
   * `capability_key_unknown`. An invalid set throws and leaves the current
   * set unchanged. */
  applyKeys(keys: readonly unknown[]): CapabilitySessionClosure[] {
    if (!Array.isArray(keys) || keys.length > CAPABILITY_MAX_KEYS)
      throw new CapabilityKeySetError(`a capability key set holds at most ${CAPABILITY_MAX_KEYS} keys`);
    const next = new Map<string, KeyObject>();
    for (const raw of keys) {
      const key = raw as Partial<CapabilityPublicJwk> | null;
      if (!key || typeof key !== "object" || key.kty !== "OKP" || key.crv !== "Ed25519" ||
          typeof key.x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key.x) ||
          typeof key.kid !== "string" || !CAPABILITY_KEY_ID_PATTERN.test(key.kid) ||
          (key.use !== undefined && key.use !== "sig") || (key.alg !== undefined && key.alg !== "EdDSA") || next.has(key.kid))
        throw new CapabilityKeySetError("invalid capability key");
      next.set(key.kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }));
    }
    this.keys = next;
    return this.recheck();
  }

  keyIds(): string[] { return [...this.keys.keys()]; }

  /** Maximum merge from any source; returns the sessions closed by the raise. */
  mergeKnown(entries: Iterable<readonly [string, number]>): CapabilitySessionClosure[] {
    let raised = false;
    for (const [subject, epoch] of entries) {
      if (!Number.isSafeInteger(epoch) || epoch < 0) continue;
      if (epoch > (this.known.get(subject) ?? 0)) { this.known.set(subject, epoch); raised = true; }
    }
    return raised ? this.recheck() : [];
  }

  knownEpoch(subject: string): number | undefined { return this.known.get(subject); }

  /** Known epochs and live revocations, for a verifier that persists them. */
  exportState(): { known: Array<[string, number]>; revoked: Array<["sid" | "did", string, number]> } {
    this.pruneRevocations();
    return {
      known: [...this.known],
      revoked: [...this.revoked].map(([key, until]) => [key.slice(0, 3) as "sid" | "did", key.slice(4), until]),
    };
  }

  /** Session (`sid`) and device (`did`) revocations: a union, each entry
   * kept until its own `until` (default: the retention window). */
  revoke(kind: "sid" | "did", id: string, untilMs = this.now() + CAPABILITY_REVOCATION_RETENTION_MS): CapabilitySessionClosure[] {
    const key = `${kind}:${id}`;
    this.revoked.set(key, Math.max(this.revoked.get(key) ?? 0, untilMs));
    return this.recheck();
  }

  isRevoked(kind: "sid" | "did", id: string): boolean {
    this.pruneRevocations();
    return this.revoked.has(`${kind}:${id}`);
  }

  /** Registers a session admitted with `claims` so later raises, revocations
   * and deadlines re-check it. */
  openSession(sessionId: string, verified: CapabilityVerifySuccess, context: CapabilityVerifyContext): void {
    this.sessions.set(sessionId, { claims: verified.claims, context, authenticatedAtMs: this.now(), kid: verified.header.kid });
  }

  /** In-band renewal swaps the session's token; the session keeps its
   * original authentication time. */
  renewSession(sessionId: string, verified: CapabilityVerifySuccess): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.claims.sub !== verified.claims.sub || session.claims.did !== verified.claims.did) return false;
    session.claims = verified.claims;
    session.kid = verified.header.kid;
    return true;
  }

  closeSession(sessionId: string): void { this.sessions.delete(sessionId); }
  openSessionIds(): string[] { return [...this.sessions.keys()]; }
  sessionClaims(sessionId: string): CapabilityClaims | undefined { return this.sessions.get(sessionId)?.claims; }

  /** Re-checks every open session against steps 8-11 (5-7 cannot change for
   * an admitted token) and the outage-aware deadline; closes and reports
   * the failures. */
  recheck(): CapabilitySessionClosure[] {
    this.pruneRevocations();
    const now = this.now();
    const closed: CapabilitySessionClosure[] = [];
    for (const [sessionId, session] of this.sessions) {
      const code = this.sessionFailure(session, now);
      if (code) { this.sessions.delete(sessionId); closed.push({ sessionId, code }); }
    }
    if (closed.length) this.options.onSessionsClosed?.(closed);
    return closed;
  }

  /** Step 13 for one message of an open session. */
  allows(sessionId: string, scope: string): boolean {
    const claims = this.sessions.get(sessionId)?.claims;
    return !!claims && capabilityGrantsScope(claims, scope);
  }

  async verify(token: unknown, pin: CapabilityPin, context: CapabilityVerifyContext): Promise<CapabilityVerifyResult> {
    // 1. Compact JWS within 4 KiB.
    if (typeof token !== "string" || Buffer.byteLength(token, "utf8") > CAPABILITY_TOKEN_PARSE_MAX_BYTES) return fail("capability_malformed", 1);
    const parts = COMPACT.exec(token);
    const rawHeader = parts ? decodeJson(parts[1]!) : null;
    const payload = parts ? decodeJson(parts[2]!) : null;
    if (!parts || !rawHeader || !payload) return fail("capability_malformed", 1);
    // 2. Exact header allow-list, string-only aud, checked before jose.
    const header = CapabilityHeaderSchema.safeParse(rawHeader);
    if (!header.success || typeof payload.aud !== "string") return fail("capability_malformed", 2);
    // 3. kid in the active set, after at most one rate-limited refresh.
    let key = this.keys.get(header.data.kid);
    if (!key) {
      await this.refreshKeys();
      key = this.keys.get(header.data.kid);
      if (!key) return fail("capability_key_unknown", 3);
    }
    // 4. Signature (jose, EdDSA only, over the exact bytes received).
    try {
      await compactVerify(token, key, { algorithms: ["EdDSA"] });
    } catch {
      return fail("capability_signature_invalid", 4);
    }
    // 5. Issuer, then contract major.
    if (payload.iss !== this.options.issuer) return fail("capability_issuer_mismatch", 5);
    if (payload.cv !== CAPABILITY_CONTRACT_VERSION)
      return fail(Number.isSafeInteger(payload.cv) ? "capability_contract_unsupported" : "capability_malformed", 5);
    // 6. The pinned audience and kind pair; checks never follow the token's knd.
    if (payload.aud !== pin.aud || payload.knd !== pin.knd) return fail("capability_audience_mismatch", 6);
    // 7. Claim shapes, including every epoch key the kind requires.
    const parsed = CapabilityClaimsSchema.safeParse(payload);
    if (!parsed.success) return fail("capability_malformed", 7);
    const claims = parsed.data;
    if (capabilityRequiredEpochs(pin.knd).some(epochKey => claims.ep[epochKey] === undefined) ||
        claims.exp - claims.iat > CAPABILITY_TOKEN_LIFETIME_SECONDS || claims.exp <= claims.iat) return fail("capability_malformed", 7);
    // 8. Workspace, generation and engine instance.
    const placement = this.placementFailure(claims, context);
    if (placement) return fail(placement, 8);
    // 9. nbf leeway only; none after exp.
    const now = this.now();
    if (now < (claims.nbf - CAPABILITY_NBF_LEEWAY_SECONDS) * 1000) return fail("capability_not_yet_valid", 9);
    if (now >= claims.exp * 1000) return fail("capability_expired", 9);
    // 10. Epochs at or above known; a higher epoch raises known.
    const raises: Array<readonly [string, number]> = [];
    for (const [epochKey, epoch] of Object.entries(claims.ep)) {
      const subject = capabilityEpochSubject(epochKey, claims);
      if (!subject || epoch === undefined) continue;
      const known = this.known.get(subject);
      if (known !== undefined && epoch < known) return fail("capability_revoked", 10);
      if (known === undefined || epoch > known) raises.push([subject, epoch]);
    }
    if (raises.length) this.mergeKnown(raises);
    // 11. Session and device revocations.
    if ((claims.sid && this.isRevoked("sid", claims.sid)) || (claims.did && this.isRevoked("did", claims.did)))
      return fail("capability_revoked", 11);
    // 12. Proof of possession for client tokens.
    if (pin.knd === "client" && !this.proofValid(claims, pin, context, now)) return fail("capability_proof_invalid", 12);
    // 13. The operation's scope, ignoring cross-kind scopes.
    if (context.scope !== undefined && !capabilityGrantsScope(claims, context.scope)) return fail("capability_scope_denied", 13);
    return { ok: true, header: header.data, claims };
  }

  private placementFailure(claims: CapabilityClaims, context: CapabilityVerifyContext): CapabilityErrorCode | null {
    if (claims.wsp !== context.workspaceId || claims.org !== context.organizationId) return "capability_workspace_mismatch";
    if (claims.gen !== context.generation) return "capability_generation_mismatch";
    // A replaced engine instance within one generation is a placement the
    // client must reconnect to through runtime/connect.
    if (claims.ein !== undefined && claims.ein !== context.engineInstanceId) return "capability_generation_mismatch";
    return null;
  }

  private sessionFailure(session: OpenSession, now: number): CapabilityErrorCode | null {
    if (!this.keys.has(session.kid)) return "capability_key_unknown";
    const { claims } = session;
    const placement = this.placementFailure(claims, session.context);
    if (placement) return placement;
    if (now >= this.outage.sessionDeadline({ authenticatedAtMs: session.authenticatedAtMs, expMs: claims.exp * 1000 }, now))
      return "capability_expired";
    for (const [epochKey, epoch] of Object.entries(claims.ep)) {
      const subject = capabilityEpochSubject(epochKey, claims);
      const known = subject ? this.known.get(subject) : undefined;
      if (known !== undefined && epoch !== undefined && epoch < known) return "capability_revoked";
    }
    if ((claims.sid && this.revoked.has(`sid:${claims.sid}`)) || (claims.did && this.revoked.has(`did:${claims.did}`)))
      return "capability_revoked";
    return null;
  }

  private proofValid(claims: CapabilityClaims, pin: CapabilityPin, context: CapabilityVerifyContext, now: number): boolean {
    const proof = context.proof;
    if (!proof || !context.route || !claims.cnf || !Number.isSafeInteger(proof.timestampMs) ||
        typeof proof.nonce !== "string" || !NONCE.test(proof.nonce) ||
        typeof proof.signature !== "string" || !SIGNATURE.test(proof.signature) ||
        Math.abs(now - proof.timestampMs) > CAPABILITY_POP_TIMESTAMP_LEEWAY_MS) return false;
    const replayKey = `${claims.jti}\n${proof.nonce}`;
    for (const [seen, until] of this.proofsSeen) if (until <= now) this.proofsSeen.delete(seen);
    if (this.proofsSeen.has(replayKey)) return false;
    const message = capabilityProofMessage({ aud: pin.aud, wsp: context.workspaceId, jti: claims.jti,
      timestampMs: proof.timestampMs, nonce: proof.nonce, route: context.route });
    let valid = false;
    try {
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: claims.cnf.jwk.x }, format: "jwk" });
      valid = verifySignature(null, message, publicKey, Buffer.from(proof.signature, "base64url"));
    } catch {
      valid = false;
    }
    if (valid) this.proofsSeen.set(replayKey, now + CAPABILITY_POP_REPLAY_WINDOW_MS);
    return valid;
  }

  private pruneRevocations(): void {
    const now = this.now();
    for (const [key, until] of this.revoked) if (until <= now) this.revoked.delete(key);
  }

  private async refreshKeys(): Promise<void> {
    const fetchKeys = this.options.fetchKeys;
    if (!fetchKeys) return;
    if (this.refreshing) return this.refreshing;
    if (this.now() - this.lastRefreshAt < CAPABILITY_KEY_REFRESH_INTERVAL_MS) return;
    this.lastRefreshAt = this.now();
    // A failed fetch or an invalid set keeps the current set; the token then
    // fails step 3 like any unknown kid.
    this.refreshing = fetchKeys().then(keys => { try { this.applyKeys(keys); } catch { /* keep the current set */ } }, () => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

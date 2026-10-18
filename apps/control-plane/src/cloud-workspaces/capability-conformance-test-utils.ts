import type { CapabilityErrorCode } from "./capability-contract.js";
import type { CapabilityPin, CapabilityRoute, CapabilityVerifier, CapabilityVerifyContext, CapabilityVerifyResult } from "./capability-verifier.js";
import {
  TEST_CAPABILITY_HEADER,
  TEST_CAPABILITY_IDS as ids,
  TEST_CAPABILITY_ISSUER,
  TEST_CAPABILITY_NOW_S,
  signTestCapability,
  signTestProof,
  testClientClaims,
  testEngineClaims,
  testSigningJwk,
} from "./capability-verifier-test-utils.js";

/**
 * S1 conformance vectors shared by every verifier (engine, realtime, api):
 * this one file defines a vector per verification step and error code, and
 * each verifier's test runs the identical list. Tokens and proofs are signed
 * when the list is built, with test keys derived from labels, so no token or
 * key material is stored in the repository; Ed25519 is deterministic, so
 * every build yields the same bytes.
 */

export type ConformanceVector = {
  name: string;
  pin: CapabilityPin;
  token: string;
  context: CapabilityVerifyContext;
  nowMs: number;
  known?: Array<[string, number]>;
  revoked?: Array<["sid" | "did", string]>;
  /** Verify twice; the expectation applies to the second result. */
  repeat?: true;
  expect: { ok: true } | { ok: false; code: CapabilityErrorCode; step: number };
};

export type ConformanceFixture = {
  contract: "zeros-cap";
  version: "1.0.1";
  issuer: string;
  keys: ReturnType<typeof testSigningJwk>[];
  vectors: ConformanceVector[];
};

const NOW_MS = TEST_CAPABILITY_NOW_S * 1000;
const JTI = "AAAAAAAAAAAAAAAAAAAAAA";
const header = TEST_CAPABILITY_HEADER;
const sign = (payload: unknown, h: Record<string, unknown> = header, label?: string) => signTestCapability(h, payload, label ?? String(h.kid));
const ok = { ok: true } as const;
const no = (code: CapabilityErrorCode, step: number) => ({ ok: false as const, code, step });

function placement(route?: CapabilityRoute): CapabilityVerifyContext {
  return { workspaceId: ids.workspace, organizationId: ids.org, generation: 7, engineInstanceId: ids.engine, ...(route ? { route } : {}) };
}

function proof(aud: string, route: CapabilityRoute, index: number, options: { signRoute?: CapabilityRoute; device?: string; tsMs?: number; jti?: string } = {}) {
  const nonce = `V${String(index).padStart(21, "0")}`;
  const timestampMs = options.tsMs ?? NOW_MS;
  return { timestampMs, nonce, signature: signTestProof(options.device ?? "device-a",
    { aud, wsp: ids.workspace, jti: options.jti ?? JTI, timestampMs, nonce, route: options.signRoute ?? route }) };
}

function clientVectors(aud: "zeros:engine" | "zeros:realtime", route: CapabilityRoute, start: number): ConformanceVector[] {
  const pin = { aud, knd: "client" } as const;
  let index = start;
  const vector = (name: string, payload: Record<string, unknown> | string, expectation: ConformanceVector["expect"],
    extra: Partial<ConformanceVector> & { proofOptions?: Parameters<typeof proof>[3]; noProof?: true; scope?: string } = {}): ConformanceVector => {
    const { proofOptions, noProof, scope, ...rest } = extra;
    const token = typeof payload === "string" ? payload : sign(payload);
    const context = { ...placement(route), ...(noProof ? {} : { proof: proof(aud, route, index++, proofOptions) }), ...(scope ? { scope } : {}) };
    return { name: `${aud} ${name}`, pin, token, context, nowMs: NOW_MS, expect: expectation, ...rest };
  };
  const claims = (overrides: Record<string, unknown> = {}) => testClientClaims({ aud, ...overrides });
  const valid = claims();
  return [
    vector("valid", valid, ok),
    vector("valid with an allowed scope", valid, ok, { scope: "ws:edit" }),
    vector("step 1 oversize token", `${sign(valid)}${"A".repeat(4096)}`, no("capability_malformed", 1)),
    vector("step 1 not three segments", sign(valid).split(".").slice(0, 2).join("."), no("capability_malformed", 1)),
    vector("step 1 payload not JSON", `${sign(valid).split(".")[0]}.${Buffer.from("not json").toString("base64url")}.${sign(valid).split(".")[2]}`, no("capability_malformed", 1)),
    vector("step 2 extra header member", sign(valid, { ...header, crit: ["b64"] }, header.kid), no("capability_malformed", 2)),
    vector("step 2 alg none", sign(valid, { ...header, alg: "none" }, header.kid), no("capability_malformed", 2)),
    vector("step 2 normalised typ", sign(valid, { ...header, typ: "application/zeros-cap+jwt" }, header.kid), no("capability_malformed", 2)),
    vector("step 2 missing kid", sign(valid, { alg: "EdDSA", typ: "zeros-cap+jwt" }, header.kid), no("capability_malformed", 2)),
    vector("step 2 aud array", claims({ aud: [aud] }), no("capability_malformed", 2)),
    vector("step 3 unknown kid", sign(valid, { ...header, kid: "cap-2026-10-zz" }), no("capability_key_unknown", 3)),
    vector("step 4 signature by another key", sign(valid, header, "cap-2026-10-forged"), no("capability_signature_invalid", 4)),
    vector("step 4 tampered payload", `${sign(valid).split(".")[0]}.${Buffer.from(JSON.stringify(claims({ role: "owner" }))).toString("base64url")}.${sign(valid).split(".")[2]}`,
      no("capability_signature_invalid", 4)),
    vector("step 5 issuer mismatch", claims({ iss: "https://other.example.test" }), no("capability_issuer_mismatch", 5)),
    vector("step 5 cv major 2", claims({ cv: 2 }), no("capability_contract_unsupported", 5)),
    vector("step 6 other client audience", claims({ aud: aud === "zeros:engine" ? "zeros:realtime" : "zeros:engine" }), no("capability_audience_mismatch", 6)),
    vector("step 6 engine kind at a client endpoint", testEngineClaims({ aud }), no("capability_audience_mismatch", 6)),
    vector("step 7 missing dk epoch", claims({ ep: { wa: 12, wr: 3, me: 5, ac: 1 } }), no("capability_malformed", 7)),
    vector("step 7 lifetime over 300 s", claims({ exp: TEST_CAPABILITY_NOW_S + 300 }), no("capability_malformed", 7)),
    vector("step 8 workspace mismatch", claims({ wsp: "77777777-7777-4777-8777-777777777777" }), no("capability_workspace_mismatch", 8)),
    vector("step 8 organization mismatch", claims({ org: "77777777-7777-4777-8777-777777777777" }), no("capability_workspace_mismatch", 8)),
    vector("step 8 generation mismatch", claims({ gen: 8 }), no("capability_generation_mismatch", 8)),
    vector("step 8 engine instance mismatch", claims({ ein: "88888888-8888-4888-8888-888888888888" }), no("capability_generation_mismatch", 8)),
    vector("step 9 nbf at the leeway edge", claims({ nbf: TEST_CAPABILITY_NOW_S + 30 }), ok),
    vector("step 9 nbf past the leeway", claims({ nbf: TEST_CAPABILITY_NOW_S + 30, iat: TEST_CAPABILITY_NOW_S + 30, exp: TEST_CAPABILITY_NOW_S + 300 }),
      no("capability_not_yet_valid", 9), { nowMs: NOW_MS - 1, proofOptions: { tsMs: NOW_MS - 1 } }),
    vector("step 9 one millisecond before exp", claims({ exp: TEST_CAPABILITY_NOW_S + 1 }), ok, { nowMs: NOW_MS + 999, proofOptions: { tsMs: NOW_MS + 999 } }),
    vector("step 9 exp with no leeway", claims({ exp: TEST_CAPABILITY_NOW_S }), no("capability_expired", 9)),
    vector("step 10 epoch below known", valid, no("capability_revoked", 10), { known: [[`me:${ids.org}:${ids.user}`, 6]] }),
    vector("step 10 epoch at known", valid, ok, { known: [[`me:${ids.org}:${ids.user}`, 5], [`wa:${ids.workspace}`, 12]] }),
    vector("step 11 revoked session", valid, no("capability_revoked", 11), { revoked: [["sid", ids.session]] }),
    vector("step 11 revoked device", valid, no("capability_revoked", 11), { revoked: [["did", ids.device]] }),
    vector("step 12 missing proof", valid, no("capability_proof_invalid", 12), { noProof: true }),
    vector("step 12 proof for the other route", valid, no("capability_proof_invalid", 12), { proofOptions: { signRoute: route === "direct" ? "relay" : "direct" } }),
    vector("step 12 proof by another device key", valid, no("capability_proof_invalid", 12), { proofOptions: { device: "device-b" } }),
    vector("step 12 stale proof", valid, no("capability_proof_invalid", 12), { proofOptions: { tsMs: NOW_MS - 30_001 } }),
    vector("step 12 proof for another token", valid, no("capability_proof_invalid", 12), { proofOptions: { jti: "ZZZZZZZZZZZZZZZZZZZZZZ" } }),
    vector("step 12 replayed proof", valid, no("capability_proof_invalid", 12), { repeat: true }),
    vector("step 13 scope not granted", claims({ role: "viewer", scp: ["ws:read"] }), no("capability_scope_denied", 13), { scope: "ws:edit" }),
    vector("step 13 cross-kind scope", valid, no("capability_scope_denied", 13), { scope: "engine:checkpoint" }),
  ];
}

function engineVectors(): ConformanceVector[] {
  const pin = { aud: "zeros:api", knd: "engine" } as const;
  const vector = (name: string, payload: Record<string, unknown> | string, expectation: ConformanceVector["expect"], extra: Partial<ConformanceVector> & { scope?: string } = {}): ConformanceVector => {
    const { scope, ...rest } = extra;
    return { name: `zeros:api ${name}`, pin, token: typeof payload === "string" ? payload : sign(payload),
      context: { ...placement(), ...(scope ? { scope } : {}) }, nowMs: NOW_MS, expect: expectation, ...rest };
  };
  const valid = testEngineClaims();
  return [
    vector("valid", valid, ok, { scope: "engine:history.write" }),
    vector("step 1 oversize token", `${sign(valid)}${"A".repeat(4096)}`, no("capability_malformed", 1)),
    vector("step 2 jku header member", sign(valid, { ...header, jku: "https://evil.example.test" }, header.kid), no("capability_malformed", 2)),
    vector("step 2 aud array", testEngineClaims({ aud: ["zeros:api"] }), no("capability_malformed", 2)),
    vector("step 3 unknown kid", sign(valid, { ...header, kid: "cap-2026-10-zz" }), no("capability_key_unknown", 3)),
    vector("step 4 signature by another key", sign(valid, header, "cap-2026-10-forged"), no("capability_signature_invalid", 4)),
    vector("step 5 issuer mismatch", testEngineClaims({ iss: "https://other.example.test" }), no("capability_issuer_mismatch", 5)),
    vector("step 5 cv major 2", testEngineClaims({ cv: 2 }), no("capability_contract_unsupported", 5)),
    vector("step 6 client token at an engine route", testClientClaims(), no("capability_audience_mismatch", 6)),
    vector("step 6 client kind with the api audience", testClientClaims({ aud: "zeros:api" }), no("capability_audience_mismatch", 6)),
    vector("step 7 missing wa epoch", testEngineClaims({ ep: { zz: 1 } }), no("capability_malformed", 7)),
    vector("step 8 workspace mismatch", testEngineClaims({ wsp: "77777777-7777-4777-8777-777777777777" }), no("capability_workspace_mismatch", 8)),
    vector("step 8 generation mismatch", testEngineClaims({ gen: 6 }), no("capability_generation_mismatch", 8)),
    vector("step 8 engine instance mismatch", testEngineClaims({ ein: "88888888-8888-4888-8888-888888888888", sub: "engine:88888888-8888-4888-8888-888888888888" }),
      no("capability_generation_mismatch", 8)),
    vector("step 9 exp with no leeway", testEngineClaims({ exp: TEST_CAPABILITY_NOW_S }), no("capability_expired", 9)),
    vector("step 10 wa below known", valid, no("capability_revoked", 10), { known: [[`wa:${ids.workspace}`, 13]] }),
    vector("step 13 scope not granted", testEngineClaims({ scp: ["engine:checkpoint"] }), no("capability_scope_denied", 13), { scope: "engine:credentials.read" }),
    vector("step 13 cross-kind scope", valid, no("capability_scope_denied", 13), { scope: "ws:read" }),
  ];
}

export function buildCapabilityConformance(): ConformanceFixture {
  return {
    contract: "zeros-cap", version: "1.0.1", issuer: TEST_CAPABILITY_ISSUER,
    keys: [testSigningJwk("cap-2026-10-a")],
    vectors: [...clientVectors("zeros:engine", "direct", 0), ...clientVectors("zeros:engine", "relay", 100),
      ...clientVectors("zeros:realtime", "relay", 200), ...engineVectors()],
  };
}

/** Seeds a fresh verifier with a vector's known epochs and revocations. */
export function seedConformanceState(verifier: Pick<CapabilityVerifier, "mergeKnown" | "revoke">, vector: ConformanceVector): void {
  if (vector.known) verifier.mergeKnown(vector.known);
  for (const [kind, id] of vector.revoked ?? []) verifier.revoke(kind, id);
}

/** Normalises a verifier result to the vector's expectation shape. */
export function conformanceOutcome(result: CapabilityVerifyResult): ConformanceVector["expect"] {
  return result.ok ? { ok: true } : { ok: false, code: result.code, step: result.step };
}

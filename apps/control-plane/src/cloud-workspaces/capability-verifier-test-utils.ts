import { createHash, createPrivateKey, createPublicKey, sign as signBytes, type KeyObject } from "node:crypto";

import { capabilityProofMessage, type CapabilityPublicJwk, type CapabilityRoute } from "./capability-verifier.js";

/** Deterministic test-only Ed25519 keys (never used outside tests): the seed
 * is derived from a label, so no key material is stored in the repository. */
export function testEd25519Key(label: string): { privateKey: KeyObject; x: string } {
  const seed = createHash("sha256").update(`zeros-capability-test-key\n${label}`, "utf8").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x: string };
  return { privateKey, x: jwk.x };
}

export function testSigningJwk(kid: string, label = kid): CapabilityPublicJwk {
  return { kty: "OKP", crv: "Ed25519", x: testEd25519Key(label).x, kid, use: "sig", alg: "EdDSA" };
}

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8").toString("base64url");

/** Signs `payload` under `header` with the label's key. Ed25519 is
 * deterministic, so the same inputs always give the same token. */
export function signTestCapability(header: Record<string, unknown>, payload: unknown, label = String(header.kid)): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const signature = signBytes(null, Buffer.from(input, "ascii"), testEd25519Key(label).privateKey).toString("base64url");
  return `${input}.${signature}`;
}

export function signTestProof(deviceLabel: string, fields: {
  aud: string; wsp: string; jti: string; timestampMs: number; nonce: string; route: CapabilityRoute;
}): string {
  return signBytes(null, capabilityProofMessage(fields), testEd25519Key(deviceLabel).privateKey).toString("base64url");
}

export const TEST_CAPABILITY_ISSUER = "https://cp.example.test";
export const TEST_CAPABILITY_IDS = {
  user: "11111111-1111-4111-8111-111111111111",
  org: "22222222-2222-4222-8222-222222222222",
  workspace: "33333333-3333-4333-8333-333333333333",
  engine: "44444444-4444-4444-8444-444444444444",
  session: "55555555-5555-4555-8555-555555555555",
  device: "66666666-6666-4666-8666-666666666666",
} as const;
/** 2026-10-17T00:00:00Z */
export const TEST_CAPABILITY_NOW_S = 1_792_195_200;

export function testClientClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ids = TEST_CAPABILITY_IDS;
  return {
    iss: TEST_CAPABILITY_ISSUER, aud: "zeros:engine", sub: `user:${ids.user}`, knd: "client",
    org: ids.org, wsp: ids.workspace, gen: 7, ein: ids.engine, role: "developer",
    scp: ["ws:edit", "ws:prompt", "ws:read"], ep: { wa: 12, wr: 3, me: 5, ac: 1, dk: 2 },
    sid: ids.session, did: ids.device, cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: testEd25519Key("device-a").x } },
    iat: TEST_CAPABILITY_NOW_S - 10, nbf: TEST_CAPABILITY_NOW_S - 10, exp: TEST_CAPABILITY_NOW_S + 290,
    jti: "AAAAAAAAAAAAAAAAAAAAAA", cv: 1, ...overrides,
  };
}

export function testEngineClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ids = TEST_CAPABILITY_IDS;
  return {
    iss: TEST_CAPABILITY_ISSUER, aud: "zeros:api", sub: `engine:${ids.engine}`, knd: "engine",
    org: ids.org, wsp: ids.workspace, gen: 7, ein: ids.engine,
    scp: ["engine:checkpoint", "engine:credentials.read", "engine:history.write"], ep: { wa: 12 },
    iat: TEST_CAPABILITY_NOW_S - 10, nbf: TEST_CAPABILITY_NOW_S - 10, exp: TEST_CAPABILITY_NOW_S + 290,
    jti: "BBBBBBBBBBBBBBBBBBBBBB", cv: 1, ...overrides,
  };
}

export const TEST_CAPABILITY_HEADER = { alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" } as const;

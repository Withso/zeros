import { describe, expect, it } from "vitest";
import * as mirror from "./capability-contract.js";
import * as protocol from "../../../../packages/protocol/src/cloud-capabilities.js";

/** The mirrored contract must behave identically on every input: parse
 * success and the parsed value. */
function parity<T>(name: string, value: unknown, service: { parse: (v: unknown) => T }, shared: { parse: (v: unknown) => T }) {
  const left = safe(service, value), right = safe(shared, value);
  expect(left.ok, name).toBe(right.ok);
  if (left.ok && right.ok) expect(left.value, name).toEqual(right.value);
}

function safe<T>(schema: { parse: (v: unknown) => T }, value: unknown): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: schema.parse(value) };
  } catch {
    return { ok: false };
  }
}

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";
const DEVICE_KEY = { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) } as const;

const clientClaims = {
  iss: "https://cp.example.test", aud: "zeros:engine", sub: `user:${UUID}`, knd: "client",
  org: UUID2, wsp: UUID, gen: 7, ein: UUID2, role: "developer",
  scp: ["ws:edit", "ws:prompt", "ws:read"], ep: { wa: 12, wr: 3, me: 5, ac: 1, dk: 2 },
  sid: UUID, did: UUID2, cnf: { jwk: DEVICE_KEY }, iat: 1792000000, nbf: 1792000000, exp: 1792000300,
  jti: "A".repeat(22), cv: 1,
};
const engineClaims = {
  iss: "https://cp.example.test", aud: "zeros:api", sub: `engine:${UUID2}`, knd: "engine",
  org: UUID2, wsp: UUID, gen: 7, ein: UUID2, scp: ["engine:credentials.read", "engine:history.write"],
  ep: { wa: 12 }, iat: 1792000000, nbf: 1792000000, exp: 1792000300, jti: "B".repeat(22), cv: 1,
};

describe("capability contract parity", () => {
  it("exposes the same constants", () => {
    for (const key of [
      "CAPABILITY_CONTRACT_VERSION", "CAPABILITY_TOKEN_TYPE", "CAPABILITY_ALGORITHM", "CAPABILITY_TOKEN_LIFETIME_SECONDS",
      "CAPABILITY_NBF_LEEWAY_SECONDS", "CAPABILITY_TOKEN_MAX_BYTES", "CAPABILITY_TOKEN_PARSE_MAX_BYTES",
      "CAPABILITY_POP_DOMAIN", "CAPABILITY_POP_TIMESTAMP_LEEWAY_MS", "CAPABILITY_POP_REPLAY_WINDOW_MS",
      "CAPABILITY_JWKS_PATH", "CAPABILITY_AUDIENCES", "CAPABILITY_KINDS", "CAPABILITY_CLIENT_SCOPES",
      "CAPABILITY_ENGINE_SCOPES", "CAPABILITY_ERROR_CODES",
    ] as const) {
      expect(mirror[key], key).toEqual(protocol[key]);
    }
    expect(String(mirror.CAPABILITY_KEY_ID_PATTERN)).toBe(String(protocol.CAPABILITY_KEY_ID_PATTERN));
  });

  it("accepts the frozen examples and rejects pinned deviations identically", () => {
    const cases: Array<[string, unknown]> = [
      ["valid client", clientClaims],
      ["valid engine", engineClaims],
      ["client without epochs", { ...clientClaims, ep: { wa: 12, wr: 3 } }],
      ["client with engine scope", { ...clientClaims, scp: ["ws:read", "engine:checkpoint"] }],
      ["client with api audience", { ...clientClaims, aud: "zeros:api" }],
      ["client without cnf", { ...clientClaims, cnf: undefined }],
      ["engine without ein", { ...engineClaims, ein: undefined }],
      ["engine with cnf", { ...engineClaims, cnf: { jwk: DEVICE_KEY } }],
      ["engine with client epochs", { ...engineClaims, ep: { wa: 12, dk: 2 } }],
      ["engine with ws scope", { ...engineClaims, scp: ["engine:checkpoint", "ws:read"] }],
      ["engine with client audience", { ...engineClaims, aud: "zeros:engine" }],
      ["subject kind mismatch", { ...engineClaims, sub: `user:${UUID}` }],
      ["duplicate scopes", { ...clientClaims, scp: ["ws:read", "ws:read"] }],
      ["empty scopes", { ...clientClaims, scp: [] }],
      ["bad jti", { ...clientClaims, jti: "short" }],
      ["bad iss", { ...clientClaims, iss: "http://cp.example.test" }],
      ["cv 2", { ...clientClaims, cv: 2 }],
      ["exp below iat window is schema-valid", { ...clientClaims, exp: clientClaims.iat }],
      ["uppercase uuid", { ...clientClaims, org: UUID2.toUpperCase() }],
      ["unknown claim allowed", { ...engineClaims, future: { additive: true } }],
      ["extra epoch key allowed", { ...engineClaims, ep: { wa: 12, zz: 4 } }],
    ];
    for (const [name, value] of cases)
      parity(name, value, mirror.CapabilityClaimsSchema, protocol.CapabilityClaimsSchema);
  });

  it("pins the header exactly", () => {
    const good = { alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" };
    const cases: Array<[string, unknown]> = [
      ["valid", good],
      ["none alg", { ...good, alg: "none" }],
      ["hs256", { ...good, alg: "HS256" }],
      ["wrong typ case", { ...good, typ: "ZEROS-CAP+JWT" }],
      ["application prefix typ", { ...good, typ: "application/zeros-cap+jwt" }],
      ["crit member", { ...good, crit: ["b64"] }],
      ["jku member", { ...good, jku: "https://evil.example.test/jwks.json" }],
      ["missing kid", { alg: "EdDSA", typ: "zeros-cap+jwt" }],
      ["bad kid", { ...good, kid: "cap-2026-1-A" }],
    ];
    for (const [name, value] of cases)
      parity(`header ${name}`, value, mirror.CapabilityHeaderSchema, protocol.CapabilityHeaderSchema);
  });

  it("scopes and required epochs agree", () => {
    for (const claims of [clientClaims, engineClaims]) {
      const parsed = mirror.CapabilityClaimsSchema.parse(claims);
      for (const scope of [...mirror.CAPABILITY_CLIENT_SCOPES, ...mirror.CAPABILITY_ENGINE_SCOPES, "ws:unknown", "other:read"])
        expect(mirror.capabilityGrantsScope(parsed, scope)).toBe(protocol.capabilityGrantsScope(parsed, scope));
    }
    expect(mirror.capabilityRequiredEpochs("client")).toEqual(protocol.capabilityRequiredEpochs("client"));
    expect(mirror.capabilityRequiredEpochs("engine")).toEqual(protocol.capabilityRequiredEpochs("engine"));
  });
});

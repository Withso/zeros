import { describe, expect, it } from "vitest";
import {
  CAPABILITY_AUDIENCES,
  CAPABILITY_ERROR_CODES,
  CAPABILITY_KEY_ID_PATTERN,
  CAPABILITY_TOKEN_LIFETIME_SECONDS,
  CAPABILITY_TOKEN_MAX_BYTES,
  CAPABILITY_TOKEN_TYPE,
  CapabilityClaimsSchema,
  CapabilityHeaderSchema,
  capabilityRequiredEpochs,
} from "../cloud-capabilities.js";

/** Frozen 1.0.0 pins (docs/cloud-workspace/contracts/s1-capabilities.md):
 * changing any of these is a contract change, not a refactor. */
describe("cloud capability contract (frozen 1.0.0)", () => {
  it("pins the header to EdDSA, the capability typ and a cap- kid", () => {
    expect(CapabilityHeaderSchema.parse({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" }))
      .toEqual({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" });
    expect(CapabilityHeaderSchema.safeParse({ alg: "HS256", typ: "zeros-cap+jwt", kid: "cap-2026-10-a" }).success).toBe(false);
    expect(CapabilityHeaderSchema.safeParse({ alg: "EdDSA", typ: "JWT", kid: "cap-2026-10-a" }).success).toBe(false);
    expect(CapabilityHeaderSchema.safeParse({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "other" }).success).toBe(false);
    expect(CapabilityHeaderSchema.safeParse({ alg: "EdDSA", typ: "zeros-cap+jwt", kid: "cap-2026-10-a", extra: 1 }).success).toBe(false);
  });

  it("pins constants, audiences and the error code list", () => {
    expect(CAPABILITY_TOKEN_TYPE).toBe("zeros-cap+jwt");
    expect(CAPABILITY_TOKEN_LIFETIME_SECONDS).toBe(300);
    expect(CAPABILITY_TOKEN_MAX_BYTES).toBe(4096);
    expect(CAPABILITY_AUDIENCES).toEqual(["zeros:engine", "zeros:realtime", "zeros:api"]);
    expect(CAPABILITY_ERROR_CODES).toContain("capability_revoked");
    expect(CAPABILITY_ERROR_CODES).toHaveLength(15);
    expect(CAPABILITY_KEY_ID_PATTERN.test("cap-2026-10-a")).toBe(true);
  });

  it("requires the fixed epoch keys per kind", () => {
    expect(capabilityRequiredEpochs("client")).toEqual(["wa", "wr", "me", "ac", "dk"]);
    expect(capabilityRequiredEpochs("engine")).toEqual(["wa"]);
  });

  it("enforces kind-specific claim rules", () => {
    const uuid = "a3ab0e3b-2f64-4d88-a37b-8428b341db78";
    const base = {
      iss: "https://cp.example.test", aud: "zeros:api", sub: `engine:${uuid}`, knd: "engine",
      org: uuid, wsp: uuid, gen: 1, scp: ["engine:checkpoint"], ep: { wa: 1 },
      iat: 1_760_000_000, nbf: 1_760_000_000, exp: 1_760_000_300, jti: "AAAAAAAAAAAAAAAAAAAAAA", cv: 1,
    };
    expect(CapabilityClaimsSchema.safeParse({ ...base, ein: uuid }).success).toBe(true);
    expect(CapabilityClaimsSchema.safeParse(base).success).toBe(false); // engine requires ein
    expect(CapabilityClaimsSchema.safeParse({ ...base, ein: uuid, sid: uuid }).success).toBe(false); // engine forbids sid
    const client = {
      ...base, aud: "zeros:engine", sub: `user:${uuid}`, knd: "client", scp: ["ws:read"],
      ep: { wa: 1, wr: 1, me: 1, ac: 1, dk: 1 }, role: "viewer", sid: uuid, did: uuid,
      cnf: { jwk: { kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } },
    };
    expect(CapabilityClaimsSchema.safeParse(client).success).toBe(true);
    expect(CapabilityClaimsSchema.safeParse({ ...client, cnf: undefined }).success).toBe(false);
    expect(CapabilityClaimsSchema.safeParse({ ...client, ep: { wa: 1, wr: 1, me: 1, ac: 1 } }).success).toBe(false);
    expect(CapabilityClaimsSchema.safeParse({ ...client, aud: ["zeros:engine"] }).success).toBe(false); // string-only aud
  });
});

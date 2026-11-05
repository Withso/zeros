import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RuntimeCanaryAuthority, loadRuntimeCanaryPolicy } from "./runtime-canary.js";

const now = 1_800_000_000;
const creatorUserId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const request = { creatorUserId, organizationId, createKey: "runtime-canary-123" };
const pair = generateKeyPairSync("ed25519");
const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const policy = { keys: [{ id: "current", publicKey }], fixture: { creatorUserId, organizationId, repositoryId: "42" } };
const claims = () => ({ version: 1, iss: "zeros-runtime-release", aud: "zeros-cloud-runtime-canary", channel: "alpha",
  jti: randomUUID(), iat: now, exp: now + 900, runId: "123", runAttempt: 1, runtimeSha256: "a".repeat(64),
  sourceSha: "b".repeat(40), creatorUserId, organizationId, repositoryId: "42", createKey: request.createKey });
function token(payload = claims(), header: Record<string, unknown> = { alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "current" }, key = pair.privateKey) {
  const input = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}
const authority = () => new RuntimeCanaryAuthority(loadRuntimeCanaryPolicy(JSON.stringify(policy), "alpha")!, () => now * 1000);

describe("Alpha runtime canary authority", () => {
  it("admits an exact fixture-bound fifteen-minute Ed25519 grant without retaining the credential", () => {
    const raw = token(), admitted = authority().verify(raw, request);
    expect(admitted).toMatchObject({ ...request, repositoryId: "42", runtimeSha256: "a".repeat(64), runId: "123", runAttempt: 1,
      grantHash: createHash("sha256").update(raw).digest("hex") });
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(JSON.stringify(admitted)).not.toContain(raw);
  });

  it.each([
    { iss: "other" }, { aud: "worker" }, { channel: "beta" }, { runtimeSha256: "arbitrary" }, { sourceSha: "main" },
    { creatorUserId: randomUUID() }, { organizationId: randomUUID() }, { repositoryId: "43" }, { createKey: "other-key" },
    { iat: now + 31 }, { exp: now }, { iat: now - 1, exp: now + 900 }, { exp: now + 901 }, { iat: now + 30, exp: now + 930 }, { extraAuthority: "admin" },
  ])("refuses a signed grant with mismatched or excessive authority: %j", patch => {
    expect(() => authority().verify(token({ ...claims(), ...patch }), request)).toThrow("Runtime canary admission was refused");
  });

  it.each([{ alg: "none" }, { alg: "HS256" }, { typ: "JWT" }, { kid: "retired" }, { extra: true }])(
    "refuses a different signing contract: %j", patch => {
      expect(() => authority().verify(token(claims(), { alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "current", ...patch }), request)).toThrow();
    });

  it("does not trust an otherwise valid grant signed by a worker or unrelated key", () => {
    const foreign = generateKeyPairSync("ed25519");
    expect(() => authority().verify(token(claims(), undefined, foreign.privateKey), request)).toThrow();
    const original = token(), parts = original.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    parts[1] = Buffer.from(JSON.stringify({ ...payload, runtimeSha256: "c".repeat(64) })).toString("base64url");
    expect(() => authority().verify(parts.join("."), request)).toThrow();
  });

  it.each([{ creatorUserId: randomUUID() }, { organizationId: randomUUID() }, { createKey: undefined }, { createKey: "another-create" }])(
    "binds the signed grant to the actual authenticated create: %j", patch => {
      expect(() => authority().verify(token(), { ...request, ...patch })).toThrow();
    });

  it.each(["development", "beta", "production"])("cannot enable canary authority in %s", channel => {
    expect(() => loadRuntimeCanaryPolicy(JSON.stringify(policy), channel)).toThrow("Alpha-only");
    expect(loadRuntimeCanaryPolicy(undefined, channel)).toBeUndefined();
  });

  it("accepts only public Ed25519 material and distinct rotation key ids", () => {
    const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(() => loadRuntimeCanaryPolicy(JSON.stringify({ ...policy, keys: [{ id: "current", publicKey: privateKey }] }), "alpha")).toThrow();
    expect(() => loadRuntimeCanaryPolicy(JSON.stringify({ ...policy, keys: [...policy.keys, ...policy.keys] }), "alpha")).toThrow();
    const other = generateKeyPairSync("ed25519");
    const next = { id: "next", publicKey: other.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
    const rotated = new RuntimeCanaryAuthority({ ...policy, keys: [...policy.keys, next] }, () => now * 1000);
    expect(rotated.verify(token(), request).runId).toBe("123");
    const newToken = token(claims(), { alg: "EdDSA", typ: "zeros-runtime-canary+jwt", kid: "next" }, other.privateKey);
    expect(rotated.verify(newToken, request).runId).toBe("123");
    const retired = new RuntimeCanaryAuthority({ ...policy, keys: [next] }, () => now * 1000);
    expect(() => retired.verify(token(), request)).toThrow();
    expect(retired.verify(newToken, request).runId).toBe("123");
  });

  it("rejects noncanonical DER even for a dedicated canary key", () => {
    const bytes = Buffer.concat([pair.publicKey.export({ format: "der", type: "spki" }), Buffer.from([0, 0])]);
    expect(() => loadRuntimeCanaryPolicy(JSON.stringify({ ...policy, keys: [{ id: "current", publicKey: bytes.toString("base64") }] }), "alpha")).toThrow();
    expect(loadRuntimeCanaryPolicy(JSON.stringify(policy), "alpha")).toEqual(policy);
  });

  it("refuses malformed encodings without reflecting any token material", () => {
    for (const value of ["synthetic-sensitive-token", "a.b.c", token() + "=", "x".repeat(4097)]) {
      try { authority().verify(value, request); throw new Error("Expected refusal"); }
      catch (error) { expect(String(error)).toBe("Error: Runtime canary admission was refused"); }
    }
  });
});

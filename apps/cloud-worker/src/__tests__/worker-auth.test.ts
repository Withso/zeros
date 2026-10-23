import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { expect, it } from "vitest";
import { WorkerTokenVerifier } from "../worker-auth";

const workspaceId = randomUUID(), bootId = randomUUID(), now = 1_800_000_000;
const current = generateKeyPairSync("ed25519"), previous = generateKeyPairSync("ed25519");
const publicKey = (key = current) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
function token(patch: Record<string, unknown> = {}, key = current): string {
  const claims = { iss: "zeros-cp", aud: workspaceId, boot: bootId, iat: now, exp: now + 60, jti: randomUUID(), ...patch };
  const body = `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${body}.${sign(null, Buffer.from(body), key.privateKey).toString("base64url")}`;
}
const verifier = (keys = [publicKey()], capacity = 4096) => new WorkerTokenVerifier({ workspaceId, bootId, publicKeys: keys, now: () => now * 1000, capacity });

it("accepts a correctly scoped token exactly once, including during the expiry skew", () => {
  const verify = verifier(), auth = token({ iat: now - 60, exp: now });
  expect(verify.accept(auth)).toBe(true);
  expect(verify.accept(auth)).toBe(false);
});

it.each([
  { iat: now - 92, exp: now - 31 }, { iat: now + 31, exp: now + 60 }, { iat: now, exp: now + 61 },
  { iat: now, exp: now }, { aud: randomUUID() }, { boot: randomUUID() }, { iss: "elsewhere" },
  { iat: "1800000000" }, { exp: null }, { jti: "" }, { extra: "unknown-claim" },
])("rejects invalid temporal or identity claims (%j)", patch => {
  expect(verifier().accept(token(patch))).toBe(false);
});

it("allows thirty seconds of clock skew and both rotation keys, but no untrusted key", () => {
  expect(verifier().accept(token({ iat: now + 30, exp: now + 60 }))).toBe(true);
  expect(verifier().accept(token({ iat: now - 89, exp: now - 29 }))).toBe(true);
  expect(verifier().accept(token({}, previous))).toBe(false);
  const verify = verifier([publicKey(), publicKey(previous)]);
  expect(verify.accept(token({}, current))).toBe(true);
  expect(verify.accept(token({}, previous))).toBe(true);
});

it("fails closed at the replay-cache bound instead of evicting a still-usable jti", () => {
  const verify = verifier([publicKey()], 2), first = token();
  expect(verify.accept(first)).toBe(true);
  expect(verify.accept(token())).toBe(true);
  expect(verify.accept(token())).toBe(false);
  expect(verify.accept(first)).toBe(false);
});

it("rejects malformed compact signatures and non-Ed25519 keys", () => {
  for (const auth of ["", "v2.a.b", "v1.%%%.%%%", `${token()}.extra`, token().slice(0, -4), "a".repeat(8193)])
    expect(verifier().accept(auth)).toBe(false);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  expect(() => verifier([rsa.publicKey.export({ format: "pem", type: "spki" }).toString()])).toThrow();
});

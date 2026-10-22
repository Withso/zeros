import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { expect, it } from "vitest";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { sealPortToken, openPortToken } from "./worker-port-token.js";

const encoded = () => generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
it("signs sixty-second, workspace- and boot-bound grants with rotating public verification keys", () => {
  const signer = new CloudV2WorkerSigner(encoded(), encoded()), workspace = randomUUID(), boot = randomUUID();
  const one = signer.mint(workspace, boot), two = signer.mint(workspace, boot);
  expect(one).not.toBe(two);
  const [version, body, signature] = one.split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(version).toBe("v1");
  expect(claims).toMatchObject({ iss: "zeros-cp", aud: workspace, boot });
  expect(claims.exp - claims.iat).toBe(60);
  expect(signer.publicKeys).toHaveLength(2);
  expect(verify(null, Buffer.from(`${version}.${body}`), signer.publicKeys[0]!, Buffer.from(signature!, "base64url"))).toBe(true);
});
it("refuses absent, malformed and non-Ed25519 signing keys without reflecting the value", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  for (const key of ["", "synthetic-invalid-key", rsa]) expect(() => new CloudV2WorkerSigner(key)).toThrow("Invalid worker signing key");
});
it("encrypts port tokens with workspace- and purpose-bound AAD and supports key rotation", () => {
  const workspace = randomUUID(), token = "synthetic-private-port-token";
  const keys = { currentKeyVersion: 2, keys: { 1: Buffer.alloc(32, 1).toString("base64url"), 2: Buffer.alloc(32, 2).toString("base64url") } };
  const envelope = sealPortToken(token, workspace, keys);
  expect(JSON.stringify(envelope)).not.toContain(token);
  expect(openPortToken(envelope, workspace, keys)).toBe(token);
  expect(() => openPortToken(envelope, randomUUID(), keys)).toThrow();
  const old = sealPortToken(token, workspace, { ...keys, currentKeyVersion: 1 });
  expect(openPortToken(old, workspace, keys)).toBe(token);
  expect(() => openPortToken(envelope, workspace, { currentKeyVersion: 1, keys: { 1: keys.keys[1] } })).toThrow();
});

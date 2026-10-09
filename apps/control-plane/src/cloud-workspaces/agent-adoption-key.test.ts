import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  sealCloudAgentAdoptionKey, openCloudAgentAdoptionKey, fingerprintCloudAgentAdoption,
  type CloudAgentAdoptionKeyBinding,
} from "./agent-boot-credentials.js";

const roots = { 1: randomBytes(32).toString("base64url"), 2: randomBytes(32).toString("base64url") };
const scope = (): CloudAgentAdoptionKeyBinding => ({ organizationId: randomUUID(), workspaceId: randomUUID(),
  fundingOwnerUserId: randomUUID(), provider: "codex", kind: "codex-chatgpt", keyId: randomUUID(), keyVersion: 1 });
const access = { kind: "codex-chatgpt" as const, accountId: "synthetic-stable-account", accessToken: "synthetic-provider-access-A", expiresAt: 1893456000 };

describe("CP scoped adoption-key wrapping", () => {
  it("opens only the exact scoped key, with positive fixed-size plaintext", () => {
    const admitted = scope(), key = randomBytes(32), envelope = sealCloudAgentAdoptionKey(key, admitted, roots[1]);
    const opened = openCloudAgentAdoptionKey(envelope, admitted, roots);
    expect(opened.equals(key)).toBe(true);
    expect(envelope.ciphertext.includes(key)).toBe(false);
    opened.fill(0); key.fill(0);
  });

  it.each(["organizationId", "workspaceId", "fundingOwnerUserId", "keyId"] as const)("denies wrapping transplant at %s", field => {
    const admitted = scope(), key = randomBytes(32), envelope = sealCloudAgentAdoptionKey(key, admitted, roots[1]);
    expect(() => openCloudAgentAdoptionKey(envelope, { ...admitted, [field]: randomUUID() }, roots)).toThrow("cloud_validation_access_denied");
    key.fill(0);
  });

  it("binds provider, kind and wrapping root version", () => {
    const admitted = scope(), key = randomBytes(32), envelope = sealCloudAgentAdoptionKey(key, admitted, roots[1]);
    expect(() => openCloudAgentAdoptionKey(envelope, { ...admitted, provider: "claude", kind: "claude-setup-token" }, roots)).toThrow("cloud_validation_access_denied");
    expect(() => openCloudAgentAdoptionKey(envelope, { ...admitted, kind: "codex-api-key" }, roots)).toThrow("cloud_validation_access_denied");
    expect(() => openCloudAgentAdoptionKey(envelope, { ...admitted, keyVersion: 2 }, roots)).toThrow("cloud_validation_access_denied");
    key.fill(0);
  });

  it("does not remint or expose a key when a root is missing or ciphertext corrupt", () => {
    const admitted = scope(), key = randomBytes(32), envelope = sealCloudAgentAdoptionKey(key, admitted, roots[1]);
    expect(() => openCloudAgentAdoptionKey(envelope, admitted, { 2: roots[2] })).toThrow("cloud_validation_access_denied");
    expect(() => openCloudAgentAdoptionKey({ ...envelope, authTag: Buffer.alloc(16) }, admitted, roots)).toThrow("cloud_validation_access_denied");
    expect(() => openCloudAgentAdoptionKey({ ...envelope, ciphertext: Buffer.alloc(33) }, admitted, roots)).toThrow("cloud_validation_access_denied");
    key.fill(0);
  });

  it.each([0, 16, 31, 33, 64])("refuses a %s-byte scoped fingerprint key", bytes => {
    expect(() => sealCloudAgentAdoptionKey(Buffer.alloc(bytes), scope(), roots[1])).toThrow("cloud_validation_access_denied");
  });

  it("retains unseen A through wrapping-root rotation and old root removal", () => {
    const admitted = scope(), key = randomBytes(32);
    const oldEnvelope = sealCloudAgentAdoptionKey(key, admitted, roots[1]);
    const fingerprintA = fingerprintCloudAgentAdoption(access, admitted, key);
    const oldKey = openCloudAgentAdoptionKey(oldEnvelope, admitted, roots);
    const next = { ...admitted, keyVersion: 2 };
    const nextEnvelope = sealCloudAgentAdoptionKey(oldKey, next, roots[2]);
    const currentKey = openCloudAgentAdoptionKey(nextEnvelope, next, { 2: roots[2] });
    expect(fingerprintCloudAgentAdoption({ ...access, accountId: "synthetic-account-B" }, next, currentKey).equals(fingerprintA)).toBe(false);
    expect(fingerprintCloudAgentAdoption(access, next, currentKey).equals(fingerprintA)).toBe(true);
    oldKey.fill(0); currentKey.fill(0); key.fill(0); fingerprintA.fill(0);
  });

  it("ignores same-account access and expiry rotation", () => {
    const admitted = scope(), key = randomBytes(32);
    const before = fingerprintCloudAgentAdoption(access, admitted, key);
    const after = fingerprintCloudAgentAdoption({ ...access, accessToken: "synthetic-rotated-access-B", expiresAt: 1893466000 }, admitted, key);
    expect(after.equals(before)).toBe(true);
    before.fill(0); after.fill(0); key.fill(0);
  });

  it("uses API-key bytes as key adoption and keeps full scope private", () => {
    const admitted = { ...scope(), kind: "codex-api-key" as const }, key = randomBytes(32);
    const material = { kind: "codex-api-key" as const, apiKey: "synthetic-provider-key-A" };
    const first = fingerprintCloudAgentAdoption(material, admitted, key);
    expect(first.length).toBe(32);
    expect(fingerprintCloudAgentAdoption({ ...material, apiKey: "synthetic-provider-key-B" }, admitted, key).equals(first)).toBe(false);
    expect(fingerprintCloudAgentAdoption(material, { ...admitted, workspaceId: randomUUID() }, key).equals(first)).toBe(false);
    expect(fingerprintCloudAgentAdoption(material, { ...admitted, fundingOwnerUserId: randomUUID() }, key).equals(first)).toBe(false);
    first.fill(0); key.fill(0);
  });

  it("rejects unknown identity, extra private fields and another provider", () => {
    const admitted = scope(), key = randomBytes(32);
    for (const material of [{ ...access, accountId: "" }, { ...access, accountId: undefined },
      { ...access, refreshToken: "synthetic-refresh-not-an-identity" }, { ...access, id_token: "synthetic-id-not-an-identity" },
      { kind: "claude-api-key", apiKey: "synthetic-foreign-provider-key" }])
      expect(() => fingerprintCloudAgentAdoption(material, admitted, key)).toThrow("cloud_validation_access_denied");
    key.fill(0);
  });
});

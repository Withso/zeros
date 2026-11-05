import { randomBytes, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openCloudEnvironment, sealCloudEnvironment } from "./environment-envelope.js";
import { openMcpMaterial } from "../mcp/envelope.js";

const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
const binding = { organizationId: randomUUID(), userId: randomUUID(), repositoryId: "42", versionId: randomUUID(), revision: 1 };
const canary = 'synthetic-canary-"quoted"\nnext-line';
const material = { variables: { APP_SECRET: canary }, files: [{ path: ".env.local", content: `APP_SECRET=${canary}` }] };

it("encrypts values under an independent domain and recovers only the exact binding", () => {
  const envelope = sealCloudEnvironment(material, binding, keys);
  expect(JSON.stringify(envelope).includes(canary)).toBe(false);
  expect(openCloudEnvironment(envelope, binding, keys)).toEqual(material);
  expect(() => openMcpMaterial(envelope, { organizationId: binding.organizationId, ownerUserId: binding.userId, id: binding.versionId, revision: 1, purpose: "config" }, keys)).toThrow();
});

it.each(["organizationId", "userId", "repositoryId", "versionId", "revision"] as const)("rejects ciphertext substitution at %s", field => {
  const envelope = sealCloudEnvironment(material, binding, keys);
  const replacement = field === "revision" ? 2 : field === "repositoryId" ? "43" : randomUUID();
  expect(() => openCloudEnvironment(envelope, { ...binding, [field]: replacement }, keys)).toThrow();
});

it("retains old key versions and refuses missing keys or altered ciphertext", () => {
  const envelope = sealCloudEnvironment(material, binding, keys), rotated = { currentKeyVersion: 2, keys: { ...keys.keys, 2: randomBytes(32).toString("base64url") } };
  expect(openCloudEnvironment(envelope, binding, rotated)).toEqual(material);
  expect(() => openCloudEnvironment(envelope, binding, { ...rotated, keys: { 2: rotated.keys[2] } })).toThrow();
  const altered = { ...envelope, ciphertext: Buffer.alloc(Buffer.from(envelope.ciphertext, "base64url").length).toString("base64url") };
  expect(() => openCloudEnvironment(altered, binding, keys)).toThrow();
});

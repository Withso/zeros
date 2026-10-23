import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openMcpMaterial, sealMcpMaterial } from "./envelope.js";

describe("MCP secret envelope", () => {
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const binding = { organizationId: randomUUID(), id: randomUUID(), ownerUserId: randomUUID(), revision: 1, purpose: "config" as const };
  it("encrypts material and binds it to exact actor/organization/row/revision/purpose", () => {
    const value = { env: { KEY: "fixture-secret" } }, envelope = sealMcpMaterial(value, binding, keys);
    expect(JSON.stringify(envelope)).not.toContain("fixture-secret");
    expect(openMcpMaterial(envelope, binding, keys)).toEqual(value);
    for (const changed of [{ id: randomUUID() }, { organizationId: randomUUID() }, { ownerUserId: null }, { revision: 2 }, { purpose: "oauth" as const }])
      expect(() => openMcpMaterial(envelope, { ...binding, ...changed }, keys)).toThrow();
    expect(() => openMcpMaterial({ ...envelope, ciphertext: randomBytes(20).toString("base64url") }, binding, keys)).toThrow();
  });
});

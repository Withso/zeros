import { hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealCloudAgentCredential, sealCredentialBytes } from "./agent-credential-envelope.js";
import {
  openCloudAgentBootAccess,
  projectCloudAgentBootAccess,
  sealCloudAgentBootAccess,
  type CloudAgentBootVaultBinding,
} from "./agent-boot-credentials.js";

const encoded = randomBytes(32).toString("base64url");
const keys = { 1: encoded, 2: randomBytes(32).toString("base64url") };
const binding = (): CloudAgentBootVaultBinding => ({
  organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
  engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(),
  fundingOwnerUserId: randomUUID(), fundingOwnerEpoch: 1, fundingScope: "workspace-roles-v1",
  cacheRevision: 1, provider: "codex", kind: "codex-chatgpt",
  credentialId: randomUUID(), credentialRevision: 1, connectionRevision: 1, adoptionId: randomUUID(),
  materialVersion: 1, keyVersion: 1, policyDigest: "a".repeat(64),
  expiresAt: "2030-01-01T00:00:00.000Z", refreshAfter: "2029-12-31T23:59:00.000Z",
  authorityExpiresAt: null,
});
const material = {
  kind: "codex-chatgpt" as const, accessToken: "synthetic-boot-access-material",
  accountId: "synthetic-account", expiresAt: 1893456000,
};

describe("CP-only cloud boot access vault", () => {
  it("positively projects subscription access without refresh or native cache fields", () => {
    const projected = projectCloudAgentBootAccess({ ...material, refreshToken: "synthetic-cp-refresh-only" });
    expect(projected).toEqual(material);
    expect(Object.keys(projected).sort()).toEqual(["accessToken", "accountId", "expiresAt", "kind"]);
  });

  it("retains only the selected provider's positive API-key shape", () => {
    expect(projectCloudAgentBootAccess({ kind: "cursor-api-key", apiKey: "synthetic-cursor-api-material", expiresAt: 1893456000 }))
      .toEqual({ kind: "cursor-api-key", apiKey: "synthetic-cursor-api-material" });
    expect(projectCloudAgentBootAccess({ kind: "claude-setup-token", accessToken: "synthetic-claude-setup-material" }))
      .toEqual({ kind: "claude-setup-token", accessToken: "synthetic-claude-setup-material" });
  });

  it("decrypts the admitted access projection only for its exact boot policy", () => {
    const admitted = binding(), envelope = sealCloudAgentBootAccess(material, admitted, encoded);
    expect(openCloudAgentBootAccess(envelope, admitted, keys)).toEqual(material);
    expect(envelope.ciphertext.includes(Buffer.from(material.accessToken))).toBe(false);
  });

  it.each([
    ["organizationId", () => randomUUID()], ["workspaceId", () => randomUUID()],
    ["generation", () => 2], ["engineInstanceId", () => randomUUID()],
    ["bootId", () => randomUUID()], ["writerEpoch", () => randomUUID()],
    ["fundingOwnerUserId", () => randomUUID()], ["fundingOwnerEpoch", () => 2], ["cacheRevision", () => 2],
    ["credentialId", () => randomUUID()],
    ["credentialRevision", () => 2], ["connectionRevision", () => 2],
    ["adoptionId", () => randomUUID()],
    ["materialVersion", () => 2], ["keyVersion", () => 2],
    ["policyDigest", () => "b".repeat(64)],
    ["expiresAt", () => "2030-01-01T00:01:00.000Z"],
    ["refreshAfter", () => "2029-12-31T23:58:00.000Z"],
    ["authorityExpiresAt", () => "2029-12-31T23:59:30.000Z"],
    ["provider", () => "claude"], ["kind", () => "codex-api-key"],
  ] as const)("refuses copied ciphertext after %s is changed", (field, replacement) => {
    const admitted = binding(), envelope = sealCloudAgentBootAccess(material, admitted, encoded);
    expect(() => openCloudAgentBootAccess(envelope, { ...admitted, [field]: replacement() }, keys))
      .toThrow("cloud_validation_access_denied");
  });

  it.each(["refreshToken", "id_token", "nativeCache", "tokens", "environment", "engineHeartbeatToken"])(
    "does not seal the unapproved plaintext field %s", field => {
      expect(() => sealCloudAgentBootAccess({ ...material, [field]: "synthetic-private-field" }, binding(), encoded))
        .toThrow("cloud_validation_access_denied");
    },
  );

  it("closes corrupt envelopes and unknown keys without a decryption diagnostic", () => {
    const admitted = binding(), envelope = sealCloudAgentBootAccess(material, admitted, encoded);
    const corrupted = Buffer.from(envelope.ciphertext); corrupted[0] ^= 1;
    for (const attempt of [
      () => openCloudAgentBootAccess({ ...envelope, ciphertext: corrupted }, admitted, keys),
      () => openCloudAgentBootAccess(envelope, admitted, {}),
      () => openCloudAgentBootAccess(envelope, admitted, { 1: "malformed-key" }),
    ]) {
      try { attempt(); throw new Error("accepted corrupt access vault"); }
      catch (error) {
        expect(error).toMatchObject({ code: "cloud_validation_access_denied", message: "cloud_validation_access_denied" });
      }
    }
  });

  it("does not substitute general credential encryption for the purpose-bound boot vault", () => {
    const admitted = binding(), envelope = sealCloudAgentCredential(material, {
      credentialId: admitted.credentialId, ownerUserId: admitted.fundingOwnerUserId,
      version: admitted.materialVersion, keyVersion: admitted.keyVersion, kind: admitted.kind,
    }, encoded);
    expect(() => openCloudAgentBootAccess(envelope, admitted, keys))
      .toThrow("cloud_validation_access_denied");
  });

  it("rejects unapproved fields even in authenticated decrypted plaintext", () => {
    const admitted = binding(), purpose = "zeros-cloud-agent-boot-access-v1", root = Buffer.from(encoded, "base64url");
    const key = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
    const policy = Buffer.from(JSON.stringify([
      purpose, admitted.organizationId, admitted.workspaceId, admitted.generation, admitted.engineInstanceId, admitted.bootId, admitted.writerEpoch,
      admitted.fundingOwnerUserId, admitted.fundingOwnerEpoch, admitted.fundingScope, admitted.cacheRevision, admitted.provider, admitted.kind,
      admitted.credentialId, admitted.credentialRevision, admitted.connectionRevision, admitted.adoptionId, admitted.materialVersion,
      admitted.keyVersion, admitted.policyDigest, admitted.expiresAt, admitted.refreshAfter, admitted.authorityExpiresAt,
    ]));
    const plaintext = Buffer.from(JSON.stringify({ ...material, refreshToken: "synthetic-cp-only-refresh" }));
    try {
      const envelope = sealCredentialBytes(plaintext, policy, key);
      expect(() => openCloudAgentBootAccess(envelope, admitted, keys)).toThrow("cloud_validation_access_denied");
    } finally { key.fill(0); root.fill(0); plaintext.fill(0); }
  });

  it.each([
    { ...material, expiresAt: material.expiresAt + 1 },
    { kind: "codex-api-key", apiKey: "synthetic-different-provider-key" },
  ])("does not seal material inconsistent with its admitted policy", value => {
    expect(() => sealCloudAgentBootAccess(value, binding(), encoded)).toThrow("cloud_validation_access_denied");
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])("refuses invalid binding revisions without private input in errors (%s)", revision => {
    expect(() => sealCloudAgentBootAccess(material, { ...binding(), cacheRevision: revision }, encoded))
      .toThrow("cloud_validation_access_denied");
  });
});

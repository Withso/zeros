import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";
import { CLOUD_ENVIRONMENT_LIMITS, CloudEnvironmentMaterialSchema, CloudEnvironmentRepositoryIdSchema, type CloudEnvironmentMaterial } from "./environment-contract.js";

const purpose = "zeros-cloud-workspace-environment-v1";
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(), nonce: z.string().max(32),
  ciphertext: z.string().max(2_200_000), authTag: z.string().max(32) }).strict();
export type CloudEnvironmentEnvelope = z.infer<typeof Envelope>;
export interface CloudEnvironmentBinding { organizationId: string; userId: string; repositoryId: string; versionId: string; revision: number }
function associated(binding: CloudEnvironmentBinding, keyVersion: number): Buffer {
  for (const id of [binding.organizationId, binding.userId, binding.versionId]) if (!z.string().uuid().safeParse(id).success) throw new Error("Invalid environment binding");
  if (!CloudEnvironmentRepositoryIdSchema.safeParse(binding.repositoryId).success || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw new Error("Invalid environment binding");
  return Buffer.from(JSON.stringify([purpose, binding.organizationId.toLowerCase(), binding.userId.toLowerCase(), binding.repositoryId,
    binding.versionId.toLowerCase(), binding.revision, keyVersion]));
}
function derive(keys: CloudAgentCredentialKeys, version: number): Buffer {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("Environment key unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Invalid environment key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
export function sealCloudEnvironment(value: CloudEnvironmentMaterial, binding: CloudEnvironmentBinding, keys: CloudAgentCredentialKeys): CloudEnvironmentEnvelope {
  const material = CloudEnvironmentMaterialSchema.parse(value), version = keys.currentKeyVersion, key = derive(keys, version);
  const bytes = Buffer.from(JSON.stringify(material));
  try {
    if (bytes.length > CLOUD_ENVIRONMENT_LIMITS.totalBytes * 6 + 32_768) throw new Error("Environment material too large");
    const sealed = sealCredentialBytes(bytes, associated(binding, version), key);
    return { version: 1, keyVersion: version, nonce: sealed.nonce.toString("base64url"), ciphertext: sealed.ciphertext.toString("base64url"), authTag: sealed.authTag.toString("base64url") };
  } finally { key.fill(0); bytes.fill(0); }
}
export function openCloudEnvironment(value: unknown, binding: CloudEnvironmentBinding, keys: CloudAgentCredentialKeys): CloudEnvironmentMaterial {
  const envelope = Envelope.parse(value), key = derive(keys, envelope.keyVersion);
  try {
    const bytes = openCredentialBytes({ nonce: Buffer.from(envelope.nonce, "base64url"), ciphertext: Buffer.from(envelope.ciphertext, "base64url"),
      authTag: Buffer.from(envelope.authTag, "base64url") }, associated(binding, envelope.keyVersion), key);
    try { return CloudEnvironmentMaterialSchema.parse(JSON.parse(bytes.toString("utf8"))); } finally { bytes.fill(0); }
  } finally { key.fill(0); }
}

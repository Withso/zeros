import { hkdfSync } from "node:crypto";
import { z } from "zod";
import {
  openCredentialBytes,
  sealCredentialBytes,
  type CloudAgentCredentialEnvelope,
  type CloudAgentCredentialKeys,
} from "../agent-credentials/agent-credential-envelope.js";

const secret = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9._~+/-]+={0,2}$/);
const expiry = z.number().int().positive().max(4_102_444_800_000);
export const CloudGithubCredentialSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("pat"),
      accessToken: secret,
      expiresAt: expiry.nullable(),
    })
    .strict(),
  z
    .object({
      method: z.literal("github-app"),
      accessToken: secret,
      refreshToken: secret,
      expiresAt: expiry,
      refreshExpiresAt: expiry,
    })
    .strict(),
]);
export type CloudGithubCredential = z.infer<typeof CloudGithubCredentialSchema>;
export type CloudGithubMethod = CloudGithubCredential["method"];
export type CloudGithubCredentialBinding = {
  id: string;
  organizationId: string;
  userId: string;
  method: CloudGithubMethod;
  generation: string;
  version: number;
  keyVersion: number;
};
const purpose = "zeros-cloud-github-user-credential-v1";

function associated(binding: CloudGithubCredentialBinding): Buffer {
  if (
    ![
      binding.id,
      binding.organizationId,
      binding.userId,
      binding.generation,
    ].every((value) => z.string().uuid().safeParse(value).success) ||
    ![binding.version, binding.keyVersion].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !["github-app", "pat"].includes(binding.method)
  )
    throw new Error("Invalid GitHub credential envelope");
  return Buffer.from(
    JSON.stringify([
      purpose,
      binding.organizationId,
      binding.userId,
      binding.id,
      binding.method,
      binding.generation,
      binding.version,
      binding.keyVersion,
    ]),
  );
}
function derive(encoded: string): Buffer {
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded)
      throw new Error("Invalid GitHub credential key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally {
    root.fill(0);
  }
}
export function sealGithubCredential(
  material: CloudGithubCredential,
  binding: CloudGithubCredentialBinding,
  keys: CloudAgentCredentialKeys,
): CloudAgentCredentialEnvelope {
  const parsed = CloudGithubCredentialSchema.parse(material);
  if (parsed.method !== binding.method)
    throw new Error("Invalid GitHub credential method");
  const key = derive(keys.keys[binding.keyVersion] ?? ""),
    bytes = Buffer.from(JSON.stringify(parsed));
  try {
    return sealCredentialBytes(bytes, associated(binding), key);
  } finally {
    key.fill(0);
    bytes.fill(0);
  }
}
export function openGithubCredential(
  envelope: CloudAgentCredentialEnvelope,
  binding: CloudGithubCredentialBinding,
  keys: CloudAgentCredentialKeys,
): CloudGithubCredential {
  if (
    envelope.nonce.length !== 12 ||
    envelope.authTag.length !== 16 ||
    envelope.ciphertext.length > 16_384
  )
    throw new Error("Invalid GitHub credential envelope");
  const key = derive(keys.keys[binding.keyVersion] ?? "");
  let bytes: Buffer | undefined;
  try {
    bytes = openCredentialBytes(envelope, associated(binding), key);
    const material = CloudGithubCredentialSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (material.method !== binding.method)
      throw new Error("Invalid GitHub credential method");
    return material;
  } finally {
    key.fill(0);
    bytes?.fill(0);
  }
}

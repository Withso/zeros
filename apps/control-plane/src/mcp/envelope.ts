import { createHmac, hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";

const purpose = "zeros-organization-mcp-v1";
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(), nonce: z.string().max(32),
  ciphertext: z.string().max(1_400_000), authTag: z.string().max(32) }).strict();
export type McpEnvelope = z.infer<typeof Envelope>;
export interface McpBinding { organizationId: string; ownerUserId: string | null; id: string; revision: number; purpose: "config" | "oauth" | "attempt" }
function associated(binding: McpBinding, keyVersion: number): Buffer {
  const uuid = z.string().uuid();
  if (!uuid.safeParse(binding.organizationId).success || !uuid.safeParse(binding.id).success ||
    (binding.ownerUserId !== null && !uuid.safeParse(binding.ownerUserId).success) || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw new Error("Invalid MCP secret binding");
  return Buffer.from(JSON.stringify([purpose, binding.purpose, binding.organizationId.toLowerCase(), binding.ownerUserId?.toLowerCase() ?? null,
    binding.id.toLowerCase(), binding.revision, keyVersion]));
}
function derive(keys: CloudAgentCredentialKeys, version: number, domain = purpose): Buffer {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("MCP secret key unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Invalid MCP secret key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), domain, 32));
  } finally { root.fill(0); }
}
/** OAuth identity comparisons use server material, never a client-secret key
 * or the envelope encryption key. The persisted fingerprint stays opaque. */
export function fingerprintMcpOAuthIdentity(identity: string, keys: CloudAgentCredentialKeys): string {
  const key = derive(keys, keys.currentKeyVersion, "zeros-organization-mcp-oauth-binding-v1");
  try { return createHmac("sha256", key).update(identity).digest("hex"); }
  finally { key.fill(0); }
}
export function sealMcpMaterial(value: unknown, binding: McpBinding, keys: CloudAgentCredentialKeys): McpEnvelope {
  const version = keys.currentKeyVersion, key = derive(keys, version), bytes = Buffer.from(JSON.stringify(value));
  try {
    if (bytes.length > 1_000_000) throw new Error("MCP secret material too large");
    const envelope = sealCredentialBytes(bytes, associated(binding, version), key);
    return { version: 1, keyVersion: version, nonce: envelope.nonce.toString("base64url"), ciphertext: envelope.ciphertext.toString("base64url"), authTag: envelope.authTag.toString("base64url") };
  } finally { key.fill(0); bytes.fill(0); }
}
export function openMcpMaterial(value: unknown, binding: McpBinding, keys: CloudAgentCredentialKeys): unknown {
  const envelope = Envelope.parse(value), key = derive(keys, envelope.keyVersion);
  try {
    const bytes = openCredentialBytes({ nonce: Buffer.from(envelope.nonce, "base64url"), ciphertext: Buffer.from(envelope.ciphertext, "base64url"),
      authTag: Buffer.from(envelope.authTag, "base64url") }, associated(binding, envelope.keyVersion), key);
    try { return JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
  } finally { key.fill(0); }
}

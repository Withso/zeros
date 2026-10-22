import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { sealCredentialBytes, openCredentialBytes, type CloudAgentCredentialKeys } from "../agent-credentials/agent-credential-envelope.js";

const purpose = "zeros-cloud-v2-port-token-v1";
const Envelope = z.object({ version: z.literal(1), keyVersion: z.number().int().positive(),
  nonce: z.string().max(32), ciphertext: z.string().max(12_000), authTag: z.string().max(32) }).strict();
export type PortTokenEnvelope = z.infer<typeof Envelope>;
function key(keys: CloudAgentCredentialKeys, version: number): Buffer {
  const encoded = keys.keys[version];
  if (!encoded) throw new Error("Worker port key unavailable");
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Invalid worker port key");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
const aad = (workspaceId: string, version: number) => Buffer.from(JSON.stringify([purpose, z.string().uuid().parse(workspaceId).toLowerCase(), version]));
export function sealPortToken(token: string, workspaceId: string, keys: CloudAgentCredentialKeys): PortTokenEnvelope {
  if (!/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(token)) throw new Error("Invalid worker port token");
  const version = keys.currentKeyVersion, cipherKey = key(keys, version), bytes = Buffer.from(token);
  try {
    const envelope = sealCredentialBytes(bytes, aad(workspaceId, version), cipherKey);
    return { version: 1, keyVersion: version, nonce: envelope.nonce.toString("base64url"),
      ciphertext: envelope.ciphertext.toString("base64url"), authTag: envelope.authTag.toString("base64url") };
  } finally { cipherKey.fill(0); bytes.fill(0); }
}
export function openPortToken(value: unknown, workspaceId: string, keys: CloudAgentCredentialKeys): string {
  const envelope = Envelope.parse(value), cipherKey = key(keys, envelope.keyVersion);
  try {
    const bytes = openCredentialBytes({ nonce: Buffer.from(envelope.nonce, "base64url"), ciphertext: Buffer.from(envelope.ciphertext, "base64url"),
      authTag: Buffer.from(envelope.authTag, "base64url") }, aad(workspaceId, envelope.keyVersion), cipherKey);
    try { return bytes.toString("utf8"); } finally { bytes.fill(0); }
  } finally { cipherKey.fill(0); }
}

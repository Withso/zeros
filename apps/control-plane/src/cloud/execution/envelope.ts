import { hkdfSync } from "node:crypto";
import { z } from "zod";
import { openCredentialBytes, sealCredentialBytes, type CloudAgentCredentialKeys } from "../../agent-credentials/agent-credential-envelope.js";

const purpose = "zeros-cloud-execution-v1";
const envelopeSchema = z.object({ keyVersion: z.number().int().positive(), nonce: z.string().max(32),
  ciphertext: z.string().min(1).max(16_000_000), authTag: z.string().max(32) }).strict();
export type ExecutionEnvelopeBinding = { id: string; workspaceId: string; organizationId: string; userId: string; kind: string };
function associated(binding: ExecutionEnvelopeBinding, version: number) {
  return Buffer.from(JSON.stringify([purpose, version, binding.organizationId, binding.workspaceId, binding.userId, binding.id, binding.kind]));
}
function key(keys: CloudAgentCredentialKeys, version: number) {
  const encoded = keys.keys[version], root = Buffer.from(encoded ?? "", "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded) throw new Error("Execution envelope unavailable");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), purpose, 32));
  } finally { root.fill(0); }
}
export function sealExecution(value: unknown, binding: ExecutionEnvelopeBinding, keys: CloudAgentCredentialKeys) {
  const material = Buffer.from(JSON.stringify(value)), derived = key(keys, keys.currentKeyVersion);
  try {
    const sealed = sealCredentialBytes(material, associated(binding, keys.currentKeyVersion), derived);
    return envelopeSchema.parse({ keyVersion: keys.currentKeyVersion, nonce: sealed.nonce.toString("base64url"),
      ciphertext: sealed.ciphertext.toString("base64url"), authTag: sealed.authTag.toString("base64url") });
  } finally { material.fill(0); derived.fill(0); }
}
export function openExecution(value: unknown, binding: ExecutionEnvelopeBinding, keys: CloudAgentCredentialKeys): unknown {
  const sealed = envelopeSchema.parse(value), derived = key(keys, sealed.keyVersion);
  let material: Buffer | undefined;
  try {
    const nonce = Buffer.from(sealed.nonce, "base64url"), authTag = Buffer.from(sealed.authTag, "base64url");
    if (nonce.length !== 12 || authTag.length !== 16) throw new Error("Execution envelope unavailable");
    material = openCredentialBytes({ nonce, authTag, ciphertext: Buffer.from(sealed.ciphertext, "base64url") }, associated(binding, sealed.keyVersion), derived);
    return JSON.parse(material.toString("utf8"));
  } finally { material?.fill(0); derived.fill(0); }
}

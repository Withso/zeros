import { hkdfSync } from "node:crypto";
import {
  openCredentialBytes,
  sealCredentialBytes,
  type CloudAgentCredentialEnvelope,
  type CloudAgentCredentialKeys,
} from "../cloud-workspaces/agent-credential-envelope.js";
import { parseMaterial, type DevMaterial } from "./types.js";

export type MaterialBinding = {
  id: string;
  memberId: string;
  revision: number;
  version: number;
  keyVersion: number;
  kind: string;
  accountId: string;
  appScope: string;
};
const PURPOSE = "zeros-dev-connections-material-v1";
function key(encoded: string) {
  const root = Buffer.from(encoded, "base64url");
  try {
    if (root.length !== 32 || root.toString("base64url") !== encoded)
      throw new Error("Dev connection key unavailable");
    return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), PURPOSE, 32));
  } finally {
    root.fill(0);
  }
}
function aad(b: MaterialBinding) {
  return Buffer.from(
    JSON.stringify([
      PURPOSE,
      b.id,
      b.memberId,
      b.revision,
      b.version,
      b.keyVersion,
      b.kind,
      b.accountId,
      b.appScope,
    ]),
  );
}
export function sealMaterial(
  material: DevMaterial,
  binding: MaterialBinding,
  keys: CloudAgentCredentialKeys,
): CloudAgentCredentialEnvelope {
  const derived = key(keys.keys[binding.keyVersion] ?? ""),
    bytes = Buffer.from(JSON.stringify(parseMaterial(material)));
  try {
    return sealCredentialBytes(bytes, aad(binding), derived);
  } finally {
    derived.fill(0);
    bytes.fill(0);
  }
}
export function openMaterial(
  envelope: CloudAgentCredentialEnvelope,
  binding: MaterialBinding,
  keys: CloudAgentCredentialKeys,
): DevMaterial {
  if (
    envelope.ciphertext.length > 70000 ||
    envelope.nonce.length !== 12 ||
    envelope.authTag.length !== 16
  )
    throw new Error("Dev connection material unavailable");
  const derived = key(keys.keys[binding.keyVersion] ?? "");
  let bytes: Buffer | undefined;
  try {
    bytes = openCredentialBytes(envelope, aad(binding), derived);
    return parseMaterial(JSON.parse(bytes.toString("utf8")));
  } finally {
    derived.fill(0);
    bytes?.fill(0);
  }
}

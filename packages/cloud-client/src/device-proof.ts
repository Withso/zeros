// Device proof message (S3 "Device proof"). The signature covers these UTF-8
// lines joined with "\n"; the reference is cloudWorkspaceDeviceProofMessage in
// apps/control-plane/src/cloud-workspaces/replicas.ts.

export const DEVICE_PROOF_VERSION = "zeros-cloud-device-proof-v1";

export type DeviceProofAction = "device-session.create" | "runtime.connect" | "runtime.capabilities";

export type DeviceProofRequest = Readonly<{ action: DeviceProofAction; payload: Readonly<Record<string, unknown>> }>;

/** Object keys sorted, no whitespace; same as the control plane's canonicalJson. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Lowercase hex SHA-256 of the payload's canonical JSON (WebCrypto, so it runs in Electron main and the renderer). */
export async function deviceProofPayloadDigest(payload: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deviceProofMessage(input: Readonly<{
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  action: DeviceProofAction;
  timestampMs: number;
  nonce: string;
  payload: unknown;
}>): Promise<string> {
  return [
    DEVICE_PROOF_VERSION,
    input.accountUserId,
    input.deviceId,
    String(input.keyVersion),
    input.action,
    String(input.timestampMs),
    input.nonce,
    await deviceProofPayloadDigest(input.payload),
  ].join("\n");
}

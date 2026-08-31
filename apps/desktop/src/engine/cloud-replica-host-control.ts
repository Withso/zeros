import type { CloudReplicaDeviceProof } from "./cloud-replica-device";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^crp_[A-Za-z0-9_-]{22}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_.-]{2,127}$/;
const MAX_CONTROL_LINE_BYTES = 128 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 32 * 1024;

export type CloudReplicaHostSession = {
  version: 1;
  accountUserId: string;
  accessToken: string;
  expiresAtMs: number;
  baseUrl: string;
  allowInsecureLoopback: boolean;
  device: {
    deviceId: string | null;
    keyVersion: number;
    publicKey: string;
  };
};

export type CloudReplicaProofRequest = {
  type: "engine.cloudReplicaProofRequest";
  requestId: string;
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  action: string;
  payload: unknown;
};

export type CloudReplicaProofResponse = {
  type: "host.cloudReplicaProofResponse";
  requestId: string;
  proof: CloudReplicaDeviceProof | null;
  errorCode: "signed_out" | "identity_mismatch" | "signing_failed" | null;
};

export type CloudReplicaDeviceRegistered = {
  type: "engine.cloudReplicaDeviceRegistered";
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  publicKey: string;
  keyFingerprint: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validBearer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= 8 &&
    Buffer.byteLength(value, "utf8") <= MAX_ACCESS_TOKEN_BYTES &&
    // eslint-disable-next-line no-control-regex -- HTTP bearer contract
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

function validProof(value: unknown): value is CloudReplicaDeviceProof {
  return (
    isRecord(value) &&
    exactKeys(value, [
      "deviceId",
      "keyVersion",
      "timestampMs",
      "nonce",
      "signature",
    ]) &&
    typeof value.deviceId === "string" &&
    UUID_PATTERN.test(value.deviceId) &&
    positiveInteger(value.keyVersion) &&
    Number.isSafeInteger(value.timestampMs) &&
    Number(value.timestampMs) >= 0 &&
    typeof value.nonce === "string" &&
    NONCE_PATTERN.test(value.nonce) &&
    typeof value.signature === "string" &&
    SIGNATURE_PATTERN.test(value.signature)
  );
}

/** Serialize one private host-control message with a hard framing bound. */
export function cloudReplicaHostControlLine(value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
    throw new Error("Cloud replica host-control message is too large");
  }
  return line;
}

export function parseCloudReplicaHostSessionMessage(
  value: unknown,
): CloudReplicaHostSession | null | undefined {
  if (!isRecord(value) || value.type !== "host.cloudReplicaSession") {
    return undefined;
  }
  if (!exactKeys(value, ["type", "session"])) return undefined;
  if (value.session === null) return null;
  const session = value.session;
  if (
    !isRecord(session) ||
    !exactKeys(session, [
      "version",
      "accountUserId",
      "accessToken",
      "expiresAtMs",
      "baseUrl",
      "allowInsecureLoopback",
      "device",
    ]) ||
    session.version !== 1 ||
    typeof session.accountUserId !== "string" ||
    !UUID_PATTERN.test(session.accountUserId) ||
    !validBearer(session.accessToken) ||
    !Number.isSafeInteger(session.expiresAtMs) ||
    Number(session.expiresAtMs) < 0 ||
    typeof session.baseUrl !== "string" ||
    session.baseUrl.length < 8 ||
    session.baseUrl.length > 2_048 ||
    typeof session.allowInsecureLoopback !== "boolean" ||
    !isRecord(session.device) ||
    !exactKeys(session.device, ["deviceId", "keyVersion", "publicKey"]) ||
    (session.device.deviceId !== null &&
      (typeof session.device.deviceId !== "string" ||
        !UUID_PATTERN.test(session.device.deviceId))) ||
    !positiveInteger(session.device.keyVersion) ||
    typeof session.device.publicKey !== "string" ||
    !PUBLIC_KEY_PATTERN.test(session.device.publicKey)
  ) {
    return undefined;
  }
  return session as CloudReplicaHostSession;
}

export function parseCloudReplicaProofRequest(
  value: unknown,
): CloudReplicaProofRequest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "type",
      "requestId",
      "accountUserId",
      "deviceId",
      "keyVersion",
      "action",
      "payload",
    ]) ||
    value.type !== "engine.cloudReplicaProofRequest" ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    typeof value.accountUserId !== "string" ||
    !UUID_PATTERN.test(value.accountUserId) ||
    typeof value.deviceId !== "string" ||
    !UUID_PATTERN.test(value.deviceId) ||
    !positiveInteger(value.keyVersion) ||
    typeof value.action !== "string" ||
    !ACTION_PATTERN.test(value.action)
  ) {
    return null;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(value.payload), "utf8") > 64 * 1024) {
      return null;
    }
  } catch {
    return null;
  }
  return value as CloudReplicaProofRequest;
}

export function parseCloudReplicaProofResponse(
  value: unknown,
): CloudReplicaProofResponse | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["type", "requestId", "proof", "errorCode"]) ||
    value.type !== "host.cloudReplicaProofResponse" ||
    typeof value.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(value.requestId) ||
    !(
      value.errorCode === null ||
      value.errorCode === "signed_out" ||
      value.errorCode === "identity_mismatch" ||
      value.errorCode === "signing_failed"
    ) ||
    !(
      (value.proof === null && value.errorCode !== null) ||
      (validProof(value.proof) && value.errorCode === null)
    )
  ) {
    return null;
  }
  return value as CloudReplicaProofResponse;
}

export function parseCloudReplicaDeviceRegistered(
  value: unknown,
): CloudReplicaDeviceRegistered | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "type",
      "accountUserId",
      "deviceId",
      "keyVersion",
      "publicKey",
      "keyFingerprint",
    ]) ||
    value.type !== "engine.cloudReplicaDeviceRegistered" ||
    typeof value.accountUserId !== "string" ||
    !UUID_PATTERN.test(value.accountUserId) ||
    typeof value.deviceId !== "string" ||
    !UUID_PATTERN.test(value.deviceId) ||
    !positiveInteger(value.keyVersion) ||
    typeof value.publicKey !== "string" ||
    !PUBLIC_KEY_PATTERN.test(value.publicKey) ||
    typeof value.keyFingerprint !== "string" ||
    !SHA256_PATTERN.test(value.keyFingerprint)
  ) {
    return null;
  }
  return value as CloudReplicaDeviceRegistered;
}

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export type CloudReplicaDeviceCredential = {
  version: 1;
  accountUserId: string;
  deviceId: string | null;
  keyVersion: number;
  publicKey: string;
  privateKey: string;
};

export type CloudReplicaDeviceProof = {
  deviceId: string;
  keyVersion: number;
  timestampMs: number;
  nonce: string;
  signature: string;
};

export function cloudReplicaDeviceSecretAccount(accountUserId: string): string {
  if (!UUID_PATTERN.test(accountUserId)) throw new Error("Cloud account is invalid");
  return `cloud_replica_device:${accountUserId}`;
}

function keyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const publicJwk = pair.publicKey.export({ format: "jwk" });
  const privateJwk = pair.privateKey.export({ format: "jwk" });
  if (
    publicJwk.kty !== "OKP" ||
    publicJwk.crv !== "Ed25519" ||
    typeof publicJwk.x !== "string" ||
    privateJwk.kty !== "OKP" ||
    privateJwk.crv !== "Ed25519" ||
    privateJwk.x !== publicJwk.x ||
    typeof privateJwk.d !== "string"
  ) {
    throw new Error("Could not create a cloud device key");
  }
  return { publicKey: publicJwk.x, privateKey: privateJwk.d };
}

export function createCloudReplicaDeviceCredential(
  accountUserId: string,
): CloudReplicaDeviceCredential {
  if (!UUID_PATTERN.test(accountUserId)) throw new Error("Cloud account is invalid");
  return {
    version: 1,
    accountUserId,
    deviceId: null,
    keyVersion: 1,
    ...keyPair(),
  };
}

export function rotateCloudReplicaDeviceCredential(
  current: CloudReplicaDeviceCredential,
): CloudReplicaDeviceCredential {
  const parsed = parseCloudReplicaDeviceCredential(current);
  if (!parsed.deviceId || !Number.isSafeInteger(parsed.keyVersion + 1)) {
    throw new Error("Cloud device is not registered");
  }
  return { ...parsed, keyVersion: parsed.keyVersion + 1, ...keyPair() };
}

export function parseCloudReplicaDeviceCredential(
  value: unknown,
): CloudReplicaDeviceCredential {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "version",
      "accountUserId",
      "deviceId",
      "keyVersion",
      "publicKey",
      "privateKey",
    ]) ||
    value.version !== 1 ||
    typeof value.accountUserId !== "string" ||
    !UUID_PATTERN.test(value.accountUserId) ||
    (value.deviceId !== null &&
      (typeof value.deviceId !== "string" || !UUID_PATTERN.test(value.deviceId))) ||
    !Number.isSafeInteger(value.keyVersion) ||
    Number(value.keyVersion) < 1 ||
    typeof value.publicKey !== "string" ||
    !BASE64URL_32.test(value.publicKey) ||
    typeof value.privateKey !== "string" ||
    !BASE64URL_32.test(value.privateKey)
  ) {
    throw new Error("Cloud device credential is invalid");
  }
  const credential = value as CloudReplicaDeviceCredential;
  const privateObject = privateKeyObject(credential);
  const derived = createPublicKey(privateObject).export({ format: "jwk" });
  if (derived.x !== credential.publicKey) {
    throw new Error("Cloud device credential key pair does not match");
  }
  return { ...credential };
}

function privateKeyObject(credential: CloudReplicaDeviceCredential): KeyObject {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: credential.publicKey,
      d: credential.privateKey,
    },
    format: "jwk",
  });
}

/** Byte-for-byte twin of the coordinator verifier contract. Keep the test
 * vector in both packages so a canonicalization change cannot ship one-sided. */
export function cloudReplicaDeviceProofMessage(input: {
  accountUserId: string;
  deviceId: string;
  keyVersion: number;
  action: string;
  timestampMs: number;
  nonce: string;
  payload: unknown;
}): Buffer {
  return Buffer.from(
    [
      "zeros-cloud-device-proof-v1",
      input.accountUserId,
      input.deviceId,
      String(input.keyVersion),
      input.action,
      String(input.timestampMs),
      input.nonce,
      requestDigest(input.payload),
    ].join("\n"),
    "utf8",
  );
}

export class CloudReplicaDeviceSigner {
  private readonly key: KeyObject;
  readonly accountUserId: string;
  readonly deviceId: string;
  readonly keyVersion: number;
  readonly publicKey: string;

  constructor(value: CloudReplicaDeviceCredential) {
    const credential = parseCloudReplicaDeviceCredential(value);
    if (!credential.deviceId) throw new Error("Cloud device is not registered");
    this.accountUserId = credential.accountUserId;
    this.deviceId = credential.deviceId;
    this.keyVersion = credential.keyVersion;
    this.publicKey = credential.publicKey;
    this.key = privateKeyObject(credential);
  }

  proof(
    action: string,
    payload: unknown,
    now = Date.now(),
  ): CloudReplicaDeviceProof {
    if (
      !/^[a-z][a-z0-9_.-]{2,127}$/.test(action) ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      throw new Error("Cloud device proof input is invalid");
    }
    const nonce = randomBytes(24).toString("base64url");
    return {
      deviceId: this.deviceId,
      keyVersion: this.keyVersion,
      timestampMs: now,
      nonce,
      signature: sign(
        null,
        cloudReplicaDeviceProofMessage({
          accountUserId: this.accountUserId,
          deviceId: this.deviceId,
          keyVersion: this.keyVersion,
          action,
          timestampMs: now,
          nonce,
          payload,
        }),
        this.key,
      ).toString("base64url"),
    };
  }
}

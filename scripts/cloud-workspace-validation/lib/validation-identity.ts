import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";

const AUDIENCE = "zeros-cloud-validation";
const ISSUER = "https://validation.zeros.invalid";
const CLIENT_ID = "client_zsr_cloud_qualification";
const EMAIL = "zsr-cloud-qualification@zeros.invalid";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export interface CloudValidationIdentity {
  readonly ownerSubject: string;
  readonly accessToken: string;
  readonly publicKey: string;
  readonly keyId: string;
  readonly audience: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly expiresAt: number;
}

/** Mint a run-local qualification identity. The private KeyObject exists only
 * for this synchronous call and is never returned, serialized, written, or
 * projected into the worker. The claims intentionally satisfy the exact
 * `zeros-access-v1` profile used for WorkOS access tokens, while the invalid
 * issuer and dedicated client id ensure this credential cannot be confused
 * with a hosted environment token. */
export function createCloudValidationIdentity(options: {
  ownerSubject: string;
  nowMs?: number;
  ttlSeconds: number;
}): CloudValidationIdentity {
  const nowMs = options.nowMs ?? Date.now();
  if (
    !/^[A-Za-z0-9:_-]{1,128}$/.test(options.ownerSubject) ||
    !Number.isFinite(nowMs) ||
    nowMs <= 0 ||
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds < 300 ||
    options.ttlSeconds > 24 * 60 * 60
  ) {
    throw new Error("cloud validation identity options are invalid");
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha256").update(publicKeyDer).digest("base64url");
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + options.ttlSeconds;
  const header = base64urlJson({ alg: "RS256", typ: "JWT", kid: keyId });
  const payload = base64urlJson({
    sub: options.ownerSubject,
    sid: `zsr_session_${randomUUID()}`,
    jti: `zsr_token_${randomUUID()}`,
    client_id: CLIENT_ID,
    "https://zeros.build/email": EMAIL,
    "https://zeros.build/email_verified": true,
    aud: AUDIENCE,
    iss: ISSUER,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    privateKey,
  ).toString("base64url");
  return {
    ownerSubject: options.ownerSubject,
    accessToken: `${signingInput}.${signature}`,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    keyId,
    audience: AUDIENCE,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    expiresAt: expiresAt * 1000,
  };
}

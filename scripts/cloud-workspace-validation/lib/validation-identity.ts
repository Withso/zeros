import { generateKeyPairSync, sign } from "node:crypto";

const AUDIENCE = "zeros-cloud-validation";
const ISSUER = "https://validation.zeros.invalid";

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export interface CloudValidationIdentity {
  readonly ownerSubject: string;
  readonly accessToken: string;
  readonly publicKey: string;
  readonly audience: string;
  readonly issuer: string;
  readonly expiresAt: number;
}

/** Mint a run-local qualification identity. The private KeyObject exists only
 * for this synchronous call and is never returned, serialized, written, or
 * projected into the worker. This proves asymmetric engine binding without
 * pretending to be the production control-plane tenant grant. */
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
  const issuedAt = nowMs / 1000;
  const expiresAt = issuedAt + options.ttlSeconds;
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    sub: options.ownerSubject,
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
    audience: AUDIENCE,
    issuer: ISSUER,
    expiresAt: expiresAt * 1000,
  };
}

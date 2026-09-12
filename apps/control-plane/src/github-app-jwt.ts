import { createPrivateKey, sign } from "node:crypto";

import { HttpError } from "./authz.js";
import type { GithubBackendConfig } from "./config.js";

function unavailable(): HttpError {
  return new HttpError(
    503,
    "github_cloud_not_configured",
    "Cloud GitHub access is not configured on this Zeros control plane.",
  );
}

/** GitHub requires RS256, an iat backdated for clock drift, and an exp no more
 * than ten minutes ahead. Kept dependency-light so production qualification can
 * reuse the credential broker without loading the HTTP application boundary. */
export function createGithubAppJwt(
  config: GithubBackendConfig,
  nowMs: number = Date.now(),
): string {
  if (!config.privateKey || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    throw unavailable();
  }
  let key;
  try {
    key = createPrivateKey(config.privateKey);
  } catch {
    throw unavailable();
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw unavailable();
  }
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const nowSeconds = Math.floor(nowMs / 1_000);
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 9 * 60,
      iss: config.clientId,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), key).toString(
    "base64url",
  );
  return `${unsigned}.${signature}`;
}

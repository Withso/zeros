import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  AuthTokenContractError,
  authTokenVerifyOptions,
  validateAuthTokenClaims,
  type AuthClientKind,
  type AuthTokenContractConfig,
} from "./auth-token-contract.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new AuthTokenContractError("AUTH_PROBE_CONFIG_MISSING", name);
  return value;
}

function expectedClientKind(): AuthClientKind {
  const value = requiredEnv("AUTH_PROBE_CLIENT_KIND");
  if (value === "web" || value === "desktop") return value;
  throw new AuthTokenContractError(
    "AUTH_PROBE_CONFIG_INVALID",
    "AUTH_PROBE_CLIENT_KIND",
  );
}

function safeFailureCode(error: unknown): string {
  if (error instanceof AuthTokenContractError) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "AUTH_PROBE_FAILED";
}

async function main(): Promise<void> {
  const token = requiredEnv("AUTH_PROBE_ACCESS_TOKEN");
  delete process.env.AUTH_PROBE_ACCESS_TOKEN;

  const config: AuthTokenContractConfig = {
    issuer: requiredEnv("AUTH_ISSUER"),
    audience: requiredEnv("AUTH_AUDIENCE"),
    webClientId: requiredEnv("AUTH_WEB_CLIENT_ID"),
    desktopClientId: requiredEnv("AUTH_DESKTOP_CLIENT_ID"),
  };
  const expectedKind = expectedClientKind();
  const jwksUrl = new URL(requiredEnv("AUTH_JWKS_URL"));
  if (jwksUrl.protocol !== "https:") {
    throw new AuthTokenContractError(
      "AUTH_PROBE_CONFIG_INVALID",
      "AUTH_JWKS_URL",
    );
  }

  const jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000 });
  const { payload, protectedHeader } = await jwtVerify(
    token,
    jwks,
    authTokenVerifyOptions(config),
  );
  const claims = validateAuthTokenClaims(payload, config);
  if (claims.clientKind !== expectedKind) {
    throw new AuthTokenContractError(
      "AUTH_PROBE_CLIENT_KIND_MISMATCH",
      "client kind mismatch",
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  console.log(
    JSON.stringify(
      {
        ok: true,
        algorithm: protectedHeader.alg,
        clientKind: claims.clientKind,
        sessionClaimPresent: true,
        tokenIdPresent: true,
        verifiedEmailClaimPresent: true,
        profileNamePresent: claims.displayName !== null,
        profilePicturePresent: claims.avatarUrl !== null,
        expiresInSeconds: Math.max(0, claims.expiresAt - now),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(`[auth-contract] ${safeFailureCode(error)}`);
  process.exitCode = 1;
});

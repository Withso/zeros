import type { DesktopAuthConfig } from "./workos-desktop-config";

export const ZEROS_ACCESS_TOKEN_CONTRACT = "zeros-access-v1";

/**
 * Translate the selected desktop provider into the provider-neutral engine
 * verifier environment. WorkOS values come from the same already-validated
 * desktop configuration used for code exchange and refresh, so the renderer
 * and engine cannot silently disagree about issuer, audience, or client.
 */
export function resolveDesktopEngineAuthEnv(
  auth: DesktopAuthConfig,
  env: NodeJS.ProcessEnv,
  isDev: boolean,
): Record<string, string> {
  const requireAccount =
    env.ZEROS_REQUIRE_ACCOUNT?.trim() || (isDev ? "0" : "1");

  if (auth.provider === "workos") {
    return {
      // Do not let an ambient legacy symmetric/static key enter the WorkOS
      // verifier. The configured HTTPS JWKS is the sole signing-key source.
      ZEROS_ACCOUNT_JWT_SECRET: "",
      ZEROS_ACCOUNT_JWT_PUBLIC_KEY: "",
      ZEROS_ACCOUNT_JWT_ISSUER: "",
      ZEROS_ACCOUNT_JWT_JWKS_URL: auth.jwksUrl,
      ZEROS_ACCOUNT_JWT_ISS: auth.issuer,
      ZEROS_ACCOUNT_JWT_AUD: auth.audience,
      ZEROS_ACCOUNT_JWT_CONTRACT: ZEROS_ACCESS_TOKEN_CONTRACT,
      ZEROS_ACCOUNT_JWT_CLIENT_ID: auth.desktopClientId,
      ZEROS_REQUIRE_ACCOUNT: requireAccount,
    };
  }

  const auth0Domain = env.AUTH0_DOMAIN?.trim() || "";
  const jwksUrl =
    env.ZEROS_ACCOUNT_JWT_JWKS_URL?.trim() ||
    (auth0Domain ? `https://${auth0Domain}/.well-known/jwks.json` : "");
  const issuer =
    env.ZEROS_ACCOUNT_JWT_ISS?.trim() ||
    (isDev || !auth0Domain ? "" : `https://${auth0Domain}/`);
  const audience =
    env.ZEROS_ACCOUNT_JWT_AUD?.trim() || env.AUTH_AUDIENCE?.trim() || "";

  return {
    ZEROS_ACCOUNT_JWT_JWKS_URL: jwksUrl,
    ZEROS_ACCOUNT_JWT_ISS: issuer,
    ZEROS_ACCOUNT_JWT_AUD: audience,
    // Clear a possibly inherited WorkOS-only profile during an Auth0 rollback.
    ZEROS_ACCOUNT_JWT_CONTRACT: "",
    ZEROS_ACCOUNT_JWT_CLIENT_ID: "",
    ZEROS_REQUIRE_ACCOUNT: requireAccount,
  };
}

/** A desktop/engine process never needs a WorkOS management credential. */
export function stripWorkOSApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...env };
  for (const name of Object.keys(output)) {
    if (/^WORKOS(?:_[A-Z0-9]+)*_API_KEY$/i.test(name)) delete output[name];
  }
  return output;
}

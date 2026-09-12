import type { DesktopAuthConfig } from "./workos-desktop-config";

const ALPHA_APP_ORIGIN = "https://app-alpha.zeros.build";
const ALPHA_API_ORIGIN = "https://api-alpha.zeros.build";
const WORKOS_API_ORIGIN = "https://api.workos.com";
const WORKOS_CLIENT_ID = /^client_[A-Za-z0-9_-]{1,240}$/;

export type DevWorkOSConfigurationIssue =
  | "provider"
  | "app_origin"
  | "control_plane_origin"
  | "audience"
  | "token_contract";

interface DevWorkOSConfiguration {
  auth: DesktopAuthConfig;
  appOrigin: string;
  controlPlaneOrigin: string;
}

function exactWorkOSClientPath(url: string, prefix: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== WORKOS_API_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.pathname.startsWith(prefix)
  ) {
    return null;
  }
  const clientId = parsed.pathname.slice(prefix.length);
  return WORKOS_CLIENT_ID.test(clientId) ? clientId : null;
}

/**
 * Local source builds may authenticate only against Alpha. The WorkOS desktop
 * client id is public, but the issuer/JWKS pair still has to identify the same
 * Alpha Web Application and the token audience/control-plane/app origins must
 * remain atomic. This prevents an ambient shell variable from silently aiming
 * a Dev build at Production or reviving the retired Auth0 handoff.
 */
export function devWorkOSConfigurationIssue({
  auth,
  appOrigin,
  controlPlaneOrigin,
}: DevWorkOSConfiguration): DevWorkOSConfigurationIssue | null {
  if (auth.provider !== "workos") return "provider";
  if (appOrigin !== ALPHA_APP_ORIGIN) return "app_origin";
  if (controlPlaneOrigin !== ALPHA_API_ORIGIN) {
    return "control_plane_origin";
  }
  if (auth.audience !== ALPHA_API_ORIGIN) return "audience";

  const issuerClient = exactWorkOSClientPath(auth.issuer, "/user_management/");
  const jwksClient = exactWorkOSClientPath(auth.jwksUrl, "/sso/jwks/");
  if (
    !WORKOS_CLIENT_ID.test(auth.desktopClientId) ||
    !issuerClient ||
    issuerClient !== jwksClient ||
    auth.desktopClientId === issuerClient
  ) {
    return "token_contract";
  }
  return null;
}

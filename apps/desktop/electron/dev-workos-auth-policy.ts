import type { DesktopAuthConfig } from "./workos-desktop-config";

const ALPHA_APP_ORIGIN = "https://app-alpha.zeros.build";
const ALPHA_API_ORIGIN = "https://api-alpha.zeros.build";
const WORKOS_API_ORIGIN = "https://api.workos.com";
const WORKOS_CLIENT_ID = /^client_[A-Za-z0-9_-]{1,240}$/;

/** Hosted and local backends use the same isolated desktop/auth contract.
 * An explicitly selected workspace mode with a missing profile stays invalid. */
export function workspaceDevAuthProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ZEROS_DEV_ENVIRONMENT === "local" || env.ZEROS_DEV_ENVIRONMENT === "hosted"
    ? env.ZEROS_DEV_AUTH_PROFILE ?? "" : undefined;
}

export type DevWorkOSConfigurationIssue =
  | "provider"
  | "app_origin"
  | "control_plane_origin"
  | "audience"
  | "token_contract"
  | "local_profile";

interface DevWorkOSConfiguration {
  auth: DesktopAuthConfig;
  appOrigin: string;
  controlPlaneOrigin: string;
  /** Public-only profile installed by the workspace Dev launcher. */
  localProfile?: string | undefined;
  isolated?: boolean | undefined;
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
 * Source builds default to the Alpha contract. The workspace Dev launcher
 * may supply a separate, isolated workspace contract. The WorkOS desktop
 * client id is public, but the issuer/JWKS pair still has to identify the same
 * Alpha Web Application and the token audience/control-plane/app origins must
 * remain atomic. This prevents an ambient shell variable from silently aiming
 * a Dev build at Production or reviving the retired Auth0 handoff.
 */
export function devWorkOSConfigurationIssue({
  auth,
  appOrigin,
  controlPlaneOrigin,
  localProfile,
  isolated,
}: DevWorkOSConfiguration): DevWorkOSConfigurationIssue | null {
  if (auth.provider !== "workos") return "provider";
  if (localProfile !== undefined) {
    if (!isolated || localProfile.length > 8192) return "local_profile";
    let profile: Record<string, unknown>;
    try { profile = JSON.parse(localProfile) as Record<string, unknown>; }
    catch { return "local_profile"; }
    if (!profile || profile.version !== 1 || typeof profile.owner !== "string" || !/^[a-f0-9]{24}$/.test(profile.owner) ||
        typeof profile.domain !== "string" || profile.domain.length > 180 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(profile.domain) ||
        profile.appOrigin !== `https://app-dev-${profile.owner}.${profile.domain}` ||
        profile.apiOrigin !== `https://api-dev-${profile.owner}.${profile.domain}` ||
        ![undefined, "dev", "alpha"].includes(profile.authEnvironment as string | undefined) ||
        profile.audience !== (profile.authEnvironment === "alpha" ? ALPHA_API_ORIGIN : `https://api-dev.${profile.domain}`) ||
        typeof profile.webClientId !== "string" || !WORKOS_CLIENT_ID.test(profile.webClientId) ||
        typeof profile.desktopClientId !== "string" || !WORKOS_CLIENT_ID.test(profile.desktopClientId) ||
        profile.desktopClientId === profile.webClientId ||
        profile.issuer !== `${WORKOS_API_ORIGIN}/user_management/${profile.webClientId}` ||
        profile.jwksUrl !== `${WORKOS_API_ORIGIN}/sso/jwks/${profile.webClientId}`) return "local_profile";
    if (appOrigin !== profile.appOrigin) return "app_origin";
    if (controlPlaneOrigin !== profile.apiOrigin) return "control_plane_origin";
    if (auth.audience !== profile.audience) return "audience";
    if (auth.desktopClientId !== profile.desktopClientId || auth.issuer !== profile.issuer || auth.jwksUrl !== profile.jwksUrl) return "token_contract";
    return null;
  }
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

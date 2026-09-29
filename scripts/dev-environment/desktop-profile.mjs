/** Public contract only. Secret-bearing integration profiles must never be
 * spread into the Electron/compiler/terminal environment. Electron repeats
 * this validation at its browser-auth boundary. */
export function workspaceDesktopAuth(env) {
  let p;
  try { if (env.ZEROS_DEV_AUTH_PROFILE.length > 8192) throw new Error(); p = JSON.parse(env.ZEROS_DEV_AUTH_PROFILE); }
  catch { throw new Error("Invalid workspace Dev public auth profile"); }
  if (!["local", "hosted"].includes(env.ZEROS_DEV_ENVIRONMENT) || env.ZEROS_ISOLATE !== "1" || p?.version !== 1 ||
      !/^[a-f0-9]{24}$/.test(p.owner ?? "") || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(p.domain ?? "") || p.domain.length > 180 ||
      !["dev", "alpha"].includes(p.authEnvironment) || !/^client_[A-Za-z0-9_-]+$/.test(p.webClientId ?? "") ||
      !/^client_[A-Za-z0-9_-]+$/.test(p.desktopClientId ?? "") || p.webClientId === p.desktopClientId ||
      p.appOrigin !== `https://app-dev-${p.owner}.${p.domain}` || p.apiOrigin !== `https://api-dev-${p.owner}.${p.domain}` ||
      p.audience !== (p.authEnvironment === "alpha" ? "https://api-alpha.zeros.build" : `https://api-dev.${p.domain}`) ||
      p.issuer !== `https://api.workos.com/user_management/${p.webClientId}` || p.jwksUrl !== `https://api.workos.com/sso/jwks/${p.webClientId}`) throw new Error("Invalid workspace Dev public auth profile");
  const values = { AUTH_PROVIDER: "workos", AUTH_DESKTOP_CLIENT_ID: p.desktopClientId, AUTH_ISSUER: p.issuer, AUTH_JWKS_URL: p.jwksUrl,
    AUTH_AUDIENCE: p.audience, VITE_APP_BASE_URL: p.appOrigin, VITE_CONTROL_PLANE_URL: p.apiOrigin };
  if (Object.entries(values).some(([key, value]) => env[key] !== value) || env.ZEROS_CONTROL_PLANE_URL !== p.apiOrigin) throw new Error("Dev desktop configuration differs from its workspace backend");
  return { env: values, source: "workspace", sharedProfilePath: "the isolated workspace launcher", issue: null };
}

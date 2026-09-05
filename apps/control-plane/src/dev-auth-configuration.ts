import { Hono } from "hono";

import type { Config } from "./config.js";

/** Anonymous public-client discovery for local Dev. This response is an
 * explicit projection: no server configuration or credential is spread into it. */
export function createDevAuthConfigurationRoutes(config: Config): Hono {
  const app = new Hono();
  if (config.deploymentChannel !== "alpha") return app;

  app.get("/auth/desktop/dev-config", (c) => {
    c.header("cache-control", "no-store");
    const auth = config.auth;
    const appOrigin = "https://app-alpha.zeros.build";
    const apiOrigin = "https://api-alpha.zeros.build";
    const clientId = /^client_[A-Za-z0-9_-]{1,240}$/;
    if (
      auth.provider !== "workos" ||
      config.workos?.appOrigin !== appOrigin ||
      auth.audience !== apiOrigin ||
      !clientId.test(auth.desktopClientId) ||
      !clientId.test(auth.webClientId) ||
      auth.desktopClientId === auth.webClientId ||
      auth.issuer !==
        `https://api.workos.com/user_management/${auth.webClientId}` ||
      auth.jwksUrl !== `https://api.workos.com/sso/jwks/${auth.webClientId}`
    ) {
      return c.json({ error: "dev_auth_unavailable" }, 503);
    }
    return c.json({
      version: 1,
      environment: "alpha",
      env: {
        AUTH_PROVIDER: "workos",
        AUTH_DESKTOP_CLIENT_ID: auth.desktopClientId,
        AUTH_ISSUER: auth.issuer,
        AUTH_JWKS_URL: auth.jwksUrl,
        AUTH_AUDIENCE: auth.audience,
        VITE_APP_BASE_URL: appOrigin,
        VITE_CONTROL_PLANE_URL: apiOrigin,
      },
    });
  });
  return app;
}

import type { AuthBackendConfig } from "./config.js";

// Synthetic WorkOS settings that let a test load a complete configuration.
// No value is a live credential and no test sends one to WorkOS.
export function workosTestEnv(): Record<string, string> {
  return {
    APP_ORIGIN: "https://app.example.test",
    AUTH_ISSUER: "https://identity.example.test/user_management/client_web",
    AUTH_JWKS_URL: "https://identity.example.test/sso/jwks/client_web",
    AUTH_WEB_CLIENT_ID: "client_web",
    AUTH_DESKTOP_CLIENT_ID: "client_desktop",
    WORKOS_API_KEY: "not-a-live-key-for-tests",
    WORKOS_COOKIE_PASSWORD: "not-a-live-cookie-password-for-tests",
    WORKOS_WEBHOOK_SECRET: "not-a-live-webhook-secret",
  };
}

/** The resource-server contract matching workosTestEnv(). */
export function workosTestAuth(
  audience = "https://api.example.test",
): AuthBackendConfig {
  return {
    provider: "workos",
    issuer: "https://identity.example.test/user_management/client_web",
    jwksUrl: "https://identity.example.test/sso/jwks/client_web",
    audience,
    webClientId: "client_web",
    desktopClientId: "client_desktop",
  };
}

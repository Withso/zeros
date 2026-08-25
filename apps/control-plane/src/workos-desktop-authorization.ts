import { Hono } from "hono";

import type { WorkOSDesktopAuthorizationProvider } from "./workos-provider.js";

const WORKOS_PROVIDERS = new Map([
  ["google", "GoogleOAuth"],
  ["github", "GitHubOAuth"],
]);
const DESKTOP_SCHEMES = new Set([
  "zeros",
  "zeros-alpha",
  "zeros-beta",
  "zeros-dev",
]);
const TOKEN_PART = /^[A-Za-z0-9_-]{43}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function validDesktopState(state: string): boolean {
  if (state.length > 256) return false;
  const separator = state.indexOf(".");
  if (separator < 1 || state.indexOf(".", separator + 1) !== -1) return false;
  return (
    DESKTOP_SCHEMES.has(state.slice(0, separator)) &&
    TOKEN_PART.test(state.slice(separator + 1))
  );
}

function invalidRequest(): Response {
  return new Response("Invalid desktop sign-in request", {
    status: 400,
    headers: { "cache-control": "no-store" },
  });
}

export function createWorkOSDesktopAuthorizationRoutes(
  provider: WorkOSDesktopAuthorizationProvider,
  appOrigin: string,
): Hono {
  const app = new Hono();
  app.get("/auth/desktop/start", (c) => {
    const url = new URL(c.req.url);
    const workosProvider = WORKOS_PROVIDERS.get(
      url.searchParams.get("provider") ?? "",
    );
    const state = url.searchParams.get("state") ?? "";
    const codeChallenge = url.searchParams.get("code_challenge") ?? "";
    if (
      !workosProvider ||
      !validDesktopState(state) ||
      !PKCE_CHALLENGE.test(codeChallenge)
    ) {
      return invalidRequest();
    }
    try {
      const authorizationUrl = provider.desktopAuthorizationUrl({
        provider: workosProvider,
        state,
        codeChallenge,
        redirectUri: `${appOrigin}/auth/desktop/callback`,
      });
      const target = new URL(authorizationUrl);
      if (target.protocol !== "https:" || target.username || target.password) {
        return invalidRequest();
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: target.toString(),
          "cache-control": "no-store",
          pragma: "no-cache",
          "referrer-policy": "no-referrer",
        },
      });
    } catch {
      return new Response("The sign-in service is temporarily unavailable", {
        status: 503,
        headers: { "cache-control": "no-store" },
      });
    }
  });
  return app;
}

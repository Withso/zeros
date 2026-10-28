import { createEmulator } from "@workos/emulate";
import { WorkOS } from "@workos-inc/node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { RailwayWorkOSProvider } from "./workos-provider.js";
import { authTokenVerifyOptions, validateAuthTokenClaims } from "./auth-token-contract.js";

const WEB_CLIENT_ID = "client_web_emulator";
const DESKTOP_CLIENT_ID = "client_desktop_emulator";
const AUDIENCE = "https://api-alpha.zeros.build";
const REDIRECT_URI = "http://127.0.0.1/auth/callback";
const COOKIE_PASSWORD = "cookie-password-for-emulator-tests".repeat(2);

describe("WorkOS Hosted AuthKit SDK integration", () => {
  it("qualifies browser and public Desktop PKCE, signed claims, refresh and isolated revocation", async () => {
    const emulator = await createEmulator({
      port: 0,
      seed: {
        users: [
          {
            id: "user_emulator_alpha",
            email: "alpha@example.test",
            name: "Alpha Tester",
            email_verified: true,
          },
        ],
        jwtTemplate: {
          content: `{"aud":"${AUDIENCE}","https://zeros.build/email":"{{ user.email }}","https://zeros.build/email_verified":{{ user.email_verified }}}`,
        },
      },
    });

    try {
      const emulatorUrl = new URL(emulator.url);
      const workos = new WorkOS({
        apiKey: emulator.apiKey,
        clientId: WEB_CLIENT_ID,
        apiHostname: emulatorUrl.hostname,
        port: emulator.port,
        https: false,
        maxRetries: 0,
      });
      const auth = {
        provider: "workos" as const,
        issuer: emulator.url,
        jwksUrl: `${emulator.url}/sso/jwks/${DESKTOP_CLIENT_ID}`,
        audience: AUDIENCE,
        webClientId: WEB_CLIENT_ID,
        desktopClientId: DESKTOP_CLIENT_ID,
      };
      const jwks = createRemoteJWKSet(new URL(auth.jwksUrl));
      const claims = async (token: string) => validateAuthTokenClaims(
        (await jwtVerify(token, jwks, authTokenVerifyOptions(auth))).payload, auth,
      );
      const provider = new RailwayWorkOSProvider(
        auth,
        {
          appOrigin: "https://app-alpha.zeros.build",
          apiKey: emulator.apiKey,
          cookiePassword: COOKIE_PASSWORD,
          webhookSecret: "webhook-secret-for-emulator-tests",
        },
        workos,
      );

      const { codeVerifier, codeChallenge } = await workos.pkce.generate();
      const state = "s".repeat(43);
      const authorizationUrl = provider.authorizationUrl({
        state,
        codeChallenge,
        redirectUri: REDIRECT_URI,
      });

      const authorizationResponse = await fetch(authorizationUrl, {
        redirect: "manual",
      });
      expect(authorizationResponse.status).toBe(302);

      const callback = new URL(
        authorizationResponse.headers.get("location") ?? "",
      );
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get("state")).toBe(state);

      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();
      const exchange = await provider.exchange({
        code: code!,
        codeVerifier,
        redirectUri: REDIRECT_URI,
      });

      expect(exchange.sealedSession).toBeTruthy();
      expect(exchange.sessionId).toMatch(/^session_/);
      expect(exchange.accessTokenExpiresAt).toBeGreaterThan(Date.now());
      expect(exchange.user).toEqual({
        id: "user_emulator_alpha",
        email: "alpha@example.test",
        emailVerified: true,
        name: "Alpha Tester",
      });
      const browserClaims = await claims(exchange.accessToken);
      expect(browserClaims).toMatchObject({
        providerSubject: "user_emulator_alpha",
        clientId: WEB_CLIENT_ID,
        clientKind: "web",
        sessionId: exchange.sessionId,
        email: "alpha@example.test",
        emailVerified: true,
      });
      // The real verifier must refuse a valid Browser token at a Desktop boundary.
      await expect(provider.verifyDesktopBearer(exchange.accessToken)).rejects.toThrow("Desktop access-token contract rejected");

      const desktopPair = await workos.pkce.generate();
      const desktopState = `zeros-alpha.${"d".repeat(43)}`;
      const desktopRedirect = "http://127.0.0.1/auth/desktop/callback";
      const desktopAuthorization = await fetch(provider.desktopAuthorizationUrl({
        state: desktopState, codeChallenge: desktopPair.codeChallenge, redirectUri: desktopRedirect,
      }), { redirect: "manual" });
      expect(desktopAuthorization.status).toBe(302);
      const desktopCallback = new URL(desktopAuthorization.headers.get("location")!);
      expect(desktopCallback.origin + desktopCallback.pathname).toBe(desktopRedirect);
      expect(desktopCallback.searchParams.get("state")).toBe(desktopState);

      // Public-client exchange and refresh carry no API key or client secret.
      const authenticateDesktop = (body: Record<string, string>) => fetch(`${emulator.url}/user_management/authenticate`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: DESKTOP_CLIENT_ID, ...body }),
      });
      const desktopResponse = await authenticateDesktop({ grant_type: "authorization_code",
        code: desktopCallback.searchParams.get("code")!, code_verifier: desktopPair.codeVerifier });
      expect(desktopResponse.status).toBe(200);
      const desktop = await desktopResponse.json() as { access_token: string; refresh_token: string };
      const desktopClaims = await claims(desktop.access_token);
      expect(desktopClaims).toMatchObject({ providerSubject: browserClaims.providerSubject, clientId: DESKTOP_CLIENT_ID, clientKind: "desktop" });
      expect(desktopClaims.sessionId).not.toBe(browserClaims.sessionId);
      await expect(provider.verifyDesktopBearer(desktop.access_token)).resolves.toEqual({
        subject: browserClaims.providerSubject, sessionId: desktopClaims.sessionId,
      });
      const refreshedResponse = await authenticateDesktop({ grant_type: "refresh_token", refresh_token: desktop.refresh_token });
      expect(refreshedResponse.status).toBe(200);
      const refreshed = await refreshedResponse.json() as { access_token: string; refresh_token: string };
      const refreshedClaims = await claims(refreshed.access_token);
      expect(refreshedClaims).toMatchObject({ sessionId: desktopClaims.sessionId, clientKind: "desktop" });
      expect(refreshedClaims.tokenId).not.toBe(desktopClaims.tokenId);

      await provider.revokeSession(desktopClaims.sessionId);
      const revoked = await authenticateDesktop({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token });
      expect(revoked.status).toBe(400);
      await expect(revoked.json()).resolves.toMatchObject({ error: "invalid_grant" });
      const browserRefresh = await provider.refresh(exchange.sealedSession);
      expect(browserRefresh.status).toBe("active");
      if (browserRefresh.status !== "active") throw new Error("Browser session was revoked with Desktop");
      await expect(claims(browserRefresh.accessToken)).resolves.toMatchObject({ sessionId: browserClaims.sessionId, clientKind: "web" });

      const secondPair = await workos.pkce.generate();
      const secondAuthorization = await fetch(
        provider.authorizationUrl({
          state: "t".repeat(43),
          codeChallenge: secondPair.codeChallenge,
          redirectUri: REDIRECT_URI,
        }),
        { redirect: "manual" },
      );
      const secondCallback = new URL(
        secondAuthorization.headers.get("location") ?? "",
      );
      await expect(
        provider.exchange({
          code: secondCallback.searchParams.get("code") ?? "",
          codeVerifier: codeVerifier,
          redirectUri: REDIRECT_URI,
        }),
      ).rejects.toThrow();
    } finally {
      await emulator.close();
    }
  });
});

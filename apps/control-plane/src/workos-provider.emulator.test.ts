import { createEmulator } from "@workos/emulate";
import { WorkOS } from "@workos-inc/node";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";

import { RailwayWorkOSProvider } from "./workos-provider.js";

const WEB_CLIENT_ID = "client_web_emulator";
const DESKTOP_CLIENT_ID = "client_desktop_emulator";
const AUDIENCE = "https://api-alpha.zeros.build";
const REDIRECT_URI = "http://127.0.0.1/auth/callback";
const COOKIE_PASSWORD = "cookie-password-for-emulator-tests".repeat(2);

describe("WorkOS Hosted AuthKit SDK integration", () => {
  it("completes Hosted AuthKit PKCE and produces a verified sealed session", async () => {
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
      const provider = new RailwayWorkOSProvider(
        {
          provider: "workos",
          issuer: emulator.url,
          jwksUrl: `${emulator.url}/sso/jwks/${DESKTOP_CLIENT_ID}`,
          audience: AUDIENCE,
          webClientId: WEB_CLIENT_ID,
          desktopClientId: DESKTOP_CLIENT_ID,
        },
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
      expect(decodeJwt(exchange.accessToken)).toMatchObject({
        sub: "user_emulator_alpha",
        client_id: WEB_CLIENT_ID,
        aud: AUDIENCE,
        "https://zeros.build/email": "alpha@example.test",
        "https://zeros.build/email_verified": true,
      });

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

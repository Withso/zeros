import { describe, expect, it } from "vitest";
import { generateKeyPair, jwtVerify, SignJWT, type JWTPayload } from "jose";
import {
  AUTH_CLAIM_NAMESPACE,
  AuthTokenContractError,
  authTokenVerifyOptions,
  validateAuthTokenClaims,
  type AuthTokenContractConfig,
} from "./auth-token-contract.js";

const config: AuthTokenContractConfig = {
  issuer: "https://api.workos.com/user_management/client_web",
  audience: "https://api-alpha.zeros.build",
  webClientId: "client_web",
  desktopClientId: "client_desktop",
};

function payload(overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: "user_example",
    sid: "session_example",
    jti: "token_example",
    client_id: "client_web",
    iat: 1_700_000_000,
    exp: 1_700_000_300,
    [`${AUTH_CLAIM_NAMESPACE}email`]: "user@example.com",
    [`${AUTH_CLAIM_NAMESPACE}email_verified`]: true,
    [`${AUTH_CLAIM_NAMESPACE}name`]: "Example User",
    [`${AUTH_CLAIM_NAMESPACE}picture`]: null,
    ...overrides,
  };
}

describe("auth token contract", () => {
  it("pins issuer, audience, algorithm, and required registered claims", () => {
    expect(authTokenVerifyOptions(config)).toEqual({
      issuer: "https://api.workos.com/user_management/client_web",
      audience: "https://api-alpha.zeros.build",
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "sid", "jti", "client_id"],
    });
  });

  it("classifies an allowed web application token", () => {
    expect(validateAuthTokenClaims(payload(), config)).toEqual({
      providerSubject: "user_example",
      sessionId: "session_example",
      tokenId: "token_example",
      clientId: "client_web",
      clientKind: "web",
      email: "user@example.com",
      emailVerified: true,
      displayName: "Example User",
      avatarUrl: null,
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_300,
    });
  });

  it("classifies an allowed desktop application token", () => {
    expect(
      validateAuthTokenClaims(payload({ client_id: "client_desktop" }), config)
        .clientKind,
    ).toBe("desktop");
  });

  it("normalizes an empty rendered WorkOS display name to absent", () => {
    expect(
      validateAuthTokenClaims(
        payload({ [`${AUTH_CLAIM_NAMESPACE}name`]: "  " }),
        config,
      ).displayName,
    ).toBeNull();
  });

  it("normalizes profile strings and discards an unsafe avatar URL", () => {
    expect(
      validateAuthTokenClaims(
        payload({
          [`${AUTH_CLAIM_NAMESPACE}email`]: "  user@example.com  ",
          [`${AUTH_CLAIM_NAMESPACE}picture`]: "javascript:alert(1)",
        }),
        config,
      ),
    ).toMatchObject({
      email: "user@example.com",
      avatarUrl: null,
    });

    expect(
      validateAuthTokenClaims(
        payload({
          [`${AUTH_CLAIM_NAMESPACE}picture`]:
            "https://images.example.com/avatar.png",
        }),
        config,
      ).avatarUrl,
    ).toBe("https://images.example.com/avatar.png");
  });

  it("rejects a token from any other application", () => {
    expect(() =>
      validateAuthTokenClaims(payload({ client_id: "client_other" }), config),
    ).toThrowError(
      expect.objectContaining<AuthTokenContractError>({
        code: "AUTH_CLIENT_ID_REJECTED",
      }),
    );
  });

  it("rejects a missing or false verified-email assertion", () => {
    expect(() =>
      validateAuthTokenClaims(
        payload({ [`${AUTH_CLAIM_NAMESPACE}email_verified`]: false }),
        config,
      ),
    ).toThrowError(
      expect.objectContaining<AuthTokenContractError>({
        code: "AUTH_EMAIL_UNVERIFIED",
      }),
    );
  });

  it("rejects inverted token timestamps", () => {
    expect(() =>
      validateAuthTokenClaims(payload({ exp: 1_699_999_999 }), config),
    ).toThrowError(
      expect.objectContaining<AuthTokenContractError>({
        code: "AUTH_TIME_CLAIM_INVALID",
      }),
    );
  });

  it("requires distinct web and desktop applications", () => {
    expect(() =>
      authTokenVerifyOptions({
        ...config,
        desktopClientId: config.webClientId,
      }),
    ).toThrowError(
      expect.objectContaining<AuthTokenContractError>({
        code: "AUTH_CONTRACT_CONFIG_INVALID",
      }),
    );
  });

  it("verifies a signed token end to end before accepting its application claims", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({
      sid: "session_example",
      client_id: "client_desktop",
      [`${AUTH_CLAIM_NAMESPACE}email`]: "user@example.com",
      [`${AUTH_CLAIM_NAMESPACE}email_verified`]: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "key_example" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user_example")
      .setJti("token_example")
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(4_000_000_000)
      .sign(privateKey);

    const verified = await jwtVerify(
      token,
      publicKey,
      authTokenVerifyOptions(config),
    );
    expect(validateAuthTokenClaims(verified.payload, config).clientKind).toBe(
      "desktop",
    );
  });

  it("rejects a correctly signed token for another API audience", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({
      sid: "session_example",
      client_id: "client_web",
      [`${AUTH_CLAIM_NAMESPACE}email`]: "user@example.com",
      [`${AUTH_CLAIM_NAMESPACE}email_verified`]: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "key_example" })
      .setIssuer(config.issuer)
      .setAudience("https://api-beta.zeros.build")
      .setSubject("user_example")
      .setJti("token_example")
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(4_000_000_000)
      .sign(privateKey);

    await expect(
      jwtVerify(token, publicKey, authTokenVerifyOptions(config)),
    ).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
    });
  });
});

import { describe, expect, it } from "vitest";
import { verifyAccountJwt } from "../../apps/desktop/src/engine/auth/verify-jwt";
import { createCloudValidationIdentity } from "../cloud-workspace-validation/lib/validation-identity";

describe("cloud qualification identity", () => {
  it("mints a bounded, asymmetric, expiring account token without retaining the private key", () => {
    const now = Date.now();
    const identity = createCloudValidationIdentity({
      ownerSubject: "zsr-ci:123:1",
      nowMs: now,
      ttlSeconds: 8 * 60 * 60,
    });
    expect(identity).not.toHaveProperty("privateKey");
    expect(identity.publicKey).toMatch(/BEGIN PUBLIC KEY/);
    expect(identity.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(identity.accessToken.length).toBeLessThan(16_384);
    expect(
      JSON.parse(
        Buffer.from(identity.accessToken.split(".")[0]!, "base64url").toString(
          "utf8",
        ),
      ),
    ).toMatchObject({ alg: "RS256", typ: "JWT", kid: identity.keyId });
    const claims = verifyAccountJwt(
      identity.accessToken,
      {
        publicKey: identity.publicKey,
        audience: identity.audience,
        issuer: identity.issuer,
        contract: "zeros-access-v1",
        clientId: identity.clientId,
      },
      now,
    );
    expect(claims.sub).toBe("zsr-ci:123:1");
    expect(claims.sid).toMatch(/^zsr_session_[0-9a-f-]{36}$/);
    expect(claims.jti).toMatch(/^zsr_token_[0-9a-f-]{36}$/);
    expect(claims.client_id).toBe(identity.clientId);
    expect(claims["https://zeros.build/email"]).toBe(
      "zsr-cloud-qualification@zeros.invalid",
    );
    expect(claims["https://zeros.build/email_verified"]).toBe(true);
    expect(claims.exp! * 1000).toBe(
      Math.floor(now / 1_000) * 1_000 + 8 * 60 * 60_000,
    );
  });

  it("rejects unsafe subjects and out-of-policy lifetimes", () => {
    for (const options of [
      { ownerSubject: "", ttlSeconds: 3600 },
      { ownerSubject: "bad\nsubject", ttlSeconds: 3600 },
      { ownerSubject: "zsr-ci:1:1", ttlSeconds: 299 },
      { ownerSubject: "zsr-ci:1:1", ttlSeconds: 24 * 60 * 60 + 1 },
    ]) {
      expect(() => createCloudValidationIdentity(options)).toThrow();
    }
  });
});

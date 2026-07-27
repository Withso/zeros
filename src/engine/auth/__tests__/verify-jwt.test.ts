import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createHmac,
  sign as nodeSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  verifyAccountJwt,
  verifyAccountJwtViaJwks,
  resetJwksCache,
  buildAccountAuthFromEnv,
  remoteMustBindFirst,
  remoteAccountVerdict,
  nextOwnerAccount,
  JwtError,
} from "../verify-jwt";

const b64url = (v: Buffer | string): string =>
  Buffer.from(v).toString("base64url");

function signHs256(payload: object, secret: string): string {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${sig}`;
}
function signAsym(
  payload: object,
  alg: "ES256" | "RS256",
  key: KeyObject,
): string {
  const h = b64url(JSON.stringify({ alg, typ: "JWT" }));
  const p = b64url(JSON.stringify(payload));
  const input = Buffer.from(`${h}.${p}`);
  const sig =
    alg === "ES256"
      ? nodeSign("sha256", input, { key, dsaEncoding: "ieee-p1363" })
      : nodeSign("sha256", input, key);
  return `${h}.${p}.${sig.toString("base64url")}`;
}
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as JwtError).code;
  }
  throw new Error("expected a throw");
}

const NOW = 1_700_000_000_000; // fixed ms
const sec = Math.floor(NOW / 1000);
const base = {
  sub: "user-123",
  aud: "authenticated",
  email: "a@b.com",
  exp: sec + 3600,
};

describe("verifyAccountJwt — HS256", () => {
  const secret = "super-secret-account-jwt-secret-value";

  it("verifies a valid token + returns claims", () => {
    const claims = verifyAccountJwt(
      signHs256(base, secret),
      { hs256Secret: secret, audience: "authenticated" },
      NOW,
    );
    expect(claims.sub).toBe("user-123");
    expect(claims.email).toBe("a@b.com");
  });

  it("rejects a wrong secret", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256(base, secret),
          { hs256Secret: "wrong" },
          NOW,
        ),
      ),
    ).toBe("BAD_SIGNATURE");
  });

  it("rejects a tampered payload (sub elevation)", () => {
    const t = signHs256(base, secret);
    const [h, , s] = t.split(".");
    const tampered = `${h}.${b64url(JSON.stringify({ ...base, sub: "attacker" }))}.${s}`;
    expect(
      codeOf(() => verifyAccountJwt(tampered, { hs256Secret: secret }, NOW)),
    ).toBe("BAD_SIGNATURE");
  });

  it("rejects an expired token but honors clock skew", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256({ ...base, exp: sec - 3600 }, secret),
          { hs256Secret: secret },
          NOW,
        ),
      ),
    ).toBe("EXPIRED");
    // 10s ago, 30s skew → still valid.
    expect(
      verifyAccountJwt(
        signHs256({ ...base, exp: sec - 10 }, secret),
        { hs256Secret: secret, clockSkewSec: 30 },
        NOW,
      ).sub,
    ).toBe("user-123");
  });

  it("rejects a not-yet-valid (nbf) token", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256({ ...base, nbf: sec + 3600 }, secret),
          { hs256Secret: secret },
          NOW,
        ),
      ),
    ).toBe("NOT_YET_VALID");
  });

  it("rejects a bad audience / issuer / missing subject", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256({ ...base, aud: "anon" }, secret),
          { hs256Secret: secret, audience: "authenticated" },
          NOW,
        ),
      ),
    ).toBe("BAD_AUDIENCE");
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256({ ...base, iss: "evil" }, secret),
          { hs256Secret: secret, issuer: "good" },
          NOW,
        ),
      ),
    ).toBe("BAD_ISSUER");
    const { sub: _omit, ...noSub } = base;
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256(noSub, secret),
          { hs256Secret: secret },
          NOW,
        ),
      ),
    ).toBe("NO_SUBJECT");
  });

  it("rejects malformed tokens + unsupported alg", () => {
    expect(() =>
      verifyAccountJwt("a.b.c.d", { hs256Secret: secret }, NOW),
    ).toThrow(JwtError);
    expect(() => verifyAccountJwt("", { hs256Secret: secret }, NOW)).toThrow(
      JwtError,
    );
    const noneTok = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(base))}.`;
    expect(
      codeOf(() => verifyAccountJwt(noneTok, { hs256Secret: secret }, NOW)),
    ).toBe("UNSUPPORTED_ALG");
  });

  it("blocks the RS256→HS256 alg-confusion attack (no secret when only a public key is set)", () => {
    // Server configured with an asymmetric public key only; attacker forges an
    // HS256 token. We must NOT treat the public key as an HMAC secret → NO_KEY.
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256(base, "pub"),
          {
            publicKey:
              "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----",
          },
          NOW,
        ),
      ),
    ).toBe("NO_KEY");
  });
});

describe("verifyAccountJwt — asymmetric", () => {
  it("verifies ES256 with a PEM public key + rejects a forged signature", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(
      verifyAccountJwt(
        signAsym(base, "ES256", privateKey),
        { publicKey: pem, audience: "authenticated" },
        NOW,
      ).sub,
    ).toBe("user-123");
    const otherKey = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    }).privateKey;
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signAsym(base, "ES256", otherKey),
          { publicKey: pem },
          NOW,
        ),
      ),
    ).toBe("BAD_SIGNATURE");
  });

  it("verifies RS256 with a PEM public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(
      verifyAccountJwt(
        signAsym(base, "RS256", privateKey),
        { publicKey: pem },
        NOW,
      ).sub,
    ).toBe("user-123");
  });
});

describe("verifyAccountJwt — multi-issuer", () => {
  const secret = "issuer-test-secret";
  const both = "https://tenant.example.com/,https://api.zeros.build/";
  it("accepts a token whose iss is any value in a comma-separated list", () => {
    for (const iss of ["https://tenant.example.com/", "https://api.zeros.build/"]) {
      expect(
        verifyAccountJwt(
          signHs256({ ...base, iss }, secret),
          { hs256Secret: secret, issuer: both },
          NOW,
        ).sub,
      ).toBe("user-123");
    }
  });
  it("rejects a token whose iss is not in the list", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256({ ...base, iss: "https://evil.example/auth/v1" }, secret),
          { hs256Secret: secret, issuer: both },
          NOW,
        ),
      ),
    ).toBe("BAD_ISSUER");
  });
  it("rejects a token with NO iss when an issuer list is required", () => {
    expect(
      codeOf(() =>
        verifyAccountJwt(
          signHs256(base, secret),
          { hs256Secret: secret, issuer: both },
          NOW,
        ),
      ),
    ).toBe("BAD_ISSUER");
  });
});

describe("verifyAccountJwtViaJwks (production asymmetric, kid-resolved)", () => {
  // EC P-256 keypair + its public JWK with a kid; sign tokens carrying that kid.
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "key-1",
    alg: "ES256",
    use: "sig",
  };
  const JWKS_URL = "https://api.zeros.build/auth/v1/.well-known/jwks.json";

  function signEs256WithKid(
    payload: object,
    key: KeyObject,
    kid: string,
  ): string {
    const h = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
    const p = b64url(JSON.stringify(payload));
    const sig = nodeSign("sha256", Buffer.from(`${h}.${p}`), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    return `${h}.${p}.${sig.toString("base64url")}`;
  }

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetJwksCache();
    fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ keys: [jwk] }),
        }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a token by resolving its kid from the JWKS endpoint", async () => {
    const claims = await verifyAccountJwtViaJwks(
      signEs256WithKid(base, privateKey, "key-1"),
      { jwksUrl: JWKS_URL, audience: "authenticated" },
      NOW,
    );
    expect(claims.sub).toBe("user-123");
    expect(fetchMock).toHaveBeenCalledWith(JWKS_URL, expect.anything());
  });

  it("caches the JWKS across verifies (one fetch for two tokens with a known kid)", async () => {
    await verifyAccountJwtViaJwks(
      signEs256WithKid(base, privateKey, "key-1"),
      { jwksUrl: JWKS_URL },
      NOW,
    );
    await verifyAccountJwtViaJwks(
      signEs256WithKid({ ...base, sub: "user-9" }, privateKey, "key-1"),
      { jwksUrl: JWKS_URL },
      NOW,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose kid is absent from the JWKS (no key)", async () => {
    await expect(
      verifyAccountJwtViaJwks(
        signEs256WithKid(base, privateKey, "unknown-kid"),
        { jwksUrl: JWKS_URL },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NO_KEY" });
  });

  it("rejects a token with no kid header", async () => {
    // signAsym (no kid) → resolution can't pick a key.
    await expect(
      verifyAccountJwtViaJwks(
        signAsym(base, "ES256", privateKey),
        { jwksUrl: JWKS_URL },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NO_KEY" });
  });

  it("rejects a forged signature even when the kid matches", async () => {
    const otherKey = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    }).privateKey;
    await expect(
      verifyAccountJwtViaJwks(
        signEs256WithKid(base, otherKey, "key-1"),
        { jwksUrl: JWKS_URL },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("fails closed when the JWKS endpoint is unreachable", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as unknown as Response);
    await expect(
      verifyAccountJwtViaJwks(
        signEs256WithKid(base, privateKey, "key-1"),
        { jwksUrl: JWKS_URL },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NO_KEY" });
  });
});

describe("remoteMustBindFirst (required-mode enforcement gate)", () => {
  const G = remoteMustBindFirst;
  it("never gates local (trusted desktop) clients", () => {
    expect(
      G({
        clientKind: "local",
        required: true,
        verified: false,
        msgType: "AGENT_PROMPT",
      }),
    ).toBe(false);
  });
  it("does not gate in optional mode (required=false)", () => {
    expect(
      G({
        clientKind: "cloud",
        required: false,
        verified: false,
        msgType: "WORKSPACE_REQUEST",
      }),
    ).toBe(false);
  });
  it("does not gate an already-verified remote client", () => {
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: true,
        msgType: "PTY_CREATE",
      }),
    ).toBe(false);
  });
  it("GATES every privileged message from an unverified remote client when required", () => {
    for (const t of [
      "AGENT_PROMPT",
      "AGENT_NEW_SESSION",
      "WORKSPACE_REQUEST",
      "PTY_CREATE",
      "PTY_WRITE",
      "AGENT_LIST_SESSIONS",
    ]) {
      expect(
        G({ clientKind: "cloud", required: true, verified: false, msgType: t }),
      ).toBe(true);
    }
  });
  it("allows ONLY CONNECTED + HEARTBEAT pre-auth (so the token can be presented)", () => {
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "CONNECTED",
      }),
    ).toBe(false);
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "HEARTBEAT",
      }),
    ).toBe(false);
  });
  it("gates an unverified cloud client fail-closed when required", () => {
    // The cloud transport is a remote kind; only LOCAL is exempt.
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "WORKSPACE_REQUEST",
      }),
    ).toBe(true);
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "PTY_WRITE",
      }),
    ).toBe(true);
    // CONNECTED + HEARTBEAT still pass pre-auth so the token can be presented.
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "CONNECTED",
      }),
    ).toBe(false);
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: false,
        msgType: "HEARTBEAT",
      }),
    ).toBe(false);
    // Inert until binding is required (the Phase-1 spike runs unconfigured).
    expect(
      G({
        clientKind: "cloud",
        required: false,
        verified: false,
        msgType: "WORKSPACE_REQUEST",
      }),
    ).toBe(false);
    // A verified cloud client is no longer gated.
    expect(
      G({
        clientKind: "cloud",
        required: true,
        verified: true,
        msgType: "PTY_CREATE",
      }),
    ).toBe(false);
  });
});

describe("remoteAccountVerdict (owner-binding: 'my account, my machine')", () => {
  const V = remoteAccountVerdict;
  it("allows any valid account in optional mode (required=false)", () => {
    expect(V({ required: false, ownerSub: null, clientSub: "anyone" })).toBe(
      "allow",
    );
    expect(
      V({ required: false, ownerSub: "user-A", clientSub: "user-B" }),
    ).toBe("allow");
  });
  it("rejects (retryable) when required but the owner is not yet established", () => {
    expect(V({ required: true, ownerSub: null, clientSub: "user-A" })).toBe(
      "reject-owner-unknown",
    );
  });
  it("allows the OWNER's own account", () => {
    expect(V({ required: true, ownerSub: "user-A", clientSub: "user-A" })).toBe(
      "allow",
    );
  });
  it("rejects a DIFFERENT valid account — a leaked pairing offer used by User B is blocked", () => {
    expect(V({ required: true, ownerSub: "user-A", clientSub: "user-B" })).toBe(
      "reject-wrong-account",
    );
  });
});

describe("nextOwnerAccount (owner lifecycle)", () => {
  const N = nextOwnerAccount;
  it("seeds the owner from a verified local CONNECTED", () => {
    expect(N(null, { kind: "local-connected", sub: "user-A" })).toBe("user-A");
  });
  it("re-seeds when a DIFFERENT account signs in locally (owner change)", () => {
    expect(N("user-A", { kind: "local-connected", sub: "user-B" })).toBe(
      "user-B",
    );
  });
  it("leaves the owner intact on a transient empty/unverifiable local token", () => {
    // A startup race / refresh blip / renderer reload that announces CONNECTED
    // with no usable token must NOT wipe the owner (which would lock out remote
    // devices). Only an explicit sign-out clears it.
    expect(N("user-A", { kind: "local-connected", sub: null })).toBe("user-A");
  });
  it("clears the owner on an explicit sign-out", () => {
    expect(N("user-A", { kind: "signed-out" })).toBeNull();
  });
});

describe("owner-binding flow: local-seed → wrong-account → sign-out → re-seed", () => {
  // Thread the owner state through the SAME reducer + verdict the engine uses, so
  // this locks in the sign-out hardening for remote account binding:
  // after sign-out, even the SAME account that was the owner is no longer
  // auto-allowed until a fresh local CONNECTED re-seeds the owner.
  it("denies the previous owner's still-valid token until a new owner is seeded", () => {
    let owner: string | null = null;

    // 1) The desktop renderer signs in → local CONNECTED seeds the owner.
    owner = nextOwnerAccount(owner, { kind: "local-connected", sub: "user-A" });
    expect(owner).toBe("user-A");
    // The owner's own remote device binds; a different account is rejected.
    expect(
      remoteAccountVerdict({
        required: true,
        ownerSub: owner,
        clientSub: "user-A",
      }),
    ).toBe("allow");
    expect(
      remoteAccountVerdict({
        required: true,
        ownerSub: owner,
        clientSub: "user-B",
      }),
    ).toBe("reject-wrong-account");

    // 2) The desktop owner signs out (OWNER_SIGNED_OUT → clearOwnerBinding).
    owner = nextOwnerAccount(owner, { kind: "signed-out" });
    expect(owner).toBeNull();
    // THE FIX: User A's still-valid token no longer auto-binds — without the
    // clear, the engine kept ownerSub = "user-A" and User A's remote stayed
    // allowed after sign-out. It is now retryable-rejected (fail closed).
    expect(
      remoteAccountVerdict({
        required: true,
        ownerSub: owner,
        clientSub: "user-A",
      }),
    ).toBe("reject-owner-unknown");

    // 3) The desktop signs back in (same OR different account) → owner re-seeds,
    //    and the matching remote device binds again automatically.
    owner = nextOwnerAccount(owner, { kind: "local-connected", sub: "user-A" });
    expect(
      remoteAccountVerdict({
        required: true,
        ownerSub: owner,
        clientSub: "user-A",
      }),
    ).toBe("allow");
  });
});

describe("buildAccountAuthFromEnv", () => {
  it("returns null when neither a secret nor a public key is set (pairing-only)", () => {
    expect(buildAccountAuthFromEnv({})).toBeNull();
  });
  it("builds HS256 config with defaults (aud=authenticated, optional)", () => {
    const a = buildAccountAuthFromEnv({ ZEROS_ACCOUNT_JWT_SECRET: "s" });
    expect(a?.config.hs256Secret).toBe("s");
    expect(a?.config.audience).toBe("authenticated");
    expect(a?.required).toBe(false);
  });
  it("honors ZEROS_REQUIRE_ACCOUNT + custom audience + public key", () => {
    const a = buildAccountAuthFromEnv({
      ZEROS_ACCOUNT_JWT_PUBLIC_KEY: "pem",
      ZEROS_REQUIRE_ACCOUNT: "1",
      ZEROS_ACCOUNT_JWT_AUD: "custom",
    });
    expect(a?.required).toBe(true);
    expect(a?.config.audience).toBe("custom");
    expect(a?.config.publicKey).toBe("pem");
  });
  it("enables binding via an explicit JWKS URL alone (production path)", () => {
    const a = buildAccountAuthFromEnv({
      ZEROS_ACCOUNT_JWT_JWKS_URL:
        "https://api.zeros.build/auth/v1/.well-known/jwks.json",
      ZEROS_REQUIRE_ACCOUNT: "true",
    });
    expect(a).not.toBeNull();
    expect(a?.config.jwksUrl).toBe(
      "https://api.zeros.build/auth/v1/.well-known/jwks.json",
    );
    expect(a?.required).toBe(true);
  });
  it("derives the JWKS URL from the issuer origin at the STANDARD path", () => {
    const a = buildAccountAuthFromEnv({
      ZEROS_ACCOUNT_JWT_ISSUER: "https://tenant.example.com/",
    });
    // RFC 8414, not GoTrue's `/auth/v1/` layout — the origin form is only
    // usable if it resolves somewhere a conformant IdP actually serves.
    // Trailing slashes on the origin must not produce a doubled separator.
    expect(a?.config.jwksUrl).toBe(
      "https://tenant.example.com/.well-known/jwks.json",
    );
    expect(a?.required).toBe(false);
  });
  it("prefers an explicit JWKS URL over the derived one", () => {
    const a = buildAccountAuthFromEnv({
      ZEROS_ACCOUNT_JWT_JWKS_URL: "https://explicit.example.com/jwks",
      ZEROS_ACCOUNT_JWT_ISSUER: "https://tenant.example.com",
    });
    expect(a?.config.jwksUrl).toBe("https://explicit.example.com/jwks");
  });
  it("forwards a comma-separated issuer list", () => {
    const a = buildAccountAuthFromEnv({
      ZEROS_ACCOUNT_JWT_JWKS_URL: "https://x/jwks",
      ZEROS_ACCOUNT_JWT_ISS:
        "https://tenant.example.com/,https://api.zeros.build/",
    });
    expect(a?.config.issuer).toContain("tenant.example.com");
  });
});

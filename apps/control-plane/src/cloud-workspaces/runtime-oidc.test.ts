import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRuntimeOidcVerifier,
  RUNTIME_OIDC_ISSUER,
  RUNTIME_OIDC_JWKS_URL,
  RuntimeOidcError,
} from "./runtime-oidc.js";

const config = {
  audience: "zeros-control-plane-alpha",
  repository: "Withso/zeros",
  environment: "alpha" as const,
};
const sha = "a".repeat(40);
const workflowRef = `${config.repository}/.github/workflows/release-alpha.yml@refs/heads/main`;
let first: Awaited<ReturnType<typeof generateKeyPair>>;
let second: Awaited<ReturnType<typeof generateKeyPair>>;
let firstJwk: Awaited<ReturnType<typeof exportJWK>>;
let secondJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  first = await generateKeyPair("RS256");
  second = await generateKeyPair("RS256");
  firstJwk = {
    ...(await exportJWK(first.publicKey)),
    kid: "first",
    alg: "RS256",
  };
  secondJwk = {
    ...(await exportJWK(second.publicKey)),
    kid: "second",
    alg: "RS256",
  };
});

function token(changes: JWTPayload = {}, pair = first, kid = "first") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: RUNTIME_OIDC_ISSUER,
    aud: config.audience,
    iat: now,
    exp: now + 300,
    repository: config.repository,
    workflow_ref: workflowRef,
    ref: "refs/heads/main",
    event_name: "push",
    environment: "alpha",
    run_id: "1234",
    run_number: "42",
    run_attempt: "2",
    sha,
    ...changes,
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .sign(pair.privateKey);
}

function verifier() {
  return createRuntimeOidcVerifier(config, {
    keySet: createLocalJWKSet({ keys: [firstJwk] }),
  });
}

describe("runtime publication OIDC", () => {
  it("returns only verified, typed Release provenance", async () => {
    expect(
      await verifier()(
        await token({ repository: "withso/ZEROS" }),
        "publication",
      ),
    ).toEqual({
      runId: 1234,
      runNumber: 42,
      runAttempt: 2,
      sha,
      workflowRef,
    });
  });

  it("gives only the manual base workflow base-registration authority", async () => {
    const workflow_ref = `${config.repository}/.github/workflows/cloud-runtime-base.yml@refs/heads/main`;
    const base = await token({ workflow_ref, event_name: "workflow_dispatch" });
    expect(await verifier()(base, "base_registration")).toMatchObject({
      workflowRef: workflow_ref,
    });
    await expect(verifier()(base, "publication")).rejects.toBeInstanceOf(
      RuntimeOidcError,
    );
    await expect(
      verifier()(await token(), "base_registration"),
    ).rejects.toBeInstanceOf(RuntimeOidcError);
  });

  it.each(["publication", "base_registration"] as const)(
    "bounds future iat to sixty seconds of skew for %s",
    async (purpose) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
      try {
        const now = Math.floor(Date.now() / 1000);
        const workflow =
          purpose === "publication"
            ? {}
            : {
                workflow_ref: `${config.repository}/.github/workflows/cloud-runtime-base.yml@refs/heads/main`,
                event_name: "workflow_dispatch",
              };
        const verify = verifier();
        expect(
          await verify(await token({ ...workflow, iat: now + 60 }), purpose),
        ).toMatchObject({ runId: 1234 });
        await expect(
          verify(await token({ ...workflow, iat: now + 61 }), purpose),
        ).rejects.toThrow(/^Runtime publication authentication rejected$/);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    { repository: "Other/zeros" },
    {
      workflow_ref: `${config.repository}/.github/workflows/other.yml@refs/heads/main`,
    },
    { workflow_ref: workflowRef.toLowerCase() },
    { ref: "refs/heads/feature" },
    { event_name: "pull_request" },
    { event_name: "pull_request_target" },
    { event_name: "workflow_dispatch" },
    { environment: "beta" },
    { environment: undefined },
    { aud: "another-audience" },
    { iss: "https://other.example.test" },
    { exp: 1 },
    { exp: undefined },
    { iat: undefined },
    { run_id: "1234\n" },
    { run_number: "042" },
    { run_attempt: "2147483648" },
    { run_id: "9007199254740992" },
    { run_number: 42 },
    { sha: "unverified-sha" },
  ])("rejects a wrong or missing claim: %j", async (changes) => {
    await expect(
      verifier()(await token(changes), "publication"),
    ).rejects.toThrow(/^Runtime publication authentication rejected$/);
  });

  it("makes the alpha environment check optional only through configuration", async () => {
    const verify = createRuntimeOidcVerifier(
      { ...config, environment: null },
      { keySet: createLocalJWKSet({ keys: [firstJwk] }) },
    );
    expect(
      await verify(await token({ environment: undefined }), "publication"),
    ).toMatchObject({ runNumber: 42 });
  });

  it("verifies signatures rather than trusting decoded claims", async () => {
    await expect(
      verifier()(await token({}, second, "first"), "publication"),
    ).rejects.toBeInstanceOf(RuntimeOidcError);
    await expect(
      verifier()("untrusted-token", "publication"),
    ).rejects.toBeInstanceOf(RuntimeOidcError);
  });

  it("caches keys and reloads the GitHub JWKS on rotation", async () => {
    let keys = [firstJwk];
    const fetchKeys = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const keySet = createRemoteJWKSet(new URL(RUNTIME_OIDC_JWKS_URL), {
      [customFetch]: fetchKeys,
      cooldownDuration: 0,
    });
    const verify = createRuntimeOidcVerifier(config, { keySet });
    await verify(await token(), "publication");
    await verify(await token(), "publication");
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    keys = [secondJwk];
    expect(
      await verify(await token({}, second, "second"), "publication"),
    ).toMatchObject({ runId: 1234 });
    expect(fetchKeys).toHaveBeenCalledTimes(2);
  });

  it("suppresses URL-bearing JWKS failures and never logs JWTs", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warningLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verify = createRuntimeOidcVerifier(config, {
        keySet: async () => {
          throw new Error(
            "https://private.example.test/jwks?token=private-sentinel",
          );
        },
      });
      await expect(verify(await token(), "publication")).rejects.toThrow(
        /^Runtime publication authentication rejected$/,
      );
      expect(errorLog).not.toHaveBeenCalled();
      expect(warningLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });
});

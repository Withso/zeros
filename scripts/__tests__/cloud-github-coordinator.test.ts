import { createHash, generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  resolveQualifiedCloudGithubCredential,
  resolveQualifiedCloudGithubCredentialAfterInvalidation,
} from "../cloud-workspace-validation/github-coordinator";

function jwtFor(subject: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify({ sub: subject })).toString("base64url"),
    "signature-placeholder",
  ].join(".");
}

describe("qualified cloud GitHub credential coordinator", () => {
  it("uses the production GitHub App broker for a single private-repository qualification scope", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const now = 1_800_000_000_000;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (
        String(input) ===
        "https://api.github.com/app/installations/987654/access_tokens"
      ) {
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["private-fixture"],
          permissions: { contents: "read" },
        });
        return Response.json(
          {
            token: "ghs_private_repository_working_copy",
            expires_at: new Date(now + 60 * 60_000).toISOString(),
          },
          { status: 201 },
        );
      }
      expect(String(input)).toBe(
        "https://api.github.com/repos/withso/private-fixture",
      );
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.headers).toMatchObject({
        authorization: "Bearer ghs_private_repository_working_copy",
      });
      return Response.json({
        full_name: "withso/private-fixture",
        private: true,
      });
    });

    await expect(
      resolveQualifiedCloudGithubCredential(
        {
          ZEROS_CLOUD_OWNER_SUB: "workos|qualification-owner",
          ZEROS_CLOUD_GITHUB_APP_ID: "12345",
          ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY: pem,
          ZEROS_CLOUD_GITHUB_INSTALLATION_ID: "987654",
          ZEROS_CLOUD_GITHUB_REPOSITORY: "withso/private-fixture",
        },
        { fetch: fetchImpl as typeof fetch, now: () => now },
      ),
    ).resolves.toEqual({
      method: "github-app",
      accessToken: "ghs_private_repository_working_copy",
      expiresAtMs: now + 60 * 60_000,
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      variantKey: "github.com",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects a public repository masquerading as the private fixture", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const now = 1_800_000_000_000;
    const fetchImpl = vi.fn(async (input: string | URL) =>
      String(input).includes("/access_tokens")
        ? Response.json(
            {
              token: "ghs_public_repository_working_copy",
              expires_at: new Date(now + 60 * 60_000).toISOString(),
            },
            { status: 201 },
          )
        : Response.json({
            full_name: "withso/private-fixture",
            private: false,
          }),
    );

    await expect(
      resolveQualifiedCloudGithubCredential(
        {
          ZEROS_CLOUD_OWNER_SUB: "workos|qualification-owner",
          ZEROS_CLOUD_GITHUB_APP_ID: "12345",
          ZEROS_CLOUD_GITHUB_APP_PRIVATE_KEY: pem,
          ZEROS_CLOUD_GITHUB_INSTALLATION_ID: "987654",
          ZEROS_CLOUD_GITHUB_REPOSITORY: "withso/private-fixture",
        },
        { fetch: fetchImpl as typeof fetch, now: () => now },
      ),
    ).rejects.toThrow(/private repository/i);
  });

  it("rejects partial direct GitHub App qualification authority", async () => {
    await expect(
      resolveQualifiedCloudGithubCredential({
        ZEROS_CLOUD_OWNER_SUB: "workos|qualification-owner",
        ZEROS_CLOUD_GITHUB_APP_ID: "12345",
        ZEROS_CLOUD_GITHUB_INSTALLATION_ID: "987654",
      }),
    ).rejects.toThrow(/incomplete/i);
  });

  it("mints for the exact owner and repository without exposing bearers in the URL or body", async () => {
    const owner = "auth0|owner";
    const accountToken = jwtFor(owner);
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.example.test/v1/github/installations/987654/token",
      );
      expect(String(input)).not.toContain(accountToken);
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${accountToken}`,
        "content-type": "application/json",
      });
      expect(init?.body).toBe(JSON.stringify({ repositories: ["zeros"] }));
      expect(String(init?.body)).not.toContain(accountToken);
      return Response.json({
        method: "github-app",
        accessToken: "ghs_cloud-working-copy",
        expiresAtMs: 1_800_000_000_000 + 60 * 60_000,
        gitHost: "github.com",
        gitHttpUsername: "x-access-token",
        variantKey: "github.com",
        ownerSubjectSha256: createHash("sha256")
          .update(owner)
          .digest("hex"),
      });
    });
    await expect(
      resolveQualifiedCloudGithubCredential(
        {
          ZEROS_CLOUD_OWNER_SUB: owner,
          ZEROS_CONTROL_PLANE_URL: "https://api.example.test",
          ZEROS_ACCOUNT_ACCESS_TOKEN: accountToken,
          ZEROS_CLOUD_GITHUB_INSTALLATION_ID: "987654",
          ZEROS_CLOUD_GITHUB_REPOSITORIES: "zeros",
        },
        { fetch: fetchImpl as typeof fetch, now: () => 1_800_000_000_000 },
      ),
    ).resolves.toMatchObject({
      method: "github-app",
      accessToken: "ghs_cloud-working-copy",
      expiresAtMs: 1_800_003_600_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a control-plane response bound to another worker owner", async () => {
    const owner = "auth0|owner";
    const fetchImpl = vi.fn(async () =>
      Response.json({
        method: "github-app",
        accessToken: "ghs_foreign-working-copy",
        expiresAtMs: 1_800_003_600_000,
        gitHost: "github.com",
        gitHttpUsername: "x-access-token",
        variantKey: "github.com",
        ownerSubjectSha256: createHash("sha256")
          .update("auth0|different")
          .digest("hex"),
      }),
    );
    await expect(
      resolveQualifiedCloudGithubCredential(
        {
          ZEROS_CLOUD_OWNER_SUB: owner,
          ZEROS_CONTROL_PLANE_URL: "https://api.example.test",
          ZEROS_ACCOUNT_ACCESS_TOKEN: jwtFor(owner),
          ZEROS_CLOUD_GITHUB_INSTALLATION_ID: "987654",
        },
        { fetch: fetchImpl as typeof fetch, now: () => 1_800_000_000_000 },
      ),
    ).rejects.toThrow(/owner binding/i);
  });

  it("uses an explicit operator credential without contacting the control plane", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveQualifiedCloudGithubCredential(
        {
          ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
          ZEROS_CLOUD_GITHUB_TOKEN: "github_pat_explicit",
          ZEROS_CLOUD_GITHUB_METHOD: "pat",
        },
        { fetch: fetchImpl as never },
      ),
    ).resolves.toMatchObject({
      method: "pat",
      accessToken: "github_pat_explicit",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears non-renewable rejected credentials instead of reinstalling them", async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveQualifiedCloudGithubCredentialAfterInvalidation(
        "pat",
        {
          ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
          ZEROS_CLOUD_GITHUB_TOKEN: "github_pat_rejected",
          ZEROS_CLOUD_GITHUB_METHOD: "pat",
        },
        { fetch: fetchImpl as never },
      ),
    ).resolves.toBeNull();
    await expect(
      resolveQualifiedCloudGithubCredentialAfterInvalidation(
        "github-app",
        {
          ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
          ZEROS_CLOUD_GITHUB_TOKEN: "ghs_explicit_rejected",
          ZEROS_CLOUD_GITHUB_METHOD: "github-app",
          ZEROS_CLOUD_GITHUB_EXPIRES_AT_MS: String(Date.now() + 60 * 60_000),
        },
        { fetch: fetchImpl as never },
      ),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

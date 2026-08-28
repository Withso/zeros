import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { GithubBackendConfig } from "../config.js";
import { GithubCloudWorkspaceCredentialBroker } from "./github-credentials.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: GithubBackendConfig = {
  appId: 123,
  clientId: "Iv1.cloud-workspace-test",
  clientSecret: "client-secret-for-tests",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  refreshBindingSecret: "refresh-binding-secret-for-tests",
  appSlug: "zeros-test",
  oauthCallbackUrl: "https://app.example.test/github/callback",
  completionPageUrl: "https://app.example.test/github/connected",
  webBaseUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  variantKey: "github.com",
  desktopSchemes: ["zeros", "zeros-alpha", "zeros-beta", "zeros-dev"],
};
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

describe("GithubCloudWorkspaceCredentialBroker", () => {
  it("mints only a read-only token scoped to the exact repository", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          token: "ghs_repository_read_only",
          expires_at: new Date(NOW + 60 * 60_000).toISOString(),
        },
        { status: 201 },
      ),
    );
    const broker = new GithubCloudWorkspaceCredentialBroker(config, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
    });

    await expect(
      broker.mint({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).resolves.toEqual({
      token: "ghs_repository_read_only",
      expiresAtMs: NOW + 60 * 60_000,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(
      "https://api.github.com/app/installations/987654/access_tokens",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2026-03-10",
    });
    expect(
      String((init?.headers as Record<string, string>).authorization),
    ).toMatch(/^Bearer eyJ/);
    expect(JSON.parse(String(init?.body))).toEqual({
      repositories: ["zeros"],
      permissions: { contents: "read" },
    });
  });

  it("revokes an installation credential without putting it in the URL", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const broker = new GithubCloudWorkspaceCredentialBroker(config, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
    });

    await expect(
      broker.revoke("ghs_revoke_this_token"),
    ).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/installation/token");
    expect(url).not.toContain("ghs_revoke_this_token");
    expect(init).toMatchObject({ method: "DELETE", redirect: "error" });
    expect(init?.headers).toMatchObject({
      authorization: "Bearer ghs_revoke_this_token",
    });
  });

  it("revokes a token returned in an invalid mint response", async () => {
    const mintedToken = "ghs_invalid_lifetime_must_be_revoked";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            token: mintedToken,
            expires_at: new Date(NOW + 30_000).toISOString(),
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const broker = new GithubCloudWorkspaceCredentialBroker(config, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
    });

    await expect(
      broker.mint({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).rejects.toThrow("unavailable");

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/installation/token",
    );
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${mintedToken}`,
    });
  });

  it("rejects malformed scope input before any network request", async () => {
    const fetch = vi.fn();
    const broker = new GithubCloudWorkspaceCredentialBroker(config, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
    });

    await expect(
      broker.mint({
        installationId: 0,
        owner: "withso/other",
        repository: "../zeros",
      }),
    ).rejects.toThrow("invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a forge origin that does not match the GitHub.com clone contract", () => {
    expect(
      () =>
        new GithubCloudWorkspaceCredentialBroker({
          ...config,
          apiBaseUrl: "https://github.example.test/api/v3",
        }),
    ).toThrow(/GitHub\.com/i);
  });

  it.each([
    ["wrong status", Response.json({ token: "ghs_token" }, { status: 200 })],
    [
      "expired credential",
      Response.json(
        {
          token: "ghs_token",
          expires_at: new Date(NOW + 30_000).toISOString(),
        },
        { status: 201 },
      ),
    ],
    [
      "oversized response",
      new Response(JSON.stringify({ token: "x".repeat(70_000) }), {
        status: 201,
      }),
    ],
  ])("fails closed for a %s", async (_name, response) => {
    const broker = new GithubCloudWorkspaceCredentialBroker(config, {
      fetch: vi.fn(async () => response) as typeof globalThis.fetch,
      now: () => NOW,
    });
    await expect(
      broker.mint({
        installationId: 987654,
        owner: "withso",
        repository: "zeros",
      }),
    ).rejects.toThrow("unavailable");
  });
});

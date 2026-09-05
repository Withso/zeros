import { randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  loadGenerationCloudProviderConnection,
  openCloudProviderCredential,
  sealCloudProviderCredential,
} from "./provider-connections.js";

describe("cloud provider credential envelope", () => {
  const binding = {
    connectionId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    provider: "daytona" as const,
    endpoint: "https://app.daytona.io/api",
  };

  it("round-trips without embedding plaintext and verifies the envelope hash", () => {
    const key = randomBytes(32).toString("base64url");
    const credential = "daytona_test_credential_0123456789";
    const sealed = sealCloudProviderCredential(credential, binding, key);

    expect(sealed.ciphertext.toString("utf8")).not.toContain(credential);
    expect(sealed.credentialSha256).toHaveLength(32);
    expect(
      openCloudProviderCredential(
        { keyVersion: 1, ...sealed },
        binding,
        key,
      ),
    ).toBe(credential);
  });

  it("fails closed when a credential is replayed under another tenant", () => {
    const key = randomBytes(32).toString("base64url");
    const sealed = sealCloudProviderCredential(
      "daytona_test_credential_0123456789",
      binding,
      key,
    );

    expect(() =>
      openCloudProviderCredential(
        { keyVersion: 1, ...sealed },
        {
          ...binding,
          organizationId: "33333333-3333-4333-8333-333333333333",
        },
        key,
      ),
    ).toThrow("invalid");
  });

  it("rejects endpoints with credential-bearing URL components", () => {
    const key = randomBytes(32).toString("base64url");
    expect(() =>
      sealCloudProviderCredential(
        "daytona_test_credential_0123456789",
        { ...binding, endpoint: "https://token@app.daytona.io/api" },
        key,
      ),
    ).toThrow("invalid");
  });
});

describe("generation provider connection lookup", () => {
  it("loads the immutable generation version instead of the rotated current version", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          org_id: "22222222-2222-4222-8222-222222222222",
          provider: "daytona",
          credential_source: "hosted",
          endpoint: "hosted://daytona-v1",
          region: null,
          current_version: 1,
        },
      ],
    }));

    await expect(
      loadGenerationCloudProviderConnection({ query } as never, {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        organizationId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
      }),
    ).resolves.toMatchObject({
      credentialVersion: 1,
      endpoint: "hosted://daytona-v1",
    });
    expect(query.mock.calls[0]?.[0]).toContain(
      "version.version = generation.provider_connection_version",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "version.version AS current_version",
    );
  });
});

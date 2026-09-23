import { generateKeyPairSync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("./boat-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boat-client.js")>();
  class RecordingBoatApiClient extends actual.BoatApiClient {
    constructor(options: ConstructorParameters<typeof actual.BoatApiClient>[0]) {
      super(options);
      constructed.push({ ...options, apiKey: "<redacted>" });
    }
  }
  return { ...actual, BoatApiClient: RecordingBoatApiClient };
});

const { loadConfig } = await import("../config.js");
const { createCloudProviderDeployment } = await import("./provider-deployment.js");

describe("managed Boat wallet composition", () => {
  it("gives every managed Boat client the configured billing wallet", () => {
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const cloud = loadConfig({
      DATABASE_URL: "postgres://qualification@localhost/unused",
      AUTH0_DOMAIN: "tenant.example.test",
      AUTH_AUDIENCE: "https://api.example.test",
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "test-client",
      GITHUB_APP_CLIENT_SECRET: "test-client-secret",
      GITHUB_APP_SLUG: "qualification",
      GITHUB_OAUTH_CALLBACK_URL: "https://api.example.test/github",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      CLOUD_WORKSPACES_ENABLED: "true",
      CLOUD_WORKSPACE_PROVIDER: "boat",
      BOAT_API_KEY: "boat-test-key-not-daytona",
      BOAT_ACCOUNT_SCOPE: "qualified-account",
      BOAT_BILLING_ORG: "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41",
      BOAT_TTL_SECONDS: "3600",
      BOAT_COMPUTE_POLICY_ID: "qualified-rate-v1",
      BOAT_SECONDS_PER_DOLLAR: "100000",
      BOAT_SNAPSHOT_ID: "qualified-image",
      BOAT_IMAGE_BUILD_SHA256: "c".repeat(64),
      CLOUD_WORKSPACE_STORAGE_MIB: "40960",
      ZEROS_CLOUD_SOURCE_COMMIT: "a".repeat(40),
    }).cloudWorkspaces!;
    const pool = { connect: vi.fn(() => { throw new Error("unexpected database access"); }) } as unknown as pg.Pool;
    createCloudProviderDeployment(pool, cloud);
    expect(constructed.length).toBeGreaterThanOrEqual(2);
    for (const options of constructed)
      expect(options.billingOrg).toBe("team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41");
  });
});

import { generateKeyPairSync } from "node:crypto";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const boatClients = vi.hoisted(() => [] as Array<{ billingOrg?: string }>);
vi.mock("./boat-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./boat-client.js")>();
  class RecordingBoatApiClient extends actual.BoatApiClient {
    constructor(options: ConstructorParameters<typeof actual.BoatApiClient>[0]) {
      super(options);
      boatClients.push({ billingOrg: options.billingOrg });
    }
  }
  return { ...actual, BoatApiClient: RecordingBoatApiClient };
});

import { loadConfig } from "../config.js";
import { createCloudProviderDeployment } from "./provider-deployment.js";
import { BoatSetupCommandRunner } from "./boat-setup-runner.js";
import { DaytonaSandboxCommandRunner } from "./daytona-command-runner.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
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
    DAYTONA_BYO_ENABLED: "true",
    DAYTONA_BYO_SNAPSHOT_ID: "customer-image",
    DAYTONA_BYO_SOURCE_COMMIT: "b".repeat(40),
    DAYTONA_BYO_CPU_MILLICORES: "2000",
    DAYTONA_BYO_MEMORY_MIB: "4096",
    DAYTONA_BYO_STORAGE_MIB: "10240",
    ...overrides,
  }).cloudWorkspaces!;
}
const connection = {
  apiKey: "customer-daytona-test-key",
  apiUrl: "https://app.daytona.io/api",
  region: "eu",
  capabilities: { daytonaTarget: "eu" },
  imageRef: "customer-image",
  architecture: "linux/amd64" as const,
  cpuMillicores: 2000,
  memoryMiB: 4096,
  storageMiB: 10240,
  purpose: "lifecycle" as const,
};
afterEach(() => vi.unstubAllGlobals());

describe("production cloud provider composition", () => {
  const pool = {
    connect: vi.fn(() => {
      throw new Error("unexpected database access");
    }),
  } as unknown as pg.Pool;
  it("gives every managed Boat client the configured billing wallet", () => {
    boatClients.length = 0;
    createCloudProviderDeployment(pool, config());
    expect(boatClients.length).toBeGreaterThanOrEqual(2);
    expect(new Set(boatClients.map((client) => client.billingOrg))).toEqual(
      new Set(["team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41"]),
    );
  });
  it("does not contact providers at startup and keeps managed Boat out of Daytona BYO", async () => {
    const fetcher = vi.fn(() => {
      throw new Error("unexpected provider request");
    });
    vi.stubGlobal("fetch", fetcher);
    const { provider, registry } = createCloudProviderDeployment(
      pool,
      config(),
    );
    expect(provider.name).toBe("boat");
    expect(registry.names().sort()).toEqual(["boat", "daytona"]);
    expect(registry.hostedScopes().map((scope) => scope.provider.name)).toEqual(
      ["boat"],
    );
    expect(registry.delegated("daytona", connection).provider.name).toBe(
      "daytona",
    );
    expect(() => registry.hosted("daytona", "cleanup")).toThrow(
      /exact cloud provider account/,
    );
    expect(() => registry.hosted("boat", "setup")).toThrow(
      /command execution is unavailable/,
    );
    await expect(
      provider.create({
        ...connection,
        imageRef: "unqualified-image",
        workspaceId: "workspace",
        generation: 1,
        idempotencyKey: "intent",
      }),
    ).rejects.toMatchObject({ code: "provider_profile_unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("selects the qualified bootstrap independently for both provider accounts", () => {
    const cloud = config({
      CLOUD_WORKSPACE_SETUP_WORKER_ENABLED: "true",
      CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://api.example.test",
      CLOUD_WORKSPACE_SECRET_KEY_V1: Buffer.alloc(32, 1).toString("base64url"),
      CLOUD_WORKSPACE_OBJECT_STORE_DIRECTORY:
        "/var/lib/zeros/qualification-objects",
      CLOUD_WORKSPACE_OBJECT_KEY_V1: Buffer.alloc(32, 2).toString("base64url"),
      DAYTONA_TOOLBOX_ORIGINS: "https://proxy.daytona.work",
    });
    const { registry } = createCloudProviderDeployment(pool, cloud);
    expect(registry.hosted("boat", "setup").commandRunner).toBeInstanceOf(
      BoatSetupCommandRunner,
    );
    expect(
      registry.delegated("daytona", { ...connection, purpose: "setup" })
        .commandRunner,
    ).toBeInstanceOf(DaytonaSandboxCommandRunner);
    expect(() =>
      registry.delegated("boat", { ...connection, purpose: "setup" }),
    ).toThrow(/exact cloud provider account/);
  });

  it("retains the existing managed Daytona configuration", () => {
    const cloud = config({
      CLOUD_WORKSPACE_PROVIDER: "daytona",
      DAYTONA_API_KEY: "managed-daytona-test-key",
      DAYTONA_SNAPSHOT_ID: "managed-image",
    });
    const { registry, provider } = createCloudProviderDeployment(pool, cloud);
    expect(provider.name).toBe("daytona");
    expect(registry.names()).toEqual(["daytona"]);
    expect(registry.hostedScopes()).toEqual([{ provider }]);
    expect(() => registry.hosted("boat", "cleanup")).toThrow(
      /exact cloud provider account/,
    );
  });
});

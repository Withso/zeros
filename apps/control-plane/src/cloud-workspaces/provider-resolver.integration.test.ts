import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import type { DaytonaWorkspaceProviderConfig } from "./daytona-provider.js";
import { sealCloudProviderCredential } from "./provider-connections.js";
import { DatabaseDaytonaProviderResolver } from "./provider-resolver.js";
import type {
  CloudWorkspaceAccessProvider,
  CloudWorkspaceProvider,
} from "./provider.js";
import {
  seedReadyCloudWorkspace,
  type ReadyCloudWorkspaceFixture,
} from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

function provider(): CloudWorkspaceProvider & CloudWorkspaceAccessProvider {
  return {
    name: "daytona",
    find: vi.fn(async () => []),
    create: vi.fn(),
    inspect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    delete: vi.fn(),
    listManaged: vi.fn(async function* () {}),
    createSshAccess: vi.fn(),
    revokeSshAccess: vi.fn(),
    getPreviewEndpoint: vi.fn(),
  };
}

const hostedConfig: DaytonaWorkspaceProviderConfig = {
  apiKey: "hosted-daytona-key-0123456789",
  apiUrl: "https://app.daytona.io/api",
  target: "eu",
  snapshotId: "snapshot-pinned",
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  operationTimeoutSeconds: 180,
  autoStopMinutes: 0,
  autoArchiveMinutes: 10_080,
  autoDeleteMinutes: -1,
};

d("generation-bound cloud provider resolution", () => {
  let pool: pg.Pool;
  let fixture: ReadyCloudWorkspaceFixture;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool);
  });

  it("returns the deployment provider only for the exact hosted generation binding", async () => {
    const hosted = provider();
    const resolver = new DatabaseDaytonaProviderResolver({
      pool,
      hostedProvider: hosted,
      hostedConfig,
      workosEnabled: false,
    });
    await expect(
      resolver.resolve({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        purpose: "lifecycle",
      }),
    ).resolves.toMatchObject({
      provider: hosted,
      connectionVersion: 1,
      credentialSource: "hosted",
    });
  });

  it("opens a qualified delegated credential just in time and rejects it after revocation", async () => {
    const encryptionKey = randomBytes(32).toString("base64url");
    const connectionId = randomUUID();
    const endpoint = "https://delegated.daytona.example/api";
    const credential = "delegated-daytona-key-0123456789";
    const sealed = sealCloudProviderCredential(
      credential,
      {
        connectionId,
        organizationId: fixture.organizationId,
        version: 1,
        provider: "daytona",
        endpoint,
      },
      encryptionKey,
    );
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO provider_connections (
           id, org_id, owner_kind, owner_user_id, provider, display_name,
           credential_source, current_version, state, capabilities, region
         ) VALUES (
           $1, $2, 'user', $3, 'daytona', 'My Daytona', 'delegated', 1,
           'active', $4::jsonb, 'eu'
         )`,
        [
          connectionId,
          fixture.organizationId,
          fixture.userId,
          JSON.stringify({
            qualified: true,
            lifecycle: true,
            ssh: true,
            preview: true,
            daytonaTarget: "eu",
          }),
        ],
      );
      await tx.query(
        `INSERT INTO provider_connection_versions (
           connection_id, org_id, version, credential_source, endpoint,
           key_version, nonce, ciphertext, auth_tag, credential_sha256,
           capabilities, created_by
         ) VALUES (
           $1, $2, 1, 'delegated', $3, 1, $4, $5, $6, $7, $8::jsonb, $9
         )`,
        [
          connectionId,
          fixture.organizationId,
          endpoint,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          sealed.credentialSha256,
          JSON.stringify({
            qualified: true,
            lifecycle: true,
            ssh: true,
            preview: true,
            commandExecution: true,
            daytonaTarget: "eu",
          }),
          fixture.userId,
        ],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations
         SET provider_connection_id = $3
         WHERE workspace_id = $1 AND generation = 1 AND org_id = $2`,
        [fixture.workspaceId, fixture.organizationId, connectionId],
      );
    });

    const delegated = provider();
    let createdConfig: DaytonaWorkspaceProviderConfig | null = null;
    const resolver = new DatabaseDaytonaProviderResolver({
      pool,
      hostedProvider: provider(),
      hostedConfig,
      credentialKeys: { 1: encryptionKey },
      workosEnabled: false,
      providerFactory: (config) => {
        createdConfig = config;
        return delegated;
      },
    });
    await expect(
      resolver.resolve({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        purpose: "ssh",
      }),
    ).resolves.toMatchObject({
      provider: delegated,
      connectionId,
      connectionVersion: 1,
      credentialSource: "delegated",
    });
    expect(createdConfig).toMatchObject({
      apiKey: credential,
      apiUrl: endpoint,
      target: "eu",
      snapshotId: "snapshot-pinned",
    });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE provider_connections
         SET state = 'revoked', revoked_at = now() WHERE id = $1`,
        [connectionId],
      ),
    );
    await expect(
      resolver.resolve({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        purpose: "ssh",
      }),
    ).rejects.toMatchObject({ code: "provider_authority_revoked" });
    await expect(
      resolver.resolve({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        purpose: "cleanup",
      }),
    ).resolves.toMatchObject({ provider: delegated });
  });

  it("keeps an execution on its immutable credential version after the connection rotates", async () => {
    const encryptionKey = randomBytes(32).toString("base64url");
    const connectionId = randomUUID();
    const endpointV1 = "https://v1.daytona.example/api";
    const endpointV2 = "https://v2.daytona.example/api";
    const credentialV1 = "delegated-daytona-key-v1-0123456789";
    const credentialV2 = "delegated-daytona-key-v2-0123456789";
    const sealedV1 = sealCloudProviderCredential(
      credentialV1,
      {
        connectionId,
        organizationId: fixture.organizationId,
        version: 1,
        provider: "daytona",
        endpoint: endpointV1,
      },
      encryptionKey,
    );
    const sealedV2 = sealCloudProviderCredential(
      credentialV2,
      {
        connectionId,
        organizationId: fixture.organizationId,
        version: 2,
        provider: "daytona",
        endpoint: endpointV2,
      },
      encryptionKey,
    );
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO provider_connections (
           id, org_id, owner_kind, owner_user_id, provider, display_name,
           credential_source, current_version, state, capabilities, region
         ) VALUES (
           $1, $2, 'user', $3, 'daytona', 'Rotated Daytona', 'delegated', 1,
           'active', $4::jsonb, 'eu'
         )`,
        [
          connectionId,
          fixture.organizationId,
          fixture.userId,
          JSON.stringify({ qualified: true, lifecycle: true }),
        ],
      );
      for (const [version, endpoint, sealed] of [
        [1, endpointV1, sealedV1],
        [2, endpointV2, sealedV2],
      ] as const) {
        await tx.query(
          `INSERT INTO provider_connection_versions (
             connection_id, org_id, version, credential_source, endpoint,
             key_version, nonce, ciphertext, auth_tag, credential_sha256,
             capabilities, credential_expires_at, created_by
           ) VALUES (
             $1, $2, $3, 'delegated', $4, 1, $5, $6, $7, $8,
             $9::jsonb, $10, $11
           )`,
          [
            connectionId,
            fixture.organizationId,
            version,
            endpoint,
            sealed.nonce,
            sealed.ciphertext,
            sealed.authTag,
            sealed.credentialSha256,
            JSON.stringify({
              qualified: true,
              lifecycle: true,
              ssh: true,
              preview: true,
              commandExecution: true,
              daytonaTarget: version === 1 ? "v1-target" : "v2-target",
            }),
            new Date(Date.now() + version * 86_400_000),
            fixture.userId,
          ],
        );
      }
      await tx.query(
        `UPDATE cloud_workspace_generations
         SET provider_connection_id = $3, provider_connection_version = 1
         WHERE workspace_id = $1 AND generation = 1 AND org_id = $2`,
        [fixture.workspaceId, fixture.organizationId, connectionId],
      );
      await tx.query(
        `UPDATE provider_connections SET current_version = 2 WHERE id = $1`,
        [connectionId],
      );
    });

    const seen: DaytonaWorkspaceProviderConfig[] = [];
    const resolver = new DatabaseDaytonaProviderResolver({
      pool,
      hostedProvider: provider(),
      hostedConfig,
      credentialKeys: { 1: encryptionKey },
      workosEnabled: false,
      providerFactory: (config) => {
        seen.push(config);
        return provider();
      },
    });
    await expect(
      resolver.resolve({
        workspaceId: fixture.workspaceId,
        organizationId: fixture.organizationId,
        generation: 1,
        purpose: "lifecycle",
      }),
    ).resolves.toMatchObject({
      connectionId,
      connectionVersion: 1,
      credentialSource: "delegated",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      apiKey: credentialV1,
      apiUrl: endpointV1,
      target: "v1-target",
    });
  });
});

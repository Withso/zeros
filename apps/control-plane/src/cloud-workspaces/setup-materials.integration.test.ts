import { createHash, randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { retireCloudWorkspaceRuntimeAccess } from "./runtime-access.js";
import { DatabaseCloudWorkspaceSetupAdmissionBroker } from "./setup-admission-broker.js";
import {
  DatabaseCloudWorkspaceSetupMaterialService,
  sealCloudWorkspaceSetupSecret,
  type CloudWorkspaceRepositoryCredentialBroker,
} from "./setup-materials.js";
import type { CloudWorkspaceSetupExecution } from "./setup-worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;
const SETUP_AUDIENCE =
  "https://control.example.test/internal/v1/cloud-workspaces/setup/admission";
const ENGINE_AUDIENCE =
  "https://control.example.test/internal/v1/cloud-workspaces/engine/register";
const HEARTBEAT_AUDIENCE =
  "https://control.example.test/internal/v1/cloud-workspaces/engine/heartbeat";
const SECRET_KEY = randomBytes(32).toString("base64url");

type Seed = {
  execution: CloudWorkspaceSetupExecution;
  setupAdmission: Awaited<
    ReturnType<DatabaseCloudWorkspaceSetupAdmissionBroker["issue"]>
  >;
  secretId: string;
};

describe("cloud workspace setup material configuration", () => {
  const github: CloudWorkspaceRepositoryCredentialBroker = {
    mint: async () => ({
      token: "ghs_setup_repository_credential",
      expiresAtMs: Date.now() + 60 * 60_000,
    }),
    revoke: async () => undefined,
  };
  const construct = (jwksUrl: string) =>
    new DatabaseCloudWorkspaceSetupMaterialService({
      pool: {} as pg.Pool,
      setupAudience: SETUP_AUDIENCE,
      engineRegistrationAudience: ENGINE_AUDIENCE,
      engineHeartbeatAudience: HEARTBEAT_AUDIENCE,
      engineProtocolVersion: 11,
      enginePort: 39_393,
      setupSecretKeyV1: SECRET_KEY,
      github,
      accountIdentityProvider: "workos",
      accountAuth: {
        jwksUrl,
        audience: "https://api.example.test",
        issuers: ["https://identity.example.test/"],
        contract: "zeros-access-v1",
        clientId: "client_desktop_example",
      },
    });

  it("keeps credential-like query and fragment values out of sandbox auth URLs", () => {
    expect(() =>
      construct("https://identity.example.test/.well-known/jwks.json"),
    ).not.toThrow();
    expect(() =>
      construct("https://identity.example.test/.well-known/jwks.json?key=leak"),
    ).toThrow(/account authority/i);
    expect(() =>
      construct("https://identity.example.test/.well-known/jwks.json#leak"),
    ).toThrow(/account authority/i);
  });
});

d("cloud workspace setup material redemption", () => {
  let pool: pg.Pool;
  let seed: Seed;
  let github: CloudWorkspaceRepositoryCredentialBroker;
  let service: DatabaseCloudWorkspaceSetupMaterialService;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);

    const accountUserId = randomUUID();
    const accountEmail = `setup-materials-${accountUserId}@example.test`;
    const organizationId = randomUUID();
    const teamId = randomUUID();
    const workspaceId = randomUUID();
    const installationId = randomUUID();
    const secretId = randomUUID();
    const settings = {
      schemaVersion: 1,
      values: { browser: { enabled: false } },
      secretRefs: [{ id: secretId, name: "SETUP_REGISTRY_TOKEN" }],
      setupCommands: [{ command: "node --version", timeoutSeconds: 30 }],
    };
    const setup = await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO users (id, email, display_name)
         VALUES ($1, $2, 'Setup Materials Owner')`,
        [accountUserId, accountEmail],
      );
      await tx.query(
        `INSERT INTO user_identities (
           user_id, provider, provider_sub, email_at_link,
           email_verified_at, created_at
         ) VALUES
           ($1, 'workos', $2, $4, now(), now()),
           ($1, 'auth0', $3, $4, now(), now() + interval '1 second')`,
        [
          accountUserId,
          `identity|${accountUserId}`,
          `auth0-wrong-for-current-authority|${accountUserId}`,
          accountEmail,
        ],
      );
      await tx.query(
        `INSERT INTO organizations (
           id, slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, $2, 'Setup Materials', $3, false, true)`,
        [organizationId, `setup-materials-${randomUUID()}`, accountUserId],
      );
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, accountUserId],
      );
      await tx.query(
        `INSERT INTO teams (
           id, org_id, slug, name, is_default, created_by
         ) VALUES ($1, $2, 'default', 'Default', true, $3)`,
        [teamId, organizationId, accountUserId],
      );
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, organizationId, accountUserId],
      );
      await tx.query(
        `INSERT INTO github_authorizations (
           owner_user_id, app_variant, github_login
         ) VALUES ($1, 'github.com', 'setup-owner')`,
        [accountUserId],
      );
      await tx.query(
        `INSERT INTO github_installations (
           id, github_installation_id, app_variant, owner_user_id,
           account_login, account_type, target_type
         ) VALUES ($1, 987654, 'github.com', $2,
                   'withso', 'User', 'User')`,
        [installationId, accountUserId],
      );
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, github_installation_id, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Setup Materials Workspace',
                   'github.com', 'withso', 'zeros', 'refs/heads/main', $5,
                   'setting_up', 'running')`,
        [workspaceId, organizationId, teamId, accountUserId, installationId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snapshot-pinned-id',
                   'linux/amd64', 2000, 4096, 20480, $3, $4)`,
        [workspaceId, organizationId, "a".repeat(40), accountUserId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state
         ) VALUES ($1, 1, $2, 'daytona', $3, 'running')`,
        [workspaceId, organizationId, `sandbox-${workspaceId}`],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_specs (
           workspace_id, generation, org_id, repository_forge,
           repository_owner, repository_name, repository_revision,
           github_installation_id, settings_snapshot,
           settings_snapshot_sha256
         ) VALUES ($1, 1, $2, 'github.com', 'withso', 'zeros',
                   'refs/heads/main', $3, $4::jsonb,
                   digest($4::jsonb::text, 'sha256'))`,
        [workspaceId, organizationId, installationId, JSON.stringify(settings)],
      );
      const sealed = sealCloudWorkspaceSetupSecret(
        "registry-secret-value",
        {
          id: secretId,
          workspaceId,
          organizationId,
          generation: 1,
          name: "SETUP_REGISTRY_TOKEN",
        },
        SECRET_KEY,
      );
      await tx.query(
        `INSERT INTO cloud_workspace_setup_secrets (
           id, workspace_id, generation, org_id, name, key_version,
           nonce, ciphertext, auth_tag
         ) VALUES ($1, $2, 1, $3, $4, 1, $5, $6, $7)`,
        [
          secretId,
          workspaceId,
          organizationId,
          "SETUP_REGISTRY_TOKEN",
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
        ],
      );
      const run = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspace_setup_runs (
           workspace_id, generation, org_id, attempt, state, claim_count,
           execution_fence, lease_owner, lease_expires_at,
           last_heartbeat_at, started_at
         ) VALUES ($1, 1, $2, 1, 'running', 1, 5, 'setup-worker-test',
                   now() + interval '5 minutes', now(), now())
         RETURNING id`,
        [workspaceId, organizationId],
      );
      const settingsDigest = await tx.query<{ digest: string }>(
        `SELECT encode(settings_snapshot_sha256, 'hex') AS digest
         FROM cloud_workspace_setup_specs
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      return {
        setupRunId: run.rows[0]!.id,
        workspaceId,
        organizationId,
        authority: { accountUserId },
        generation: 1,
        attempt: 1,
        executionFence: 5,
        provider: {
          name: "daytona",
          resourceId: `sandbox-${workspaceId}`,
        },
        image: {
          ref: "snapshot-pinned-id",
          sourceCommit: "a".repeat(40),
        },
        repository: {
          forge: "github.com",
          owner: "withso",
          name: "zeros",
          revision: "refs/heads/main",
          githubInstallationId: installationId,
        },
        settings: {
          version: 1,
          snapshot: settings,
          sha256: settingsDigest.rows[0]!.digest,
        },
      } satisfies CloudWorkspaceSetupExecution;
    });

    const admissionBroker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: SETUP_AUDIENCE,
      ttlSeconds: 120,
    });
    const setupAdmission = await admissionBroker.issue(
      setup,
      new AbortController().signal,
    );
    seed = { execution: setup, setupAdmission, secretId };

    github = {
      mint: vi.fn(async () => ({
        token: "ghs_setup_repository_credential",
        expiresAtMs: Date.now() + 60 * 60_000,
      })),
      revoke: vi.fn(async () => undefined),
    };
    service = new DatabaseCloudWorkspaceSetupMaterialService({
      pool,
      setupAudience: SETUP_AUDIENCE,
      engineRegistrationAudience: ENGINE_AUDIENCE,
      engineHeartbeatAudience: HEARTBEAT_AUDIENCE,
      engineProtocolVersion: 11,
      enginePort: 39_393,
      setupSecretKeyV1: SECRET_KEY,
      github,
      accountIdentityProvider: "workos",
      accountAuth: {
        jwksUrl: "https://identity.example.test/.well-known/jwks.json",
        audience: "https://api.example.test",
        issuers: ["https://identity.example.test/"],
        contract: "zeros-access-v1",
        clientId: "client_desktop_example",
      },
    });
  });

  function redemptionInput() {
    const execution = seed.execution;
    return {
      token: seed.setupAdmission.token,
      workspaceId: execution.workspaceId,
      organizationId: execution.organizationId,
      generation: execution.generation,
      setupRunId: execution.setupRunId,
      executionFence: execution.executionFence,
      expected: {
        imageRef: execution.image.ref,
        imageSourceCommit: execution.image.sourceCommit!,
        repositoryRevision: execution.repository.revision,
        settingsVersion: execution.settings.version,
        settingsSha256: execution.settings.sha256,
      },
    };
  }

  it("redeems once into exact scoped materials and stores only engine credential digests", async () => {
    const materials = await service.redeem(redemptionInput());

    expect(materials).toMatchObject({
      version: 1,
      audience: "zeros-cloud-workspace-setup-materials-v1",
      execution: {
        workspaceId: seed.execution.workspaceId,
        setupRunId: seed.execution.setupRunId,
        executionFence: seed.execution.executionFence,
      },
      repository: {
        forge: "github.com",
        owner: "withso",
        name: "zeros",
        revision: "refs/heads/main",
        cloneUrl: "https://github.com/withso/zeros.git",
        credential: {
          username: "x-access-token",
          token: "ghs_setup_repository_credential",
        },
      },
      settings: {
        version: 1,
        snapshotSha256: seed.execution.settings.sha256,
        setupEnvironment: [
          { name: "SETUP_REGISTRY_TOKEN", value: "registry-secret-value" },
        ],
        setupCommands: [{ command: "node --version", timeoutSeconds: 30 }],
      },
      engine: {
        protocolVersion: 11,
        port: 39_393,
        ownerSubject: `identity|${seed.execution.authority.accountUserId}`,
        accountAuth: {
          jwksUrl: "https://identity.example.test/.well-known/jwks.json",
          audience: "https://api.example.test",
          issuers: ["https://identity.example.test/"],
          contract: "zeros-access-v1",
          clientId: "client_desktop_example",
        },
        registration: { endpoint: ENGINE_AUDIENCE },
      },
    });
    expect(materials.engine.bridgeToken).toMatch(/^zwb_[A-Za-z0-9_-]{43}$/);
    expect(materials.engine.readinessProbeToken).toMatch(
      /^zwr_[A-Za-z0-9_-]{43}$/,
    );
    expect(materials.engine.registration.token).toMatch(
      /^zws_[A-Za-z0-9_-]{43}$/,
    );
    const settingsBytes = Buffer.from(
      materials.settings.documentB64,
      "base64url",
    );
    expect(createHash("sha256").update(settingsBytes).digest("hex")).toBe(
      materials.settings.documentSha256,
    );
    expect(JSON.parse(settingsBytes.toString("utf8"))).toEqual(
      seed.execution.settings.snapshot,
    );

    const stored = await pool.query<{
      visible: string;
      bridge_hash: string;
      state: string;
    }>(
      `SELECT row_to_json(e)::text AS visible,
              encode(bridge_token_hash, 'hex') AS bridge_hash, state
       FROM cloud_workspace_engine_instances e WHERE id = $1`,
      [materials.engine.instanceId],
    );
    expect(stored.rows[0]).toMatchObject({
      state: "starting",
      bridge_hash: createHash("sha256")
        .update(materials.engine.bridgeToken)
        .digest("hex"),
    });
    expect(stored.rows[0]!.visible).not.toContain(materials.engine.bridgeToken);
    expect(stored.rows[0]!.visible).not.toContain(
      materials.engine.readinessProbeToken,
    );
    expect(stored.rows[0]!.visible).not.toContain(
      materials.engine.registration.token,
    );
    expect(stored.rows[0]!.visible).not.toContain("registry-secret-value");
    expect(github.mint).toHaveBeenCalledWith({
      installationId: 987654,
      owner: "withso",
      repository: "zeros",
    });

    await expect(service.redeem(redemptionInput())).rejects.toMatchObject({
      code: "setup_admission_rejected",
    });
    expect(github.mint).toHaveBeenCalledTimes(1);
  });

  it("does not consume a valid admission when the immutable request binding is wrong", async () => {
    await expect(
      service.redeem({
        ...redemptionInput(),
        executionFence: seed.execution.executionFence + 1,
      }),
    ).rejects.toMatchObject({ code: "setup_admission_rejected" });

    await expect(service.redeem(redemptionInput())).resolves.toMatchObject({
      audience: "zeros-cloud-workspace-setup-materials-v1",
    });
  });

  it("rejects setup when the repository owner is outside the installation account", async () => {
    await pool.query(
      `UPDATE github_installations
       SET account_login = 'different-owner'
       WHERE id = $1`,
      [seed.execution.repository.githubInstallationId],
    );

    await expect(service.redeem(redemptionInput())).rejects.toMatchObject({
      code: "setup_admission_rejected",
    });
    expect(github.mint).not.toHaveBeenCalled();
  });

  it("rechecks authority after GitHub mint and revokes a raced credential", async () => {
    vi.mocked(github.mint).mockImplementationOnce(async () => {
      await withSystemTx(pool, (tx) =>
        tx.query(
          `DELETE FROM team_members
           WHERE team_id = (SELECT team_id FROM cloud_workspaces WHERE id = $1)
             AND user_id = $2`,
          [seed.execution.workspaceId, seed.execution.authority.accountUserId],
        ),
      );
      return {
        token: "ghs_raced_repository_credential",
        expiresAtMs: Date.now() + 60 * 60_000,
      };
    });

    await expect(service.redeem(redemptionInput())).rejects.toMatchObject({
      code: "setup_authority_changed",
    });
    expect(github.revoke).toHaveBeenCalledWith(
      "ghs_raced_repository_credential",
    );
    const live = await pool.query(
      `SELECT 1 FROM cloud_workspace_engine_instances
       WHERE workspace_id = $1 AND state = 'starting'`,
      [seed.execution.workspaceId],
    );
    expect(live.rowCount).toBe(0);
  });

  it("revokes a minted repository credential whose provider lifetime is invalid", async () => {
    vi.mocked(github.mint).mockResolvedValueOnce({
      token: "ghs_invalid_lifetime_repository_credential",
      expiresAtMs: Date.now() + 24 * 60 * 60_000,
    });

    await expect(service.redeem(redemptionInput())).rejects.toMatchObject({
      code: "setup_repository_unavailable",
      retryable: true,
    });
    expect(github.revoke).toHaveBeenCalledWith(
      "ghs_invalid_lifetime_repository_credential",
    );
    const live = await pool.query(
      `SELECT 1 FROM cloud_workspace_engine_instances
       WHERE workspace_id = $1 AND state = 'starting'`,
      [seed.execution.workspaceId],
    );
    expect(live.rowCount).toBe(0);
  });

  it("revokes a minted repository credential when the final authority recheck cannot complete", async () => {
    vi.mocked(github.mint).mockImplementationOnce(async () => {
      await pool.query(
        `ALTER TABLE cloud_workspace_engine_instances
         RENAME TO unavailable_cloud_workspace_engine_instances`,
      );
      return {
        token: "ghs_authority_recheck_unknown_credential",
        expiresAtMs: Date.now() + 60 * 60_000,
      };
    });

    await expect(service.redeem(redemptionInput())).rejects.toMatchObject({
      code: "setup_repository_unavailable",
      retryable: true,
    });
    expect(github.revoke).toHaveBeenCalledWith(
      "ghs_authority_recheck_unknown_credential",
    );
  });

  it("registers the exact engine once, persists its heartbeat lease, and retires it with runtime access", async () => {
    const materials = await service.redeem(redemptionInput());
    const registration = await service.registerEngine({
      token: materials.engine.registration.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      setupRunId: seed.execution.setupRunId,
      executionFence: seed.execution.executionFence,
      engineInstanceId: materials.engine.instanceId,
      protocolVersion: 11,
    });
    expect(registration).toMatchObject({
      version: 1,
      audience: "zeros-cloud-workspace-engine-registration-v1",
      engineInstanceId: materials.engine.instanceId,
      durableRecordConnected: true,
      heartbeat: { endpoint: HEARTBEAT_AUDIENCE, intervalMs: 30_000 },
    });
    expect(registration.heartbeat.token).toMatch(/^zwh_[A-Za-z0-9_-]{43}$/);

    await expect(
      service.registerEngine({
        token: materials.engine.registration.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        setupRunId: seed.execution.setupRunId,
        executionFence: seed.execution.executionFence,
        engineInstanceId: materials.engine.instanceId,
        protocolVersion: 11,
      }),
    ).rejects.toMatchObject({ code: "engine_registration_rejected" });

    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
      }),
    ).resolves.toEqual({
      version: 1,
      audience: "zeros-cloud-workspace-engine-heartbeat-v1",
      accepted: true,
      engineInstanceId: materials.engine.instanceId,
      leaseExpiresAtMs: expect.any(Number),
    });

    vi.mocked(github.mint).mockResolvedValueOnce({
      token: "ghs_rotated_repository_credential",
      expiresAtMs: Date.now() + 60 * 60_000,
    });
    const refreshGeneration = "refresh-generation-000000000001";
    const rotated = await service.heartbeat({
      token: registration.heartbeat.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      engineInstanceId: materials.engine.instanceId,
      repositoryCredentialRefresh: {
        generation: refreshGeneration,
        requestedAtMs: Date.now(),
        ownerSubjectSha256: createHash("sha256")
          .update(`identity|${seed.execution.authority.accountUserId}`)
          .digest("hex"),
        method: "github-app",
        reason: "credential-invalid",
      },
    });
    expect(rotated).toMatchObject({
      accepted: true,
      repositoryCredential: {
        requestGeneration: refreshGeneration,
        outcome: "rotated",
        document: {
          audience: "zeros-cloud-github-credential-v1",
          method: "github-app",
          credential: {
            accessToken: "ghs_rotated_repository_credential",
            gitHost: "github.com",
          },
        },
      },
    });
    expect(github.mint).toHaveBeenLastCalledWith({
      installationId: 987654,
      owner: "withso",
      repository: "zeros",
    });
    const mintCountAfterRotation = vi.mocked(github.mint).mock.calls.length;
    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
        repositoryCredentialRefresh: {
          generation: refreshGeneration,
          // A lost HTTP response leaves the same durable request marker on the
          // engine. Replaying that marker must not mint on every heartbeat.
          requestedAtMs: Date.now() - 25 * 60 * 60_000,
          ownerSubjectSha256: createHash("sha256")
            .update(`identity|${seed.execution.authority.accountUserId}`)
            .digest("hex"),
          method: "github-app",
          reason: "credential-invalid",
        },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      repositoryCredential: {
        requestGeneration: refreshGeneration,
        outcome: "unavailable",
      },
    });
    expect(github.mint).toHaveBeenCalledTimes(mintCountAfterRotation);
    const persisted = await pool.query<{ document: string }>(
      `SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') AS document
       FROM cloud_workspace_engine_instances e
       WHERE id = $1`,
      [materials.engine.instanceId],
    );
    expect(persisted.rows[0]!.document).not.toContain(
      "ghs_rotated_repository_credential",
    );

    await pool.query(
      `UPDATE github_installations
       SET account_login = 'different-owner'
       WHERE id = $1`,
      [seed.execution.repository.githubInstallationId],
    );
    const mintCount = vi.mocked(github.mint).mock.calls.length;
    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
        repositoryCredentialRefresh: {
          generation: "refresh-generation-000000000002",
          requestedAtMs: Date.now(),
          ownerSubjectSha256: createHash("sha256")
            .update(`identity|${seed.execution.authority.accountUserId}`)
            .digest("hex"),
          method: "github-app",
          reason: "credential-invalid",
        },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      repositoryCredential: {
        requestGeneration: "refresh-generation-000000000002",
        outcome: "unavailable",
      },
    });
    expect(github.mint).toHaveBeenCalledTimes(mintCount);

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `SELECT 1 FROM cloud_workspaces WHERE id = $1 FOR UPDATE`,
        [seed.execution.workspaceId],
      );
      await retireCloudWorkspaceRuntimeAccess(tx, {
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        reason: "workspace_stop_requested",
      });
    });
    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
  });

  it("registers without deadlocking membership retirement on grant and engine locks", async () => {
    const materials = await service.redeem(redemptionInput());
    let releaseEngineLock!: () => void;
    let reportEngineLock!: () => void;
    const engineLockHeld = new Promise<void>((resolve) => {
      reportEngineLock = resolve;
    });
    const allowRegistrationToContinue = new Promise<void>((resolve) => {
      releaseEngineLock = resolve;
    });
    let intercepted = false;
    const racingPool = {
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") {
              return async (...args: unknown[]) => {
                const result = await (
                  target.query as (...queryArgs: unknown[]) => Promise<unknown>
                ).apply(target, args);
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (sql === "BEGIN") {
                  await target.query("SET LOCAL statement_timeout = '750ms'");
                }
                if (
                  !intercepted &&
                  sql.includes("FROM cloud_workspace_engine_instances") &&
                  sql.includes("state = 'starting'") &&
                  sql.includes("FOR UPDATE")
                ) {
                  intercepted = true;
                  reportEngineLock();
                  await allowRegistrationToContinue;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as pg.Pool;
    const racingService = new DatabaseCloudWorkspaceSetupMaterialService({
      pool: racingPool,
      setupAudience: SETUP_AUDIENCE,
      engineRegistrationAudience: ENGINE_AUDIENCE,
      engineHeartbeatAudience: HEARTBEAT_AUDIENCE,
      engineProtocolVersion: 11,
      enginePort: 39_393,
      setupSecretKeyV1: SECRET_KEY,
      github,
      accountIdentityProvider: "workos",
      accountAuth: {
        jwksUrl: "https://identity.example.test/.well-known/jwks.json",
        audience: "https://api.example.test",
        issuers: ["https://identity.example.test/"],
        contract: "zeros-access-v1",
        clientId: "client_desktop_example",
      },
    });
    const registration = racingService.registerEngine({
      token: materials.engine.registration.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      setupRunId: seed.execution.setupRunId,
      executionFence: seed.execution.executionFence,
      engineInstanceId: materials.engine.instanceId,
      protocolVersion: 11,
    });
    const membershipOwner = await pool.connect();
    let removal: ReturnType<typeof membershipOwner.query> | null = null;
    try {
      await engineLockHeld;
      const backend = await membershipOwner.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      removal = membershipOwner.query(
        `DELETE FROM team_members
         WHERE team_id = (SELECT team_id FROM cloud_workspaces WHERE id = $1)
           AND org_id = $2 AND user_id = $3`,
        [
          seed.execution.workspaceId,
          seed.execution.organizationId,
          seed.execution.authority.accountUserId,
        ],
      );
      await vi.waitFor(
        async () => {
          const waiting = await pool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [backend.rows[0]!.pid],
          );
          expect(waiting.rows[0]?.wait_event_type).toBe("Lock");
        },
        { timeout: 2_000, interval: 20 },
      );
      releaseEngineLock();

      await expect(registration).resolves.toMatchObject({
        engineInstanceId: materials.engine.instanceId,
        durableRecordConnected: true,
      });
      await removal;
    } finally {
      releaseEngineLock();
      if (removal) await removal.catch(() => undefined);
      membershipOwner.release();
    }

    await expect(
      pool.query<{ state: string }>(
        `SELECT state FROM cloud_workspace_engine_instances WHERE id = $1`,
        [materials.engine.instanceId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: "revoked" }] });
  });

  it("revokes engine heartbeat authority when its account loses Team membership", async () => {
    const materials = await service.redeem(redemptionInput());
    const registration = await service.registerEngine({
      token: materials.engine.registration.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      setupRunId: seed.execution.setupRunId,
      executionFence: seed.execution.executionFence,
      engineInstanceId: materials.engine.instanceId,
      protocolVersion: 11,
    });

    await pool.query(
      `DELETE FROM team_members
       WHERE team_id = (SELECT team_id FROM cloud_workspaces WHERE id = $1)
         AND org_id = $2 AND user_id = $3`,
      [
        seed.execution.workspaceId,
        seed.execution.organizationId,
        seed.execution.authority.accountUserId,
      ],
    );

    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
    await expect(
      pool.query<{ state: string; revoked_at: Date | null }>(
        `SELECT state, revoked_at FROM cloud_workspace_engine_instances
         WHERE id = $1`,
        [materials.engine.instanceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "revoked", revoked_at: expect.any(Date) }],
    });
  });

  it("revokes engine heartbeat authority when the account is deleted", async () => {
    const materials = await service.redeem(redemptionInput());
    const registration = await service.registerEngine({
      token: materials.engine.registration.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      setupRunId: seed.execution.setupRunId,
      executionFence: seed.execution.executionFence,
      engineInstanceId: materials.engine.instanceId,
      protocolVersion: 11,
    });

    await pool.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [
      seed.execution.authority.accountUserId,
    ]);

    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
    await expect(
      pool.query<{ state: string; revoked_at: Date | null }>(
        `SELECT state, revoked_at FROM cloud_workspace_engine_instances
         WHERE id = $1`,
        [materials.engine.instanceId],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "revoked", revoked_at: expect.any(Date) }],
    });
  });

  it("atomically cancels setup and engine authority when the organization is deleted", async () => {
    const materials = await service.redeem(redemptionInput());
    const registration = await service.registerEngine({
      token: materials.engine.registration.token,
      workspaceId: seed.execution.workspaceId,
      organizationId: seed.execution.organizationId,
      generation: seed.execution.generation,
      setupRunId: seed.execution.setupRunId,
      executionFence: seed.execution.executionFence,
      engineInstanceId: materials.engine.instanceId,
      protocolVersion: 11,
    });

    await pool.query(
      `UPDATE organizations SET deleted_at = now() WHERE id = $1`,
      [seed.execution.organizationId],
    );

    const authority = await pool.query(
      `SELECT cw.status, cw.desired_state,
              sr.state AS setup_state,
              sr.completed_at IS NOT NULL AS setup_completed,
              ei.state AS engine_state,
              ei.revoked_at IS NOT NULL AS engine_revoked,
              bool_and(eg.revoked_at IS NOT NULL) AS grants_revoked
       FROM cloud_workspaces cw
       JOIN cloud_workspace_setup_runs sr
         ON sr.workspace_id = cw.id AND sr.generation = cw.current_generation
       JOIN cloud_workspace_engine_instances ei
         ON ei.setup_run_id = sr.id
       JOIN cloud_workspace_endpoint_grants eg
         ON eg.workspace_id = cw.id AND eg.generation = cw.current_generation
       WHERE cw.id = $1
       GROUP BY cw.status, cw.desired_state, sr.state, sr.completed_at,
                ei.state, ei.revoked_at`,
      [seed.execution.workspaceId],
    );
    expect(authority.rows[0]).toEqual({
      status: "deleting",
      desired_state: "deleted",
      setup_state: "cancelled",
      setup_completed: true,
      engine_state: "revoked",
      engine_revoked: true,
      grants_revoked: true,
    });
    await expect(
      service.heartbeat({
        token: registration.heartbeat.token,
        workspaceId: seed.execution.workspaceId,
        organizationId: seed.execution.organizationId,
        generation: seed.execution.generation,
        engineInstanceId: materials.engine.instanceId,
      }),
    ).rejects.toMatchObject({ code: "engine_heartbeat_rejected" });
  });
});

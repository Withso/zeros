import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { ensureUser, type AuthedUser } from "../auth.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import { selectCloudProviderConnectionForNewGeneration } from "./provider-connections.js";
import { DaytonaProviderConnectionQualifier } from "./provider-qualification.js";
import {
  persistDatabaseCloudWorkspaceSettings,
  resolveDatabaseCloudWorkspaceSettings,
} from "./settings.js";
import { seedHostedCloudWorkspaceProviderConnection } from "./test-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const settingsKey = randomBytes(32).toString("base64url");
const providerKey = randomBytes(32).toString("base64url");
const config: CloudWorkspaceBackendConfig = {
  provider: "daytona",
  apiKey: "hosted-daytona-key-for-management-tests",
  apiUrl: "https://api.example.test",
  target: "eu",
  snapshotId: "snap-pinned",
  imageRef: "snap-pinned",
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  sourceCommit: "a".repeat(40),
  operationTimeoutSeconds: 30,
  autoArchiveMinutes: 10_080,
  reconcileIntervalMs: 1_000,
  providerCredentialKeys: { 1: providerKey },
  settingsSecretKeyV1: settingsKey,
  access: {
    allowedSshHosts: ["ssh.app.daytona.io"],
    allowedPreviewHostSuffixes: ["proxy.daytona.work"],
    previewBaseDomain: "cloud-preview.example.test",
  },
  durability: null,
  outbox: null,
  setupExecution: null,
};

d("cloud workspace Phase 5 management", () => {
  let pool: pg.Pool;
  let actor: AuthedUser;
  let orgId: string;
  let repositoryId: string;
  let workspaceId: string;
  let management: DatabaseCloudWorkspaceManagementService;
  const currentApiKey = vi.fn(async () => ({
    permissions: ["write:sandboxes", "delete:sandboxes"],
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
  }));

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    currentApiKey.mockClear();
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    actor = await ensureUser(pool, {
      provider: "auth0",
      providerSubject: randomUUID(),
      email: `management-${randomUUID()}@example.test`,
      displayName: "Management Owner",
    });
    const seeded = await withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Management Org', $2, false, true) RETURNING id`,
        [`management-${randomUUID()}`, actor.id],
      );
      const organizationId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, actor.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [organizationId, actor.id],
      );
      const childTeamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [childTeamId, organizationId, actor.id],
      );
      await tx.query(
        `INSERT INTO organization_entitlements (
           org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
         ) VALUES ($1, 'business', 'active', true, 1, 'operator')`,
        [organizationId],
      );
      await tx.query(
        `INSERT INTO organization_seat_assignments (org_id, user_id, state)
         VALUES ($1, $2, 'active')`,
        [organizationId, actor.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib
         ) VALUES ($1, 5, 5, 10000, 20480, 102400)`,
        [organizationId],
      );
      const repository = await tx.query<{ id: string }>(
        `INSERT INTO repositories (
           org_id, forge, forge_repository_id, owner_name, repository_name,
           created_by
         ) VALUES ($1, 'github.com', $2, 'withso', 'zeros', $3)
         RETURNING id`,
        [organizationId, randomUUID(), actor.id],
      );
      const childRepositoryId = repository.rows[0]!.id;
      const connectionId = await seedHostedCloudWorkspaceProviderConnection(tx, {
        organizationId,
        createdBy: actor.id,
      });
      const workspace = await tx.query<{ id: string }>(
        `INSERT INTO cloud_workspaces (
           org_id, team_id, created_by, display_name, repository_forge,
           repository_owner, repository_name, repository_revision,
           repository_id, owner_user_id, assignee_user_id,
           status, desired_state
         ) VALUES ($1, $2, $3, 'Managed', 'github.com', 'withso', 'zeros',
                   'main', $4, $3, $3, 'ready', 'running') RETURNING id`,
        [organizationId, childTeamId, actor.id, childRepositoryId],
      );
      const childWorkspaceId = workspace.rows[0]!.id;
      await tx.query(
        `INSERT INTO cloud_workspace_members (workspace_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [childWorkspaceId, organizationId, actor.id],
      );
      await tx.query(
        `INSERT INTO workspace_retention_policies (workspace_id, org_id)
         VALUES ($1, $2)`,
        [childWorkspaceId, organizationId],
      );
      await tx.query(
        `INSERT INTO workspace_billing_epochs (
           workspace_id, billing_epoch, org_id, billing_owner_user_id,
           entitlement_scope, entitlement_plan, entitlement_revision, created_by
         ) VALUES ($1, 1, $2, $3, 'organization', 'business', 1, $3)`,
        [childWorkspaceId, organizationId, actor.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib, created_by,
           provider_connection_id
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4)`,
        [childWorkspaceId, organizationId, actor.id, connectionId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider, provider_resource_id,
           observed_state, last_observed_at
         ) VALUES ($1, 1, $2, 'daytona', $3, 'running', now())`,
        [childWorkspaceId, organizationId, `sandbox-${childWorkspaceId}`],
      );
      return {
        organizationId,
        childRepositoryId,
        childWorkspaceId,
      };
    });
    orgId = seeded.organizationId;
    repositoryId = seeded.childRepositoryId;
    workspaceId = seeded.childWorkspaceId;
    management = new DatabaseCloudWorkspaceManagementService(pool, config, {
      workosEnabled: false,
      qualifier: new DaytonaProviderConnectionQualifier({
        clientFactory: () => ({ currentApiKey }),
      }),
    });
  });

  it("versions repository settings with optimistic concurrency and idempotent replay", async () => {
    const first = await management.putRepositorySettings({
      organizationId: orgId,
      repositoryId,
      actorUserId: actor.id,
      scope: "cloud",
      expectedVersion: 0,
      document: { values: { NODE_ENV: "development" } },
    });
    expect(first).toMatchObject({ version: 1, replayed: false });
    await expect(
      management.putRepositorySettings({
        organizationId: orgId,
        repositoryId,
        actorUserId: actor.id,
        scope: "cloud",
        expectedVersion: 0,
        document: { values: { NODE_ENV: "production" } },
      }),
    ).rejects.toMatchObject({ code: "cloud_settings_version_conflict" });
    await expect(
      management.putRepositorySettings({
        organizationId: orgId,
        repositoryId,
        actorUserId: actor.id,
        scope: "cloud",
        expectedVersion: 0,
        document: { values: { NODE_ENV: "development" } },
      }),
    ).resolves.toMatchObject({ version: 1, replayed: true });
  });

  it("keeps one unambiguous cloud-eligible default environment profile", async () => {
    const cloud = randomUUID();
    const both = randomUUID();
    await management.createEnvironmentProfile({
      id: cloud,
      organizationId: orgId,
      actorUserId: actor.id,
      name: "Cloud only",
      placement: "cloud",
      isDefault: true,
      document: { values: { PROFILE: "cloud" } },
    });
    await management.createEnvironmentProfile({
      id: both,
      organizationId: orgId,
      actorUserId: actor.id,
      name: "Everywhere",
      placement: "both",
      isDefault: true,
      document: { values: { PROFILE: "both" } },
    });
    const listed = (await management.listEnvironmentProfiles({
      organizationId: orgId,
      actorUserId: actor.id,
    })) as { profiles: Array<{ id: string; isDefault: boolean }> };
    expect(listed.profiles.filter((profile) => profile.isDefault)).toEqual([
      expect.objectContaining({ id: both }),
    ]);
  });

  it("inherits only consented personal values and never cross-tenant secrets or setup commands", async () => {
    const personalProfileId = randomUUID();
    const consentId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      const personal = await tx.query<{ id: string }>(
        `SELECT id FROM organizations
         WHERE created_by = $1 AND is_personal AND deleted_at IS NULL`,
        [actor.id],
      );
      const personalOrgId = personal.rows[0]!.id;
      await tx.query(
        `INSERT INTO environment_profiles (
           id, org_id, owner_kind, owner_user_id, name, placement,
           is_default, current_version
         ) VALUES ($1, $2, 'user', $3, 'Personal cloud', 'both', true, 1)`,
        [personalProfileId, personalOrgId, actor.id],
      );
      await tx.query(
        `INSERT INTO environment_profile_versions (
           profile_id, org_id, version, document, created_by
         ) VALUES ($1, $2, 1, $3::jsonb, $4)`,
        [
          personalProfileId,
          personalOrgId,
          JSON.stringify({
            values: {
              SAFE_THEME: "dark",
              PRIVATE_VALUE: "must-not-cross",
              nested: { allowed: true, blocked: true },
            },
            secretRefs: [{ id: randomUUID(), name: "PERSONAL_TOKEN" }],
            setupCommands: [{ command: "echo must-not-cross", timeoutSeconds: 10 }],
          }),
          actor.id,
        ],
      );
    });

    const created = await management.createPersonalProfileConsent({
      id: consentId,
      organizationId: orgId,
      actorUserId: actor.id,
      personalProfileId,
      personalProfileVersion: 1,
      allowedPaths: ["/values/SAFE_THEME", "/values/nested/allowed"],
      expiresAt: null,
    });
    expect(created).toMatchObject({ replayed: false });
    const inherited = await withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: orgId,
        repositoryId,
        workspaceId,
        generation: 1,
        actorUserId: actor.id,
        isPersonal: false,
        setupSecretKeyV1: settingsKey,
      }),
    );
    expect(inherited.resolved.snapshot).toEqual({
      schemaVersion: 1,
      values: { SAFE_THEME: "dark", nested: { allowed: true } },
    });
    expect(JSON.stringify(inherited)).not.toContain("must-not-cross");
    expect(inherited.sourceVersions).toMatchObject({
      inheritedPersonalProfiles: [
        { consentId, profileId: personalProfileId, version: 1 },
      ],
    });

    await expect(
      management.revokePersonalProfileConsent({
        id: consentId,
        organizationId: orgId,
        actorUserId: actor.id,
      }),
    ).resolves.toMatchObject({ consent: { state: "revoked" }, replayed: false });
    const afterRevocation = await withSystemTx(pool, (tx) =>
      resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: orgId,
        repositoryId,
        workspaceId,
        generation: 1,
        actorUserId: actor.id,
        isPersonal: false,
        setupSecretKeyV1: settingsKey,
      }),
    );
    expect(afterRevocation.resolved.snapshot.values).toEqual({});
  });

  it("stops stale generations and fences capabilities when managed policy changes", async () => {
    const accessId = randomUUID();
    const endpointId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      const resolved = await resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: orgId,
        repositoryId,
        workspaceId,
        generation: 1,
        actorUserId: actor.id,
        isPersonal: false,
        setupSecretKeyV1: settingsKey,
      });
      await persistDatabaseCloudWorkspaceSettings(tx, {
        workspaceId,
        organizationId: orgId,
        generation: 1,
        actorUserId: actor.id,
        settings: resolved,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_client_access_grants (
           id, workspace_id, generation, org_id, account_user_id, kind,
           remote_port, provider_resource_id, preview_proxy_label, token_hash,
           idempotency_key, request_sha256, state, requested_expires_at,
           expires_at, issued_at
         ) VALUES ($1, $2, 1, $3, $4, 'preview', 3000, $5, $6, $7,
                   $8, $9, 'active', now() + interval '15 minutes',
                   now() + interval '15 minutes', now())`,
        [
          accessId,
          workspaceId,
          orgId,
          actor.id,
          `sandbox-${workspaceId}`,
          randomBytes(16).toString("hex"),
          randomBytes(32),
          randomUUID(),
          randomBytes(32),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_endpoint_grants (
           id, workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, expires_at, account_revision,
           authorization_revision, authority_epoch
         )
         SELECT $1, workspace.id, 1, workspace.org_id, $2, 'engine-connect',
                'https://engine.example.test/connect', $3,
                now() + interval '5 minutes', account.auth_revision,
                member.authorization_revision, workspace.authority_epoch
         FROM cloud_workspaces workspace
         JOIN users account ON account.id = $2
         JOIN organization_members member
           ON member.org_id = workspace.org_id AND member.user_id = $2
         WHERE workspace.id = $4`,
        [endpointId, actor.id, randomBytes(32), workspaceId],
      );
    });

    const updated = await management.putOrganizationManagedPolicy({
      organizationId: orgId,
      actorUserId: actor.id,
      expectedVersion: 0,
      document: { values: { SECURITY_MODE: "strict" } },
    });
    expect(updated).toMatchObject({
      policy: { version: 1 },
      stoppedWorkspaceIds: [workspaceId],
      replayed: false,
    });
    const state = await withSystemTx(pool, (tx) =>
      tx.query(
        `SELECT workspace.status, workspace.desired_state,
                workspace.last_error_code,
                access.state AS access_state,
                endpoint.revoked_at IS NOT NULL AS endpoint_revoked,
                cloud_workspace_generation_policy_current(
                  workspace.id, workspace.current_generation, workspace.org_id
                ) AS policy_current
         FROM cloud_workspaces workspace
         JOIN cloud_workspace_client_access_grants access ON access.id = $2
         JOIN cloud_workspace_endpoint_grants endpoint ON endpoint.id = $3
         WHERE workspace.id = $1`,
        [workspaceId, accessId, endpointId],
      ),
    );
    expect(state.rows[0]).toEqual({
      status: "stopping",
      desired_state: "stopped",
      last_error_code: "managed_policy_changed",
      access_state: "revocation_pending",
      endpoint_revoked: true,
      policy_current: false,
    });
  });

  it("stops affected execution and fences live authority when a used secret is revoked", async () => {
    const bindingId = randomUUID();
    const created = await management.createSecretBinding({
      id: bindingId,
      organizationId: orgId,
      actorUserId: actor.id,
      name: "DEPLOY_TOKEN",
      purpose: "environment",
      placement: "cloud",
      value: "secret-value-that-must-never-be-returned",
    });
    expect(JSON.stringify(created)).not.toContain("secret-value");
    await management.createEnvironmentProfile({
      id: randomUUID(),
      organizationId: orgId,
      actorUserId: actor.id,
      name: "Cloud runtime",
      placement: "cloud",
      isDefault: true,
      document: {
        secretRefs: [{ id: bindingId, name: "DEPLOY_TOKEN" }],
      },
    });
    const accessId = randomUUID();
    const endpointId = randomUUID();
    await withSystemTx(pool, async (tx) => {
      const resolved = await resolveDatabaseCloudWorkspaceSettings(tx, {
        organizationId: orgId,
        repositoryId,
        workspaceId,
        generation: 1,
        actorUserId: actor.id,
        isPersonal: false,
        setupSecretKeyV1: settingsKey,
      });
      await persistDatabaseCloudWorkspaceSettings(tx, {
        workspaceId,
        organizationId: orgId,
        generation: 1,
        actorUserId: actor.id,
        settings: resolved,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_client_access_grants (
           id, workspace_id, generation, org_id, account_user_id, kind,
           remote_port, provider_resource_id, preview_proxy_label, token_hash,
           idempotency_key, request_sha256, state, requested_expires_at,
           expires_at, issued_at
         ) VALUES ($1, $2, 1, $3, $4, 'preview', 3000, $5, $6, $7,
                   $8, $9, 'active', now() + interval '15 minutes',
                   now() + interval '15 minutes', now())`,
        [
          accessId,
          workspaceId,
          orgId,
          actor.id,
          `sandbox-${workspaceId}`,
          randomBytes(16).toString("hex"),
          randomBytes(32),
          randomUUID(),
          randomBytes(32),
        ],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_endpoint_grants (
           id, workspace_id, generation, org_id, account_user_id, purpose,
           audience, token_hash, expires_at, account_revision,
           authorization_revision, authority_epoch
         )
         SELECT $1, workspace.id, 1, workspace.org_id, $2, 'engine-connect',
                'https://engine.example.test/connect', $3,
                now() + interval '5 minutes', account.auth_revision,
                member.authorization_revision, workspace.authority_epoch
         FROM cloud_workspaces workspace
         JOIN users account ON account.id = $2
         JOIN organization_members member
           ON member.org_id = workspace.org_id AND member.user_id = $2
         WHERE workspace.id = $4`,
        [endpointId, actor.id, randomBytes(32), workspaceId],
      );
    });

    const revoked = await management.revokeSecretBinding({
      id: bindingId,
      organizationId: orgId,
      actorUserId: actor.id,
      expectedVersion: 1,
    });
    expect(revoked).toMatchObject({
      binding: { id: bindingId, state: "revoked", version: 1 },
      stoppedWorkspaceIds: [workspaceId],
      replayed: false,
    });
    const state = await withSystemTx(pool, (tx) =>
      tx.query(
        `SELECT workspace.status, workspace.desired_state,
                access.state AS access_state,
                endpoint.revoked_at IS NOT NULL AS endpoint_revoked
         FROM cloud_workspaces workspace
         JOIN cloud_workspace_client_access_grants access ON access.id = $2
         JOIN cloud_workspace_endpoint_grants endpoint ON endpoint.id = $3
         WHERE workspace.id = $1`,
        [workspaceId, accessId, endpointId],
      ),
    );
    expect(state.rows[0]).toEqual({
      status: "stopping",
      desired_state: "stopped",
      access_state: "revocation_pending",
      endpoint_revoked: true,
    });
  });

  it("converges concurrent delegated-provider creation retries on one encrypted identity", async () => {
    const id = randomUUID();
    const apiKey = "daytona-concurrent-key-abcdefghijklmnopqrstuvwxyz";
    const input = {
      id,
      organizationId: orgId,
      actorUserId: actor.id,
      ownerKind: "organization" as const,
      displayName: "Concurrent Daytona",
      apiKey,
    };
    const results = await Promise.all([
      management.createProviderConnection(input),
      management.createProviderConnection(input),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(JSON.stringify(results)).not.toContain(apiKey);
    const stored = await withSystemTx(pool, (tx) =>
      tx.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM provider_connection_versions
         WHERE connection_id = $1`,
        [id],
      ),
    );
    expect(Number(stored.rows[0]!.count)).toBe(1);
  });

  it("returns the committed provider qualification when concurrent rotations converge", async () => {
    const id = randomUUID();
    await management.createProviderConnection({
      id,
      organizationId: orgId,
      actorUserId: actor.id,
      ownerKind: "organization",
      displayName: "Concurrent Rotation Daytona",
      apiKey: "daytona-initial-concurrent-rotation-abcdefghijklmnopqrstuvwxyz",
    });

    let qualificationCalls = 0;
    let releaseQualifications!: () => void;
    const bothQualified = new Promise<void>((resolve) => {
      releaseQualifications = resolve;
    });
    const concurrentApiKey = vi.fn(async () => {
      qualificationCalls += 1;
      const call = qualificationCalls;
      if (qualificationCalls === 2) releaseQualifications();
      await bothQualified;
      return {
        permissions: ["write:sandboxes", "delete:sandboxes"],
        expiresAt: new Date(Date.now() + call * 24 * 60 * 60_000),
      };
    });
    const concurrentManagement = new DatabaseCloudWorkspaceManagementService(
      pool,
      config,
      {
        workosEnabled: false,
        qualifier: new DaytonaProviderConnectionQualifier({
          clientFactory: () => ({ currentApiKey: concurrentApiKey }),
        }),
      },
    );
    const input = {
      id,
      organizationId: orgId,
      actorUserId: actor.id,
      expectedVersion: 1,
      apiKey: "daytona-concurrent-rotation-key-abcdefghijklmnopqrstuvwxyz",
    };
    const results = await Promise.all([
      concurrentManagement.rotateProviderConnection(input),
      concurrentManagement.rotateProviderConnection(input),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);

    const stored = await withSystemTx(pool, (tx) =>
      tx.query<{ expires_at: string | null }>(
        `SELECT capabilities ->> 'credentialExpiresAt' AS expires_at
         FROM provider_connections WHERE id = $1`,
        [id],
      ),
    );
    for (const result of results) {
      const connection = result.connection as {
        capabilities: { credentialExpiresAt: string | null };
      };
      expect(connection.capabilities.credentialExpiresAt).toBe(
        stored.rows[0]!.expires_at,
      );
    }
  });

  it("qualifies, encrypts, rotates, selects, and safely revokes delegated provider accounts", async () => {
    const id = randomUUID();
    const firstKey = "daytona-delegated-key-abcdefghijklmnopqrstuvwxyz";
    const created = await management.createProviderConnection({
      id,
      organizationId: orgId,
      actorUserId: actor.id,
      ownerKind: "organization",
      displayName: "Team Daytona",
      apiKey: firstKey,
    });
    expect(created).toMatchObject({
      connection: { id, credentialSource: "delegated", version: 1, state: "active" },
      replayed: false,
    });
    expect(JSON.stringify(created)).not.toContain(firstKey);
    const stored = await withSystemTx(pool, (tx) =>
      tx.query(
        `SELECT encode(version.credential_sha256, 'hex') AS sha256,
                position($2::text in version.ciphertext::text) > 0 AS leaked
         FROM provider_connection_versions version
         WHERE version.connection_id = $1 AND version.version = 1`,
        [id, firstKey],
      ),
    );
    expect(stored.rows[0]).toEqual({
      sha256: createHash("sha256").update(firstKey).digest("hex"),
      leaked: false,
    });
    const selected = await withSystemTx(pool, (tx) =>
      selectCloudProviderConnectionForNewGeneration(tx, {
        connectionId: id,
        organizationId: orgId,
        ownerUserId: actor.id,
        isPersonal: false,
        provider: "daytona",
      }),
    );
    expect(selected).toMatchObject({ id, credentialVersion: 1 });

    const secondKey = "daytona-delegated-key-rotated-abcdefghijklmnopqrstuvwxyz";
    await expect(
      management.rotateProviderConnection({
        id,
        organizationId: orgId,
        actorUserId: actor.id,
        expectedVersion: 1,
        apiKey: secondKey,
      }),
    ).resolves.toMatchObject({ connection: { version: 2 }, replayed: false });
    const revoked = await management.revokeProviderConnection({
      id,
      organizationId: orgId,
      actorUserId: actor.id,
      expectedVersion: 2,
    });
    expect(revoked).toMatchObject({ connection: { state: "revoked", version: 2 } });
    await expect(
      withSystemTx(pool, (tx) =>
        selectCloudProviderConnectionForNewGeneration(tx, {
          connectionId: id,
          organizationId: orgId,
          ownerUserId: actor.id,
          isPersonal: false,
          provider: "daytona",
        }),
      ),
    ).resolves.toBeNull();
    expect(currentApiKey).toHaveBeenCalledTimes(2);
  });
});

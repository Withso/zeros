import { createHash, randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";

/**
 * Seed the normalized identity/provider rows required by migrations 0026 and
 * 0027. Older cloud-workspace tests intentionally exercise low-level worker
 * services and therefore create rows directly instead of going through the
 * HTTP create route. Keeping their fixture authority explicit prevents those
 * tests from accidentally depending on migration backfills.
 */
export async function seedCanonicalCloudWorkspacePrerequisites(
  tx: Tx,
  input: {
    organizationId: string;
    ownerUserId: string;
    repositoryForge?: string;
    repositoryOwner?: string;
    repositoryName?: string;
    githubInstallationId?: string | null;
  },
): Promise<{ repositoryId: string; providerConnectionId: string }> {
  const repositoryId = randomUUID();
  const providerConnectionId = await seedHostedCloudWorkspaceProviderConnection(
    tx,
    {
      organizationId: input.organizationId,
      createdBy: input.ownerUserId,
    },
  );
  const forge = input.repositoryForge ?? "github.com";
  const owner = input.repositoryOwner ?? "withso";
  const name = input.repositoryName ?? "zeros";
  await tx.query(
    `INSERT INTO organization_entitlements (
       org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
     ) VALUES ($1, 'business', 'active', true, 100, 'operator')
     ON CONFLICT (org_id) DO NOTHING`,
    [input.organizationId],
  );
  await tx.query(
    `INSERT INTO organization_seat_assignments (
       org_id, user_id, state, assigned_by
     ) VALUES ($1, $2, 'active', $2)
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [input.organizationId, input.ownerUserId],
  );
  await tx.query(
    `INSERT INTO repositories (
       id, org_id, forge, forge_repository_id, identity_state,
       owner_name, repository_name, github_installation_id, created_by
     ) VALUES ($1, $2, $3, $4, 'verified', $5, $6, $7, $8)`,
    [
      repositoryId,
      input.organizationId,
      forge,
      `fixture:${randomUUID()}`,
      owner,
      name,
      input.githubInstallationId ?? null,
      input.ownerUserId,
    ],
  );
  return { repositoryId, providerConnectionId };
}

export async function seedHostedCloudWorkspaceProviderConnection(
  tx: Tx,
  input: { organizationId: string; createdBy: string },
): Promise<string> {
  const providerConnectionId = randomUUID();
  await tx.query(
    `INSERT INTO provider_connections (
       id, org_id, owner_kind, provider, display_name,
       credential_source, current_version, state
     ) VALUES ($1, $2, 'organization', 'daytona', 'Hosted Daytona',
               'hosted', 1, 'active')`,
    [providerConnectionId, input.organizationId],
  );
  await tx.query(
    `INSERT INTO provider_connection_versions (
       connection_id, org_id, version, credential_source, endpoint, created_by
     ) VALUES ($1, $2, 1, 'hosted', 'hosted://daytona', $3)`,
    [providerConnectionId, input.organizationId, input.createdBy],
  );
  return providerConnectionId;
}

export async function seedCanonicalCloudWorkspaceAuthority(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    ownerUserId: string;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cloud_workspace_members (workspace_id, org_id, user_id, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [input.workspaceId, input.organizationId, input.ownerUserId],
  );
  await tx.query(
    `INSERT INTO workspace_billing_epochs (
       workspace_id, billing_epoch, org_id, billing_owner_user_id,
       entitlement_scope, entitlement_plan, entitlement_revision, created_by
     ) SELECT $1, 1, $2, $3, 'organization', entitlement.plan::text,
              entitlement.revision, $3
       FROM organization_entitlements entitlement
       WHERE entitlement.org_id = $2
     ON CONFLICT (workspace_id, billing_epoch) DO NOTHING`,
    [input.workspaceId, input.organizationId, input.ownerUserId],
  );
}

export async function seedCanonicalWorkspaceSettingsVersion(
  tx: Tx,
  input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    createdBy: string;
    effectiveDocument: unknown;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO workspace_settings_versions (
       id, workspace_id, generation, org_id, effective_document,
       provenance, source_versions, created_by
     ) VALUES ($1, $2, $3, $4, $5::jsonb, '{}', '{"fixture":1}', $6)`,
    [
      id,
      input.workspaceId,
      input.generation,
      input.organizationId,
      JSON.stringify(input.effectiveDocument),
      input.createdBy,
    ],
  );
  return id;
}

export type ReadyCloudWorkspaceFixture = {
  userId: string;
  organizationId: string;
  teamId: string;
  repositoryId: string;
  workspaceId: string;
  engineInstanceId: string;
  heartbeatToken: string;
};

/** Canonical Phase-3 fixture. It deliberately seeds every current authority
 * edge instead of relying on legacy migration backfills. */
export async function seedReadyCloudWorkspace(
  pool: pg.Pool,
): Promise<ReadyCloudWorkspaceFixture> {
  const userId = randomUUID();
  const organizationId = randomUUID();
  const teamId = randomUUID();
  const repositoryId = randomUUID();
  const workspaceId = randomUUID();
  const providerConnectionId = randomUUID();
  const settingsVersionId = randomUUID();
  const setupRunId = randomUUID();
  const registrationGrantId = randomUUID();
  const engineInstanceId = randomUUID();
  const heartbeatToken = `zwh_${randomBytes(32).toString("base64url")}`;
  const bridgeToken = `zwb_${randomBytes(32).toString("base64url")}`;
  const email = `durable-${userId}@example.test`;

  await withSystemTx(pool, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, email, display_name)
       VALUES ($1, $2, 'Durable Workspace Owner')`,
      [userId, email],
    );
    await tx.query(
      `INSERT INTO user_identities (
         user_id, provider, provider_sub, email_at_link, email_verified_at
       ) VALUES ($1, 'workos', $2, $3, now())`,
      [userId, `workos|${userId}`, email],
    );
    await tx.query(
      `INSERT INTO account_entitlements (
         user_id, plan, status, cloud_workspaces_allowed, source
       ) VALUES ($1, 'pro', 'active', true, 'operator')`,
      [userId],
    );
    await tx.query(
      `INSERT INTO organizations (
         id, slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, $2, 'Durable Organization', $3, false, true)`,
      [organizationId, `durable-${organizationId}`, userId],
    );
    await tx.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [organizationId, userId],
    );
    await tx.query(
      `INSERT INTO teams (id, org_id, slug, name, is_default, created_by)
       VALUES ($1, $2, 'default', 'Default', true, $3)`,
      [teamId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'maintainer')`,
      [teamId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO organization_entitlements (
         org_id, plan, status, cloud_workspaces_allowed, seat_limit, source
       ) VALUES ($1, 'business', 'active', true, 5, 'operator')`,
      [organizationId],
    );
    await tx.query(
      `INSERT INTO organization_seat_assignments (
         org_id, user_id, assigned_by
       ) VALUES ($1, $2, $2)`,
      [organizationId, userId],
    );
    await tx.query(
      `INSERT INTO repositories (
         id, org_id, forge, forge_repository_id, identity_state,
         owner_name, repository_name, clone_url, web_url, default_branch,
         visibility, created_by
       ) VALUES (
         $1, $2, 'github.com', $3, 'verified', 'withso', 'zeros',
         'https://github.com/withso/zeros.git',
         'https://github.com/withso/zeros', 'main', 'private', $4
       )`,
      [repositoryId, organizationId, String(Date.now()), userId],
    );
    await tx.query(
      `INSERT INTO cloud_workspaces (
         id, org_id, team_id, created_by, display_name,
         repository_forge, repository_owner, repository_name,
         repository_revision, repository_id, owner_user_id, assignee_user_id,
         status, desired_state
       ) VALUES (
         $1, $2, $3, $4, 'Durable Workspace', 'github.com', 'withso',
         'zeros', 'main', $5, $4, $4, 'ready', 'running'
       )`,
      [workspaceId, organizationId, teamId, userId, repositoryId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_members (workspace_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')`,
      [workspaceId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO workspace_billing_epochs (
         workspace_id, billing_epoch, org_id, billing_owner_user_id,
         entitlement_scope, entitlement_plan, entitlement_revision, created_by
       ) SELECT $1, 1, $2, $3, 'organization', 'business', revision, $3
         FROM organization_entitlements WHERE org_id = $2`,
      [workspaceId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO provider_connections (
         id, org_id, owner_kind, provider, display_name,
         credential_source, current_version, state
       ) VALUES ($1, $2, 'organization', 'daytona', 'Hosted Daytona',
                 'hosted', 1, 'active')`,
      [providerConnectionId, organizationId],
    );
    await tx.query(
      `INSERT INTO provider_connection_versions (
         connection_id, org_id, version, credential_source, endpoint, created_by
       ) VALUES ($1, $2, 1, 'hosted', 'hosted://daytona', $3)`,
      [providerConnectionId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref, architecture,
         cpu_millicores, memory_mib, storage_mib, source_commit, created_by,
         provider_connection_id
       ) VALUES ($1, 1, $2, 'daytona', 'snapshot-pinned', 'linux/amd64',
                 2000, 4096, 20480, $3, $4, $5)`,
      [
        workspaceId,
        organizationId,
        "a".repeat(40),
        userId,
        providerConnectionId,
      ],
    );
    await tx.query(
      `INSERT INTO workspace_settings_versions (
         id, workspace_id, generation, org_id, effective_document,
         provenance, source_versions, created_by
       ) VALUES ($1, $2, 1, $3, '{"schemaVersion":1,"values":{}}',
                 '{}', '{"fixture":1}', $4)`,
      [settingsVersionId, workspaceId, organizationId, userId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_setup_specs (
         workspace_id, generation, org_id, repository_forge,
         repository_owner, repository_name, repository_revision,
         settings_snapshot, settings_snapshot_sha256,
         workspace_settings_version_id
       ) VALUES (
         $1, 1, $2, 'github.com', 'withso', 'zeros', 'main',
         '{"schemaVersion":1,"values":{}}',
         digest('{"schemaVersion":1,"values":{}}'::jsonb::text, 'sha256'), $3
       )`,
      [workspaceId, organizationId, settingsVersionId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_provider_bindings (
         workspace_id, generation, org_id, provider,
         provider_resource_id, observed_state, last_observed_at
       ) VALUES ($1, 1, $2, 'daytona', $3, 'running', now())`,
      [workspaceId, organizationId, `sandbox-${workspaceId}`],
    );
    await tx.query(
      `INSERT INTO workspace_executions (
         workspace_id, org_id, generation, authority_epoch, placement, state
       ) VALUES ($1, $2, 1, 1, 'cloud', 'active')`,
      [workspaceId, organizationId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_setup_runs (
         id, workspace_id, generation, org_id, attempt, state, claim_count,
         execution_fence, lease_owner, lease_expires_at, last_heartbeat_at,
         started_at
       ) VALUES ($1, $2, 1, $3, 1, 'running', 1, 1, 'fixture',
                 now() + interval '10 minutes', now(), now())`,
      [setupRunId, workspaceId, organizationId],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_endpoint_grants (
         id, workspace_id, generation, org_id, account_user_id, purpose,
         audience, token_hash, account_revision, authorization_revision,
         expires_at, consumed_at, setup_run_id, setup_execution_fence
       ) VALUES ($1, $2, 1, $3, $4, 'engine-connect', 'fixture', $5,
                 1, 1, now() + interval '10 minutes', now(), NULL, NULL)`,
      [
        registrationGrantId,
        workspaceId,
        organizationId,
        userId,
        createHash("sha256").update(randomUUID()).digest(),
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_engine_instances (
         id, workspace_id, generation, org_id, account_user_id, setup_run_id,
         setup_execution_fence, registration_grant_id, protocol_version,
         state, bridge_token_hash, heartbeat_token_hash, registered_at,
         last_heartbeat_at, lease_expires_at
       ) VALUES ($1, $2, 1, $3, $4, $5, 1, $6, 11, 'ready', $7, $8,
                 now(), now(), now() + interval '10 minutes')`,
      [
        engineInstanceId,
        workspaceId,
        organizationId,
        userId,
        setupRunId,
        registrationGrantId,
        createHash("sha256").update(bridgeToken).digest(),
        createHash("sha256").update(heartbeatToken).digest(),
      ],
    );
  });
  // Storage limits are database-owner operational state, so the production
  // application role cannot provision them. Integration fixtures use their
  // disposable database owner to establish an intentionally generous limit.
  await pool.query(
    `INSERT INTO cloud_workspace_object_storage_limits (
       org_id, max_organization_bytes, max_workspace_bytes, updated_by
     ) VALUES ($1, 107374182400, 10737418240, $2)`,
    [organizationId, userId],
  );
  return {
    userId,
    organizationId,
    teamId,
    repositoryId,
    workspaceId,
    engineInstanceId,
    heartbeatToken,
  };
}

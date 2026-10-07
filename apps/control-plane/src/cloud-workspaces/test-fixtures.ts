import { createHash, randomBytes, randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx, type Tx } from "../db.js";
import { ensureUser } from "../auth.js";
import { seedRuntimeGeneration, seedRuntimeBase, seedRuntimeBundle, runtimeBase, runtimeWitness } from "./runtime-test-fixtures.js";
import { seedComputerTemplate } from "./computer-workspace-test-fixtures.js";
import { cloudRuntimePinValues } from "./runtime-selection.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { ensureHostedCloudProviderConnection } from "./provider-connections.js";

/** Explicit owner-only fixture setup. Production application transactions
 * cannot grant personal Pro. Keep that distinction visible in integration tests. */
export async function withCloudFixtureOwnerTx<T>(pool:pg.Pool,fn:(tx:Tx)=>Promise<T>):Promise<T> {
  const client=await pool.connect();let discard=false;
  try{
    const authority=await client.query("SELECT current_user=pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.account_entitlements'::regclass");
    if(authority.rows[0]?.owner!==true)throw new Error("Cloud fixture requires the database owner");
    await client.query("BEGIN; SELECT set_config('app.system','on',true)");
    const result=await fn(client);await client.query("COMMIT");return result;
  }catch(error){await client.query("ROLLBACK").catch(()=>{discard=true;});throw error;}
  finally{client.release(discard);}
}

/** Disposable fixture erasure uses the same bound purge lease as the worker.
 * Restore a surviving organization so tests can prepare a workspace-free org. */
export async function withCloudFixturePurgeTx<T>(pool:pg.Pool,input:{organizationId:string;userId:string},fn:(tx:Tx)=>Promise<T>):Promise<T> {
  return withCloudFixtureOwnerTx(pool,async tx=>{
    const previous=(await tx.query<{lifecycle_status:string;deletion_request_id:string|null}>(
      "SELECT lifecycle_status,deletion_request_id FROM organizations WHERE id=$1 FOR UPDATE",[input.organizationId])).rows[0];
    if(!previous)throw new Error("Cloud purge fixture requires an organization");
    const requestId=randomUUID(),worker="cloud-fixture-erasure";
    await tx.query(`INSERT INTO deletion_requests(id,public_code,target_kind,target_id,target_organization_id,
      requested_by_user_id,state,requested_at,purge_after,purge_started_at,lease_owner,lease_expires_at,lease_revision)
      VALUES($1,$2,'organization',$3,$3,$4,'provider_deleting',now()-interval '31 days',
        now()-interval '1 day',now(),$5,now()+interval '1 minute',1)`,
      [requestId,`ZD-TEST-${requestId.slice(0,4).toUpperCase().replace(/[01]/g,"A")}`,input.organizationId,input.userId,worker]);
    await tx.query("UPDATE organizations SET lifecycle_status='purging',deletion_request_id=$2 WHERE id=$1",
      [input.organizationId,requestId]);
    await tx.query(`SELECT set_config('app.cloud_computer_v2_purge_request_id',$1,true),
      set_config('app.cloud_computer_v2_purge_worker_id',$2,true),
      set_config('app.cloud_computer_v2_purge_lease_revision','1',true)`,[requestId,worker]);
    const result=await fn(tx);
    await tx.query("UPDATE organizations SET lifecycle_status=$2,deletion_request_id=$3 WHERE id=$1",
      [input.organizationId,previous.lifecycle_status,previous.deletion_request_id]);
    await tx.query("DELETE FROM deletion_requests WHERE id=$1",[requestId]);
    return result;
  });
}

/** Loss evidence as the database-owner loss operator records it for a bound
 * journal. Unless `markLost` is false, the journal is then marked lost. */
export async function seedProviderLossAttestation(
  pool: pg.Pool,
  input: {
    provider: string; accountScope: string; workspaceId: string; generation?: number;
    resourceId: string; attestedBy: string; markLost?: boolean;
  },
): Promise<void> {
  const generation = input.generation ?? 1;
  await pool.query(`INSERT INTO cloud_workspace_provider_loss_attestations
    (provider,account_scope,workspace_id,generation,resource_id,id,attested_by,database_principal,target_fingerprint,reason,
     provider_account,inventory_sha256,inventory_observed_at,inventory_resource_count,lookup_observed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,current_user,'0123456789abcdef','Provider loss regression fixture',
      'fixture-account',$8,now(),0,now())`,
  [input.provider, input.accountScope, input.workspaceId, generation, input.resourceId, randomUUID(), input.attestedBy, Buffer.alloc(32)]);
  if (input.markLost !== false)
    await pool.query(`UPDATE cloud_workspace_provider_operations SET lost_at=clock_timestamp()
      WHERE provider=$1 AND account_scope=$2 AND workspace_id=$3 AND generation=$4`,
    [input.provider, input.accountScope, input.workspaceId, generation]);
}

/** Only the disposable database owner assigns staff; application transactions
 * deliberately cannot promote their own users. */
export async function ensureCloudPilotUser(
  pool: pg.Pool, input: Parameters<typeof ensureUser>[1],
): ReturnType<typeof ensureUser> {
  const user = await ensureUser(pool, input);
  await pool.query("UPDATE users SET staff_role = 'developer' WHERE id = $1", [user.id]);
  return user;
}

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
  input: { organizationId: string; createdBy: string; provider?: string },
): Promise<string> {
  const providerConnectionId = randomUUID();
  const provider = input.provider ?? "boat";
  await tx.query(
    `INSERT INTO provider_connections (
       id, org_id, owner_kind, provider, display_name,
       credential_source, current_version, state
     ) VALUES ($1, $2, 'organization', $3, 'Hosted fixture',
               'hosted', 1, 'active')`,
    [providerConnectionId, input.organizationId, provider],
  );
  await tx.query(
    `INSERT INTO provider_connection_versions (
       connection_id, org_id, version, credential_source, endpoint, created_by
     ) VALUES ($1, $2, 1, 'hosted', $4, $3)`,
    [providerConnectionId, input.organizationId, input.createdBy, `hosted://${provider}`],
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

/** Individual Pro fixture; historical Business fixtures remain unchanged. */
export async function seedReadyProCloudWorkspace(pool:pg.Pool,options:{ownerUserId?:string}={}):Promise<ReadyCloudWorkspaceFixture>{
  const fixture=await seedReadyCloudWorkspace(pool,options);
  await withSystemTx(pool,async tx=>{
    await tx.query("UPDATE workspace_billing_epochs SET ended_at=clock_timestamp() WHERE workspace_id=$1",[fixture.workspaceId]);
    await tx.query(`INSERT INTO workspace_billing_epochs(workspace_id,billing_epoch,org_id,billing_owner_user_id,
      entitlement_scope,entitlement_plan,entitlement_revision,created_by)
      SELECT $1,2,$2,$3,'account','pro',revision,$3 FROM cloud_workspace_pro_entitlement($3)`,[fixture.workspaceId,fixture.organizationId,fixture.userId]);
    await tx.query("UPDATE cloud_workspaces SET current_billing_epoch=2,single_member_mode=false,sharing_mode='organization' WHERE id=$1",[fixture.workspaceId]);
  });
  return fixture;
}

/** Canonical Phase-3 fixture. It deliberately seeds every current authority
 * edge instead of relying on legacy migration backfills. */
/** Supported execution fixture, with immutable generation/source INSERTs.
 * Historical fixtures opt out explicitly; production never fabricates a source. */
export async function seedSupportedCloudWorkspaceGeneration(tx: Tx, input: {
  workspaceId: string; organizationId: string; ownerUserId: string; generation?: number; providerConnectionId?: string;
  computerSource?: Pick<Parameters<typeof seedComputerTemplate>[1], "installationId" | "repositories">;
}) {
  const generation = input.generation ?? 1;
  await seedRuntimeBase(tx);
  if (!(await tx.query("SELECT 1 FROM cloud_runtime_bundles WHERE runtime_id=$1", [runtimeWitness.runtimeId])).rowCount)
    await seedRuntimeBundle(tx);
  const version = Number((await tx.query<{ next_version: string }>(
    "SELECT next_version FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE", [input.organizationId])).rows[0]?.next_version ?? 1);
  const source = await seedComputerTemplate(tx, { ...input,
    installationId: input.computerSource?.installationId ?? randomUUID(), repositories: input.computerSource?.repositories ?? [],
    version,
    sourceSandboxId: `zeros-v2-test-template-${input.workspaceId}-${generation}` });
  const providerConnectionId = input.providerConnectionId ?? (await ensureHostedCloudProviderConnection(tx, {
    organizationId: input.organizationId, ownerUserId: input.ownerUserId, actorUserId: input.ownerUserId,
    isPersonal: false, provider: "boat",
  })).id;
  const pin = { runtimeId: runtimeWitness.runtimeId, manifestSha256: runtimeWitness.manifestSha256,
    baseImageId: runtimeBase.id, baseCompatibilityId: runtimeBase.compatibilityId,
    profile: "zeros-cloud-worker-v4" as const, engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION };
  await tx.query(`INSERT INTO cloud_workspace_generations
    (workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
     created_by,provider_connection_id,runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
    VALUES($1,$2,$3,'boat',$4,'linux/amd64',2000,4096,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [input.workspaceId, generation, input.organizationId, `boat-template:${source.sourceSandboxId}`, runtimeBase.storageMiB,
    runtimeBase.sourceCommit, input.ownerUserId, providerConnectionId, ...cloudRuntimePinValues(pin)]);
  // The fixture does not author checkout content. Preserve the nullable historic
  // checkout field, while pinning the exact valid Computer build/config.
  await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
    VALUES($1,$2,$3,$4,$4,$5)`, [input.workspaceId,generation,input.organizationId,source.buildId,source.configId]);
  return { pin, providerConnectionId, source };
}

export async function seedReadyCloudWorkspace(
  pool: pg.Pool,
  options: {ownerUserId?:string; runtimeV4?: boolean; supportedGeneration?: boolean; persistedProvider?: string; persistedSandboxClass?: "container" | "linux-vm";
    computerSource?: Pick<Parameters<typeof seedComputerTemplate>[1], "installationId" | "repositories">} = {},
): Promise<ReadyCloudWorkspaceFixture> {
  const userId = options.ownerUserId ?? randomUUID();
  const organizationId = randomUUID();
  const teamId = randomUUID();
  const repositoryId = randomUUID();
  const workspaceId = randomUUID();
  let providerConnectionId = "";
  const settingsVersionId = randomUUID();
  const setupRunId = randomUUID();
  const registrationGrantId = randomUUID();
  const engineInstanceId = randomUUID();
  const heartbeatToken = `zwh_${randomBytes(32).toString("base64url")}`;
  const bridgeToken = `zwb_${randomBytes(32).toString("base64url")}`;
  const email = `durable-${userId}@example.test`;

  if(!options.ownerUserId) await pool.query(
      `INSERT INTO users (id, email, display_name, staff_role)
       VALUES ($1, $2, 'Durable Workspace Owner', 'developer')`,
      [userId, email],
  );
  await withCloudFixtureOwnerTx(pool, async (tx) => {
    // These ready fixtures exercise fake provider/runtime seams. Preserve their
    // unmetered setup without changing the production Boat requirement. Metered
    // suites enable the requirement explicitly after seeding their first fixture.
    await tx.query(`UPDATE managed_compute_provider_requirements SET require_credit=false
      WHERE provider='boat' AND NOT EXISTS (SELECT 1 FROM cloud_workspace_generations)`);

    if(!options.ownerUserId) {
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
    }
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
    const supported = options.runtimeV4 !== false && options.supportedGeneration !== false &&
      (options.persistedProvider === undefined || options.persistedProvider === "boat") && options.persistedSandboxClass === undefined;
    const runtime = supported ? await seedSupportedCloudWorkspaceGeneration(tx, { workspaceId, organizationId, ownerUserId: userId,
      ...(options.computerSource ? { computerSource: options.computerSource } : {}) })
      : options.runtimeV4 ? await seedRuntimeGeneration(tx, { workspaceId, organizationId, ownerUserId: userId }) : null;
    providerConnectionId = runtime?.providerConnectionId ?? await seedHostedCloudWorkspaceProviderConnection(
      tx,
      {
        organizationId,
        createdBy: userId, provider: options.persistedProvider ?? "boat",
      },
    );
    if (!runtime) await tx.query(
      `INSERT INTO cloud_workspace_generations (
         workspace_id, generation, org_id, provider, image_ref, architecture,
         cpu_millicores, memory_mib, storage_mib, source_commit, created_by,
         provider_connection_id, sandbox_class
       ) VALUES ($1, 1, $2, $6, 'snapshot-pinned', 'linux/amd64',
                 2000, 4096, 20480, $3, $4, $5, $7)`,
      [
        workspaceId,
        organizationId,
        "a".repeat(40),
        userId,
        providerConnectionId, options.persistedProvider ?? "boat", options.persistedSandboxClass ?? null,
      ],
    );
    await tx.query(
      `INSERT INTO workspace_settings_versions (
         id, workspace_id, generation, org_id, effective_document,
         provenance, source_versions, created_by
       ) VALUES ($1, $2, 1, $3, '{"schemaVersion":1,"values":{}}',
                 '{}', $5::jsonb, $4)`,
      [settingsVersionId, workspaceId, organizationId, userId,
        JSON.stringify(supported && runtime && "source" in runtime ? { fixture: 1, computerEnvironment: { configId: runtime.source.configId, bindings: [] } } : { fixture: 1 })],
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
       ) VALUES ($1, 1, $2, $4, $3, 'running', now())`,
      [workspaceId, organizationId, `sandbox-${workspaceId}`, options.persistedProvider ?? "boat"],
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
       ) VALUES ($1, $2, 1, $3, $4, $6, 'fixture', $5,
                 1, 1, now() + interval '10 minutes', now(), $7, $8)`,
      [
        registrationGrantId,
        workspaceId,
        organizationId,
        userId,
        createHash("sha256").update(randomUUID()).digest(),
        runtime ? "setup" : "engine-connect",
        runtime ? setupRunId : null,
        runtime ? 1 : null,
      ],
    );
    await tx.query(
      `INSERT INTO cloud_workspace_engine_instances (
         id, workspace_id, generation, org_id, account_user_id, setup_run_id,
         setup_execution_fence, registration_grant_id, protocol_version,
         state, bridge_token_hash, heartbeat_token_hash, registered_at,
         last_heartbeat_at, lease_expires_at
         ${runtime ? ", actor_protocol_version, agent_customization_version, runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile, runtime_engine_protocol_version, runtime_installer_receipt_sha256, runtime_boot_id, runtime_supervisor_session_id" : ""}
       ) VALUES ($1, $2, 1, $3, $4, $5, 1, $6, $9, 'ready', $7, $8,
                 now(), now(), now() + interval '10 minutes' ${runtime ? ", 2, 3, $10,$11,$12,$13,$14,$15,$16,$17,$18" : ""})`,
      [
        engineInstanceId,
        workspaceId,
        organizationId,
        userId,
        setupRunId,
        registrationGrantId,
        createHash("sha256").update(bridgeToken).digest(),
        createHash("sha256").update(heartbeatToken).digest(),
        runtime ? CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION : 11,
        ...(runtime ? [...cloudRuntimePinValues(runtime.pin), runtimeWitness.installerReceiptSha256, runtimeWitness.bootId, runtimeWitness.supervisorSessionId] : []),
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

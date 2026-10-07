import {withCloudFixtureOwnerTx} from "./test-fixtures.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import pg from "pg";

import type { AuthedUser } from "../auth.js";
import { ensureCloudPilotUser as ensureUser } from "./test-fixtures.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { DatabaseCloudWorkspaceManagementService } from "./management.js";
import {
  persistDatabaseCloudWorkspaceSettings,
  resolveDatabaseCloudWorkspaceSettings,
} from "./settings.js";
import { seedCanonicalWorkspaceSettingsVersion,seedReadyCloudWorkspace,seedSupportedCloudWorkspaceGeneration } from "./test-fixtures.js";
import {DatabaseCloudWorkspaceCollaborationService} from "./actors.js";
import {CloudWorkspaceCheckpointRequestWorker,enqueueWorkspaceCheckpointRequest} from "./checkpoint-requests.js";
import {assertDatabaseLockOrder} from "./lock-order-test-utils.js";
import { retainCloudDiagnostic } from "./cloud-diagnostic-store.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const settingsKey = randomBytes(32).toString("base64url");
const config: CloudWorkspaceBackendConfig = {
  provider: "boat",
  apiKey: "hosted-boat-key-for-management-tests",
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
  settingsSecretEncryptionKeys: { 1: settingsKey },
  currentSettingsSecretEncryptionKeyVersion: 1,
  settingsSecretKeyV1: settingsKey,
  access: {
    allowedSshHosts: ["ssh.fixture.test"],
    allowedPreviewHostSuffixes: ["preview.fixture.test"],
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


  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=false WHERE provider='boat'");
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
      await seedSupportedCloudWorkspaceGeneration(tx, {
        workspaceId: childWorkspaceId, organizationId, ownerUserId: actor.id,
      });
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider, provider_resource_id,
           observed_state, last_observed_at
         ) VALUES ($1, 1, $2, 'boat', $3, 'running', now())`,
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
    });
  });

  it("projects outage stops in management history while preserving the legacy stored reason", async () => {
    const id = await retainCloudDiagnostic(pool, {
      workspaceId, organizationId: orgId, generation: 1, operationKind: "engine", operationId: randomUUID(),
    }, { phase: "provider_inspect", code: "provider_request_failed", errorClass: "provider", retryable: true,
      httpClass: "5xx", stopReason: "provider_outage", decision: "direct_stop" });
    expect(id).not.toBeNull();
    expect((await pool.query("SELECT reason FROM cloud_workspace_diagnostic_incidents WHERE id=$1", [id])).rows[0].reason).toBe("safety_failure");
    const result = await management.workspaceOverview({ organizationId: orgId, workspaceId, actorUserId: actor.id });
    expect(result.incidents).toEqual([expect.objectContaining({ id, reason: "provider_outage",
      message: "Workspace stopped because a provider outage exhausted its compute lease runway" })]);
    expect(JSON.stringify(result.incidents)).not.toContain("provider_request_failed");
  });

  it("expires final checkpoints without reversing lifecycle request locks",async()=>{
    const intentId=randomUUID();
    const request=await withSystemTx(pool,async tx=>{
      await tx.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
        VALUES($1,$2,1,$3,$4,'stop',$5,$6)`,[intentId,workspaceId,orgId,actor.id,randomUUID(),Buffer.alloc(32,0x61)]);
      const queued=await enqueueWorkspaceCheckpointRequest(tx,{workspaceId,organizationId:orgId,generation:1,requestedBy:actor.id,lifecycleIntentId:intentId,reason:"before_stop",idempotencyKey:randomUUID()});
      await tx.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '10 minutes',deadline_at=now()-interval '1 second' WHERE id=$1",[queued.id]);
      return queued;
    });
    await assertDatabaseLockOrder(pool,{
      parentSql:"SELECT id FROM cloud_workspace_lifecycle_intents WHERE id=$1 FOR UPDATE",parentId:intentId,
      childSql:"SELECT id FROM workspace_checkpoint_requests WHERE id=$1 FOR UPDATE",childId:request.id,
      parentQuery:/FROM organizations|UPDATE cloud_workspace_lifecycle_intents/,
      action:controlled=>new CloudWorkspaceCheckpointRequestWorker(controlled).expireOnce(),
    });
    expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1",[request.id])).rows[0]).toEqual({state:"expired"});
    expect((await pool.query("SELECT state FROM cloud_workspace_lifecycle_intents WHERE id=$1",[intentId])).rows[0]).toEqual({state:"failed"});
  });

  it.each(["organizations","cloud_workspaces"])("expires another workspace while %s is locked",async(table)=>{
    const other=await seedReadyCloudWorkspace(pool);
    const original=await withSystemTx(pool,async tx=>{
      const ids=[];
      for(const scope of [{workspaceId,organizationId:orgId,userId:actor.id},other]){
        const request=await enqueueWorkspaceCheckpointRequest(tx,{workspaceId:scope.workspaceId,organizationId:scope.organizationId,generation:1,requestedBy:scope.userId,reason:"manual",idempotencyKey:randomUUID()});
        await tx.query("UPDATE workspace_checkpoint_requests SET created_at=now()-interval '10 minutes',deadline_at=now()-interval '1 second' WHERE id=$1",[request.id]);ids.push(request.id);
      }return ids[0]!;
    });
    const blocker=await pool.connect();
    try{
      await blocker.query("BEGIN");await blocker.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[table==="organizations"?orgId:workspaceId]);
      expect(await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce()).toBe(1);
      expect((await pool.query("SELECT state FROM workspace_checkpoint_requests WHERE id=$1",[original])).rows[0].state).toBe("queued");
    }finally{await blocker.query("ROLLBACK");blocker.release();}
    expect(await new CloudWorkspaceCheckpointRequestWorker(pool).expireOnce()).toBe(1);
  });

  it("shares bounded runtime metadata without exposing sponsor settings or organization quota",async()=>{
    const collaborator=await ensureUser(pool,{provider:"auth0",providerSubject:randomUUID(),email:`reader-${randomUUID()}@example.test`,displayName:"Workspace Reader"});
    await withSystemTx(pool,async tx=>{
      await tx.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1",[workspaceId]);
      await tx.query("UPDATE organization_entitlements SET seat_limit=2 WHERE org_id=$1",[orgId]);
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[orgId,collaborator.id]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[orgId,collaborator.id]);
    });
    const queries=vi.spyOn(pg.Client.prototype,"query");
    let result:Awaited<ReturnType<typeof management.workspaceOverview>>;
    try {
      result=await management.workspaceOverview({organizationId:orgId,workspaceId,actorUserId:collaborator.id});
      expect(queries.mock.calls.some(call=>typeof call[0]==="string"&&call[0].includes("FROM cloud_workspace_usage_events"))).toBe(false);
    } finally {queries.mockRestore();}
    expect(result.workspace).toMatchObject({id:workspaceId});
    expect(result.settings).toBeNull();expect(result.compute).toBeNull();expect(result.quota).toBeNull();
    expect(result.usage).toEqual([]);expect(result.checkpoints).toEqual([]);
    await expect(management.updateRetention({organizationId:orgId,workspaceId,actorUserId:collaborator.id,expectedVersion:1,
      recordEventDays:30,contentEventDays:7,checkpointDays:30,exportDays:7})).rejects.toMatchObject({status:404});
  });

  it("lets a shared administrator manage retention after sponsor disablement",async()=>{
    const admin=await ensureUser(pool,{provider:"auth0",providerSubject:randomUUID(),email:`admin-${randomUUID()}@example.test`,displayName:"Workspace Administrator"});
    await withSystemTx(pool,async tx=>{
      await tx.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1",[workspaceId]);
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'admin')",[orgId,admin.id]);
      await tx.query("UPDATE users SET auth_status='identity_disabled' WHERE id=$1",[actor.id]);
    });
    await expect(management.updateRetention({organizationId:orgId,workspaceId,actorUserId:admin.id,expectedVersion:1,
      recordEventDays:30,contentEventDays:7,checkpointDays:30,exportDays:7})).resolves.toHaveProperty("retention");
  });

  it("redacts populated sponsor settings and compute metadata from an exact-workspace guest",async()=>{
    const guest=await ensureUser(pool,{provider:'workos',providerSubject:`user_${randomUUID()}`,email:`guest-${randomUUID()}@example.test`,displayName:'External Guest'});
    const sentinel='private-sponsor-setting-and-provider';
    await withCloudFixtureOwnerTx(pool,async tx=>{
      await tx.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1",[workspaceId]);
      await tx.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",[guest.id]);
      await seedCanonicalWorkspaceSettingsVersion(tx,{workspaceId,organizationId:orgId,generation:1,createdBy:actor.id,
        effectiveDocument:{schemaVersion:1,values:{PRIVATE_SETTING:sentinel},setupCommands:[sentinel],secretRefs:[{name:sentinel}]}});
      await tx.query("UPDATE provider_connections SET display_name=$2 WHERE org_id=$1",[orgId,sentinel]);
    });
    const scope={workspaceId,organizationId:orgId,actorUserId:actor.id},collaboration=new DatabaseCloudWorkspaceCollaborationService(pool);
    const invitation=await collaboration.invite({...scope,email:guest.email,role:'viewer'});
    await collaboration.accept({actorUserId:guest.id,identity:guest.identity,token:invitation.token});
    const ownerOverview=await management.workspaceOverview(scope);expect(JSON.stringify(ownerOverview)).toContain(sentinel);
    const guestOverview=await management.workspaceOverview({...scope,actorUserId:guest.id});
    expect(guestOverview).toMatchObject({workspace:{id:workspaceId},settings:null,compute:null,quota:null,usage:[],exports:[],replicas:[],forwards:[]});
    expect(JSON.stringify(guestOverview)).not.toContain(sentinel);
    expect((await pool.query('SELECT 1 FROM organization_members WHERE org_id=$1 AND user_id=$2',[orgId,guest.id])).rowCount).toBe(0);
    await collaboration.revokeGuest({...scope,guestUserId:guest.id});
    await expect(management.workspaceOverview({...scope,actorUserId:guest.id})).rejects.toMatchObject({status:404});
  });

  it("does not lend a manual checkpoint receipt to another collaborator",async()=>{
    const collaborator=await ensureUser(pool,{provider:"auth0",providerSubject:randomUUID(),email:`checkpoint-${randomUUID()}@example.test`,displayName:"Checkpoint Collaborator"});
    await withSystemTx(pool,async tx=>{
      await tx.query("UPDATE cloud_workspaces SET sharing_mode='organization',single_member_mode=false WHERE id=$1",[workspaceId]);
      await tx.query("UPDATE organization_entitlements SET seat_limit=2 WHERE org_id=$1",[orgId]);
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')",[orgId,collaborator.id]);
      await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,state) VALUES($1,$2,'active')",[orgId,collaborator.id]);
    });
    const idempotencyKey=randomUUID(),input={organizationId:orgId,workspaceId,idempotencyKey};
    await management.requestCheckpoint({...input,actorUserId:actor.id});
    await expect(management.requestCheckpoint({...input,actorUserId:collaborator.id})).rejects.toMatchObject({status:409,code:"idempotency_key_reused"});
  });

  it("reports retired provider storage until its deletion is verified", async () => {
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET observed_state = 'stopped', updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         ) SELECT workspace_id, 2, org_id, provider, image_ref,
                  architecture, cpu_millicores, memory_mib, storage_mib,
                  source_commit, created_by, provider_connection_id
           FROM cloud_workspace_generations
           WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state, last_observed_at
         ) VALUES ($1, 2, $2, 'boat', $3, 'running', now())`,
        [workspaceId, orgId, `sandbox-${workspaceId}-2`],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'ready', updated_at = now()
         WHERE id = $1`,
        [workspaceId],
      );
    });

    const beforeDeletion = (await management.workspaceOverview({
      organizationId: orgId,
      workspaceId,
      actorUserId: actor.id,
    })) as {
      quota: {
        allocation: {
          workspaces: number;
          runningWorkspaces: number;
          cpuMillicores: number;
          memoryMiB: number;
          storageMiB: number;
        };
      };
    };
    expect(beforeDeletion.quota.allocation).toEqual({
      workspaces: 1,
      runningWorkspaces: 1,
      cpuMillicores: 2000,
      memoryMiB: 4096,
      storageMiB: 40960,
    });

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspace_provider_bindings
         SET observed_state = 'deleted', deletion_verified_at = now(),
             last_observed_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND generation = 1`,
        [workspaceId],
      ),
    );
    const afterDeletion = (await management.workspaceOverview({
      organizationId: orgId,
      workspaceId,
      actorUserId: actor.id,
    })) as typeof beforeDeletion;
    expect(afterDeletion.quota.allocation.storageMiB).toBe(20480);
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
            setupCommands: [
              { command: "echo must-not-cross", timeoutSeconds: 10 },
            ],
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
      setupCommands: [],
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
    ).resolves.toMatchObject({
      consent: { state: "revoked" },
      replayed: false,
    });
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
    await withCloudFixtureOwnerTx(pool, async tx => {
      // The immutable fixture config must explicitly pin the used binding.
      // Production never adds a reference to an already accepted config.
      await tx.query("SET LOCAL session_replication_role=replica");
      await tx.query(`INSERT INTO cloud_computer_environment_refs(config_id,org_id,name,binding_id,binding_version)
        SELECT config_id,org_id,'DEPLOY_TOKEN',$2,1 FROM cloud_workspace_computer_sources WHERE workspace_id=$1`, [workspaceId,bindingId]);
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

  it("stores only keyed secret verifiers and rekeys legacy binding material through rotation", async () => {
    const bindingId = randomUUID();
    const value = "low-entropy-but-valid-secret";
    await management.createSecretBinding({
      id: bindingId,
      organizationId: orgId,
      actorUserId: actor.id,
      name: "DATABASE_URL",
      purpose: "environment",
      placement: "cloud",
      value,
    });

    const stored = await pool.query<{
      key_version: number;
      verifier_scheme: number;
      value_verifier: Buffer;
    }>(
      `SELECT key_version, verifier_scheme, value_verifier
       FROM secret_binding_versions
       WHERE binding_id = $1 AND version = 1`,
      [bindingId],
    );
    expect(stored.rows[0]).toMatchObject({
      key_version: 1,
      verifier_scheme: 1,
    });
    expect(stored.rows[0]!.value_verifier).not.toEqual(
      createHash("sha256").update(value, "utf8").digest(),
    );
    await expect(
      pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'secret_binding_versions'
           AND column_name = 'value_sha256'`,
      ),
    ).resolves.toMatchObject({ rows: [] });

    // Migration 0056 intentionally leaves legacy ciphertext without a raw
    // digest. Authenticated decryption remains the compatibility check.
    await pool.query(
      `UPDATE secret_binding_versions
       SET verifier_scheme = 0, value_verifier = NULL
       WHERE binding_id = $1 AND version = 1`,
      [bindingId],
    );
    await expect(
      management.createSecretBinding({
        id: bindingId,
        organizationId: orgId,
        actorUserId: actor.id,
        name: "DATABASE_URL",
        purpose: "environment",
        placement: "cloud",
        value,
      }),
    ).resolves.toMatchObject({ replayed: true });

    const nextKey = randomBytes(32).toString("base64url");
    const rotatedManagement = new DatabaseCloudWorkspaceManagementService(
      pool,
      {
        ...config,
        settingsSecretEncryptionKeys: { 1: settingsKey, 2: nextKey },
        currentSettingsSecretEncryptionKeyVersion: 2,
      },
      { workosEnabled: false },
    );
    await expect(
      rotatedManagement.rotateSecretBinding({
        id: bindingId,
        organizationId: orgId,
        actorUserId: actor.id,
        expectedVersion: 1,
        value,
      }),
    ).resolves.toMatchObject({
      binding: { version: 2 },
      replayed: false,
    });
    await expect(
      pool.query(
        `SELECT version, key_version, verifier_scheme
         FROM secret_binding_versions
         WHERE binding_id = $1 ORDER BY version`,
        [bindingId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { version: expect.anything(), key_version: 1, verifier_scheme: 0 },
        { version: expect.anything(), key_version: 2, verifier_scheme: 1 },
      ],
    });
  });

  it("rejects customer provider creation and rotation with a controlled compatibility error", async () => {
    await expect(management.createProviderConnection({
      id: randomUUID(), organizationId: orgId, actorUserId: actor.id,
      ownerKind: "organization", displayName: "Customer compute", apiKey: "fixture-provider-key",
    })).rejects.toMatchObject({ status: 503, code: "cloud_provider_not_configured" });
    await expect(management.rotateProviderConnection({
      id: randomUUID(), organizationId: orgId, actorUserId: actor.id,
      expectedVersion: 1, apiKey: "fixture-provider-key",
    })).rejects.toMatchObject({ status: 503, code: "cloud_provider_not_configured" });
    const connections = await management.listProviderConnections({ organizationId: orgId, actorUserId: actor.id });
    expect(connections).toMatchObject({ connections: [expect.objectContaining({ credentialSource: "hosted", state: "active" })] });
  });

});

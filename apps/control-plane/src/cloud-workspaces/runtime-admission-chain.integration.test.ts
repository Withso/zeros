import {withCloudFixtureOwnerTx} from "./test-fixtures.js";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { withSystemTx } from "../db.js";
import { ensureUser } from "../auth.js";
import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import {
  manageCloudAgentRuntime,
  type CloudAgentRuntimeChange,
} from "../manage-cloud-agent-runtime.js";
import { createCloudWorkspaceRoutes } from "./routes.js";
import { createCloudWorkspaceInternalRoutes } from "./internal-routes.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";
import { DatabaseCloudWorkspaceSetupAdmissionBroker } from "./setup-admission-broker.js";
import { DatabaseCloudWorkspaceSetupMaterialService } from "./setup-materials.js";
import { DatabaseCloudWorkspaceEngineClientAdmissionService } from "./engine-client-admission.js";
import { DatabaseCloudWorkspaceDurableRecordService } from "./durable-record.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { DatabaseCloudAgentExecutionService } from "./agent-executions.js";
import { DatabaseCloudWorkspaceCommandService } from "./commands.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import type {
  CloudProviderResource,
  CloudWorkspaceProvider,
} from "./provider.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { CloudRuntimeRegistration } from "../../../desktop/src/engine/cloud-runtime-registration.js";
import { CloudWorkspaceAccessClient } from "../../../desktop/electron/cloud-workspace-access-client.js";

const url = process.env.TEST_DATABASE_URL,
  d = url ? describe : describe.skip;
const IMAGE = "11111111-1111-4111-8111-111111111111",
  ORIGIN = "https://control.example.test",
  CONTRACT = "b".repeat(64);
const cloudConfig: CloudWorkspaceBackendConfig = {
  provider: "daytona",
  apiKey: "daytona-api-key-for-integration-tests",
  apiUrl: "https://api.example.test",
  target: "eu",
  snapshotId: IMAGE,
  imageRef: IMAGE,
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  sourceCommit: "a".repeat(40),
  operationTimeoutSeconds: 30,
  autoArchiveMinutes: 10_080,
  reconcileIntervalMs: 1_000,
  providerCredentialKeys: {},
  settingsSecretEncryptionKeys: {},
  currentSettingsSecretEncryptionKeyVersion: null,
  settingsSecretKeyV1: null,
  access: {
    allowedSshHosts: ["ssh.app.daytona.io"],
    allowedPreviewHostSuffixes: ["proxy.daytona.work"],
    previewBaseDomain: "cloud-preview.example.test",
  },
  durability: null,
  outbox: null,
  setupExecution: null,
};

d("normal shared cloud runtime admission chain", () => {
  let pool: pg.Pool;
  let runtime: CloudRuntimeRegistration | undefined;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 6 });
  });
  afterAll(async () => {
    await runtime?.stop();
    await pool.end();
  });
  it("creates, reconciles, registers the real client and admits two devices and an exact delegated execution without SQL runtime patches", async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool);
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_${randomUUID()}`,
      email: `runtime-${randomUUID()}@example.test`,
      displayName: "Runtime owner",
      session: {
        id: `session_${randomUUID()}`,
        clientKind: "desktop",
        authTime: Math.floor(Date.now() / 1000),
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    owner.accountRevision = Number(
      (
        await pool.query(
          "UPDATE users SET staff_role='platform_owner' WHERE id=$1 RETURNING auth_revision",
          [owner.id],
        )
      ).rows[0].auth_revision,
    );
    await pool.query(
      "INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [owner.authentication.sessionId, owner.identity.subject, owner.id],
    );
    let orgId: string, installationId: string;
    const seeded = await withSystemTx(pool, async (tx) => {
      const organization = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Cloud Org', $2, false, true) RETURNING id`,
        [`cloud-${randomUUID()}`, owner.id],
      );
      const organizationId = organization.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [organizationId, owner.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (
           org_id, slug, name, is_default, created_by
         ) VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [organizationId, owner.id],
      );
      const defaultTeamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [defaultTeamId, organizationId, owner.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_quotas (
           org_id, max_workspaces, max_running_workspaces,
           max_cpu_millicores, max_memory_mib, max_storage_mib
         ) VALUES ($1, 5, 5, 10000, 20480, 102400)`,
        [organizationId],
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
        [organizationId, owner.id],
      );
      await tx.query(
        `INSERT INTO github_authorizations (
           owner_user_id, app_variant, github_login
         ) VALUES ($1, 'github.com', 'owner')`,
        [owner.id],
      );
      const installation = await tx.query<{ id: string }>(
        `INSERT INTO github_installations (
           github_installation_id, app_variant, owner_user_id,
           account_login, account_type, target_type
         ) VALUES (123456, 'github.com', $1, 'withso', 'User', 'User')
         RETURNING id`,
        [owner.id],
      );
      return {
        organizationId,
        defaultTeamId,
        installationId: installation.rows[0]!.id,
      };
    });
    orgId = seeded.organizationId;
    installationId = seeded.installationId;

    await withCloudFixtureOwnerTx(pool, async (tx) => {
      await tx.query(
        "UPDATE organization_entitlements SET plan='pro',seat_limit=NULL WHERE org_id=$1",
        [orgId],
      );
      await tx.query(
        "INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')",
        [owner.id],
      );
      await tx.query(
        "INSERT INTO workos_organization_links(organization_id,workos_organization_id,external_id,state) VALUES($1,$2,$3,'active')",
        [orgId, `org_${randomUUID()}`, orgId],
      );
    });
    const sessions = new DatabaseCloudWorkspaceEngineClientAdmissionService({
      pool,
      endpoint:
        ORIGIN + "/internal/v1/cloud-workspaces/engine/client-admission",
      enginePort: 39393,
      workosEnabled: true,
      relayEnabled: true,
    });
    const encryption = {
      keys: { 1: randomBytes(32).toString("base64url") },
      currentKeyVersion: 1,
    };
    const executions = new DatabaseCloudAgentExecutionService(
      pool,
      encryption,
      true,
    );
    const materials = new DatabaseCloudWorkspaceSetupMaterialService({
      pool,
      setupAudience: ORIGIN + "/internal/v1/cloud-workspaces/setup/admission",
      engineRegistrationAudience:
        ORIGIN + "/internal/v1/cloud-workspaces/engine/register",
      engineHeartbeatAudience:
        ORIGIN + "/internal/v1/cloud-workspaces/engine/heartbeat",
      engineProtocolVersion: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
      enginePort: 39393,
      setupSecretKeyV1: randomBytes(32).toString("base64url"),
      github: {
        mint: async () => ({
          token: "ghs_synthetic_repository_credential",
          expiresAtMs: Date.now() + 3600000,
        }),
        revoke: async () => {},
      },
      accountIdentityProvider: "workos",
      accountAuth: {
        jwksUrl: "https://identity.example.test/.well-known/jwks.json",
        audience: "https://api.example.test",
        issuers: ["https://identity.example.test/"],
        contract: "zeros-access-v1",
        clientId: "client_desktop_example",
      },
    });
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof HttpError)
        return c.json({ error: { code: error.code } }, error.status);
      throw error;
    });
    app.use("/v1/*", async (c, next) => {
      c.set("user", owner);
      await next();
    });
    app.route(
      "/",
      createCloudWorkspaceRoutes(pool, cloudConfig, {
        workosEnabled: true,
        engineClientAdmissionService: sessions,
        repositoryResolver: {
          resolve: async () => ({
            forge: "github.com",
            forgeRepositoryId: "123456789",
            owner: "withso",
            name: "zeros",
            cloneUrl: "https://github.com/withso/zeros.git",
            webUrl: "https://github.com/withso/zeros",
            defaultBranch: "main",
            visibility: "private",
          }),
        },
      }),
    );
    app.route(
      "/",
      createCloudWorkspaceInternalRoutes({
        redeem: (input) => materials.redeem(input),
        registerEngine: (input) => materials.registerEngine(input),
        heartbeat: (input) => materials.heartbeat(input),
        admitActorClient: (input) => sessions.consumeActor(input),
        admitEngineClient: (input) => sessions.consume(input),
        agentExecutions: executions,
        commands: new DatabaseCloudWorkspaceCommandService({ pool, workosEnabled: true }),
      }),
    );
    const fetcher: typeof fetch = async (input, init) =>
      app.fetch(new Request(input, init));
    const response = await app.request(
      `/v1/organizations/${orgId}/cloud-workspaces`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({
          name: "Shared runtime",
          repository: {
            forge: "github.com",
            owner: "withso",
            name: "zeros",
            revision: "main",
            githubInstallationId: installationId,
          },
        }),
      },
    );
    const created = await response.json();
    expect(response.status, JSON.stringify(created)).toBe(202);
    const workspaceId = created.workspace.id;
    expect(
      (
        await pool.query(
          "SELECT sharing_mode,single_member_mode FROM cloud_workspaces WHERE id=$1",
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ sharing_mode: "organization", single_member_mode: false });
    expect(
      (
        await pool.query(
          "SELECT entitlement_scope,billing_owner_user_id FROM workspace_billing_epochs WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({
      entitlement_scope: "account",
      billing_owner_user_id: owner.id,
    });
    const resources = new Map<string, CloudProviderResource>();
    const provider: CloudWorkspaceProvider = {
      name: "daytona",
      find: async (identity) =>
        [...resources.values()].filter(
          (row) =>
            row.workspaceId === identity.workspaceId &&
            row.generation === identity.generation,
        ),
      create: async (input) => {
        const row: CloudProviderResource = {
          resourceId: randomUUID(),
          state: "running",
          target: "eu",
          workspaceId: input.workspaceId,
          generation: input.generation,
          metadata: {},
        };
        resources.set(row.resourceId, row);
        return row;
      },
      inspect: async (id) => resources.get(id) ?? null,
      start: async (id) => resources.get(id)!,
      stop: async (id) => ({ ...resources.get(id)!, state: "stopped" }),
      archive: async (id) => ({ ...resources.get(id)!, state: "archived" }),
      delete: async (id) => {
        resources.delete(id);
      },
      async *listManaged() {
        yield* resources.values();
      },
    };
    const reconciler = new CloudWorkspaceReconciler({
      pool,
      provider,
      intervalMs: 1000,
      workosEnabled: true,
      logger: { info() {}, warn() {}, error() {} },
    });
    expect(await reconciler.runOnce()).toBe(true);
    const records = new DatabaseCloudWorkspaceDurableRecordService({
      pool,
      workosEnabled: true,
    });
    const broker = new DatabaseCloudWorkspaceSetupAdmissionBroker({
      pool,
      endpoint: ORIGIN + "/internal/v1/cloud-workspaces/setup/admission",
      ttlSeconds: 120,
      workosEnabled: true,
    });
    const setup = new CloudWorkspaceSetupWorker({
      pool,
      intervalMs: 1000,
      workosEnabled: true,
      sanitizeLog: () => "",
      logger: { info() {}, warn() {}, error() {} },
      executor: {
        execute: async (execution, signal) => {
          const grant = await broker.issue(execution, signal);
          const redeemed = await materials.redeem({
            token: grant.token,
            ...(Object.fromEntries(
              [
                "workspaceId",
                "organizationId",
                "generation",
                "setupRunId",
                "executionFence",
              ].map((key) => [key, execution[key as keyof typeof execution]]),
            ) as Pick<
              typeof execution,
              | "workspaceId"
              | "organizationId"
              | "generation"
              | "setupRunId"
              | "executionFence"
            >),
            materialVersion: 2,
            expected: {
              imageRef: execution.image.ref,
              imageSourceCommit: execution.image.sourceCommit!,
              repositoryRevision: execution.repository.revision,
              settingsVersion: execution.settings.version,
              settingsSha256: execution.settings.sha256,
            },
          });
          runtime = new CloudRuntimeRegistration(
            {
              version: 1,
              audience: "zeros-cloud-engine-runtime-v1",
              execution: redeemed.execution,
              engine: {
                instanceId: redeemed.engine.instanceId,
                protocolVersion: redeemed.engine.protocolVersion,
                readinessProbeToken: redeemed.engine.readinessProbeToken,
              },
              registration: redeemed.engine.registration,
            },
            {
              agentRuntime: {
                profile: "zeros-cloud-worker-v3",
                contractSha256: CONTRACT,
              },
              fetch: fetcher,
              onAuthorityLost: () => {},
              onDurableRecordSync: async (authority) => {
                await records.headForEngine({
                  ...authority,
                  afterEntityKind: null,
                  afterEntityId: null,
                });
              },
            },
          );
          await runtime.start();
          return {
            logExcerpt: "",
            readiness: {
              version: 1,
              ...redeemed.execution,
              image: {
                ref: execution.image.ref,
                sourceCommit: execution.image.sourceCommit!,
              },
              repository: {
                revision: execution.repository.revision,
                commit: "c".repeat(40),
              },
              settings: {
                version: execution.settings.version,
                sha256: execution.settings.sha256,
              },
              engine: {
                instanceId: redeemed.engine.instanceId,
                protocolVersion: redeemed.engine.protocolVersion,
                health: "ready",
                durableRecordConnected: true,
              },
            },
          };
        },
      },
    });
    expect(await setup.runOnce()).toBe(true);
    expect(runtime?.readiness()?.health).toBe("ready");
    expect(
      (
        await pool.query("SELECT status FROM cloud_workspaces WHERE id=$1", [
          workspaceId,
        ])
      ).rows[0].status,
    ).toBe("ready");
    expect(
      (
        await pool.query(
          "SELECT actor_protocol_version,agent_runtime_profile,agent_runtime_contract_sha256 FROM cloud_workspace_engine_instances WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0],
    ).toMatchObject({
      actor_protocol_version: 2,
      agent_runtime_profile: "zeros-cloud-worker-v3",
      agent_runtime_contract_sha256: CONTRACT,
    });
    async function device() {
      const pair = generateKeyPairSync("ed25519"),
        publicKey = Buffer.from(
          pair.publicKey.export({ format: "jwk" }).x!,
          "base64url",
        );
      const id = (
        await pool.query(
          "INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Device','macos',$2,$3) RETURNING id",
          [
            owner.id,
            publicKey,
            createHash("sha256").update(publicKey).digest(),
          ],
        )
      ).rows[0].id;
      return new CloudWorkspaceAccessClient({
        baseUrl: ORIGIN,
        fetch: fetcher,
        signEngineAdmission: async (_token, target) => {
          const fields = {
            deviceId: id,
            keyVersion: 1,
            timestampMs: Date.now(),
            nonce: randomBytes(24).toString("base64url"),
          };
          return {
            ...fields,
            signature: sign(
              null,
              cloudWorkspaceDeviceProofMessage({
                ...fields,
                accountUserId: owner.id,
                action: "engine.connect",
                payload: target,
              }),
              pair.privateKey,
            ).toString("base64url"),
          };
        },
      });
    }
    const desktop = await device(),
      second = await device(),
      target = { organizationId: orgId, workspaceId };
    const grant = await desktop.issueEngineAdmission(
        "synthetic-account-token",
        target,
      ),
      otherGrant = await second.issueEngineAdmission(
        "synthetic-account-token",
        target,
      );
    const actor = await runtime!.verifyClientAdmission(grant.grantToken),
      otherActor = await runtime!.verifyClientAdmission(otherGrant.grantToken);
    expect(actor?.actor?.sessionId).toBeTypeOf("string");
    expect(otherActor?.actor?.sessionId).not.toBe(actor?.actor?.sessionId);
    const credentials = new DatabaseCloudAgentCredentialService(
        pool,
        encryption,
      ),
      credentialId = randomUUID(),
      delegationId = randomUUID();
    await credentials.put({
      ownerUserId: owner.id,
      credentialId,
      operationId: randomUUID(),
      expectedRevision: 0,
      displayName: "Synthetic qualification key",
      material: {
        kind: "cursor-api-key",
        apiKey: "synthetic-cursor-key-for-qualification",
      },
    });
    await credentials.delegate(owner.id, {
      id: delegationId,
      credentialId,
      expectedRevision: 1,
      workspaceId,
      granteeUserId: owner.id,
      models: ["grok-4.6"],
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const commandId = randomUUID(), executionId = randomUUID(), claimId = randomUUID();
    await runtime!.commandRequest({ kind: "mutate", mutation: {
      conversationId: "normal-runtime-chain", operationId: randomUUID(), expectedRevision: 0,
      action: { kind: "enqueue", commandId, payload: {
        agentId: "cursor", model: "grok-4.6", agentCredentialGrantId: delegationId,
        userMessageId: randomUUID(), modeRevision: 0, effort: "xhigh", fast: false,
        prompt: [{ type: "text", text: "Synthetic command admission qualification" }],
      } },
    } }, actor!.actor!.sessionId);
    expect(await runtime!.commandRequest({ kind: "claim", conversationId: "normal-runtime-chain", executionId, claimId })).toMatchObject({ commandId, claimId, executionId, dispatchAllowed: true });
    const admission = {
      kind: "admit" as const,
      admission: {
        executionId,
        delegationId,
        provider: "cursor" as const,
        model: "grok-4.6",
        source: {
          kind: "command" as const,
          commandId,
          claimId,
        },
      },
    };
    await expect(
      runtime!.agentExecutionRequest(admission, new AbortController().signal),
    ).rejects.toThrow();
    const evidence: CloudAgentRuntimeChange = {
      operationId: randomUUID(),
      actorUserId: owner.id,
      enabled: true,
      reason: "Synthetic integration fixture, not live provider qualification",
      evidence: {
        version: 1,
        channel: "development",
        provider: "daytona",
        runtimeClass: "linux-vm",
        imageRef: IMAGE,
        profile: "zeros-cloud-worker-v3",
        runtimeContractSha256: CONTRACT,
        sourceCommit: "a".repeat(40),
        evidenceSha256: "e".repeat(64),
        qualifiedAt: new Date().toISOString(),
        credentials: [
          {
            kind: "cursor-api-key",
            renewal: false,
            checks: {
              privateCredentialIsolation: true,
              workloadCredentialDenial: true,
              actorAdmission: true,
              stopAndRevocation: true,
              nativeTurn: true,
              nativeResume: true,
              authentication: true,
            },
          },
        ],
      },
    };
    const options = { databaseUrl: url!, channel: "development" },
      plan = await manageCloudAgentRuntime(pool, evidence, options);
    await manageCloudAgentRuntime(pool, evidence, {
      ...options,
      execute: true,
      approval: plan.planSha256,
    });
    for (const changed of [
      { executionId: randomUUID() }, { delegationId: randomUUID() },
      { model: "unqualified-model" }, { provider: "claude" as const },
      { source: { ...admission.admission.source, commandId: randomUUID() } },
      { source: { ...admission.admission.source, claimId: randomUUID() } },
    ]) {
      await expect(runtime!.agentExecutionRequest({ ...admission, admission: { ...admission.admission, ...changed } }, new AbortController().signal)).rejects.toThrow();
    }
    const lease = (await runtime!.agentExecutionRequest(
      admission,
      new AbortController().signal,
    )) as { leaseId: string };
    expect(lease.leaseId).toBeTypeOf("string");
    await desktop.revokeEngineAdmission("synthetic-account-token", {
      ...target,
      grantToken: grant.grantToken,
    });
    expect(
      await runtime!.verifyClientAdmission(grant.grantToken, true),
    ).toBeNull();
    expect(
      await runtime!.verifyClientAdmission(otherGrant.grantToken, true),
    ).not.toBeNull();
    // Disconnecting the submitting device does not substitute the second
    // device or replay the paid command. Its recorded claim remains exact.
    expect((await pool.query("SELECT actor_source_session_id FROM cloud_workspace_commands WHERE id=$1", [commandId])).rows[0].actor_source_session_id).toBe(actor!.actor!.sessionId);
    await runtime!.commandRequest({ kind: "settle", result: { commandId, claimId, state: "succeeded", resultCode: null } });
    await expect(runtime!.agentExecutionRequest(admission, new AbortController().signal)).rejects.toThrow();
    await credentials.revokeDelegation(owner.id, delegationId);
    await expect(
      runtime!.agentExecutionRequest(
        { kind: "validate", leaseId: lease.leaseId },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await runtime!.stop();
  }, 30000);
});

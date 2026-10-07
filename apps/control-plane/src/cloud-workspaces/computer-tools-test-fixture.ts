import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { ensureUser, type AuthedUser } from "../auth.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { withSystemTx, type Tx } from "../db.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { markAdminWorkspace } from "./computer-admin-workspaces.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudAgentCredentialService } from "./agent-credentials.js";
import { authorizeCloudWorkspaceActor } from "./actors.js";
import { readCloudAgentComputeTrust } from "./agent-compute-trust.js";
import { DatabaseManagedComputeCreditLedger } from "./compute-credits.js";
import { CloudWorkspaceComputeLeaseCoordinator } from "./compute-leases.js";
import type { CloudWorkspaceProvider } from "./provider.js";

const fixtures = new URL("../../../../packages/protocol/src/__tests__/fixtures/cloud-runtime/", import.meta.url);
const manifestRaw = readFileSync(new URL("manifest.valid.json", fixtures));
const baseRaw = readFileSync(new URL("base-compatibility.valid.json", fixtures));
const manifest = JSON.parse(manifestRaw.toString("utf8"));
const manifestSha = createHash("sha256").update(manifestRaw).digest("hex");
const baseSha = createHash("sha256").update(baseRaw).digest("hex");
const runtimeId = `r1-${manifestSha}`, baseId = "zeros-v2-test-computer-base", compatibilityId = `bc1-${baseSha}`;
const pin = {
  runtime_id: runtimeId, runtime_manifest_sha256: manifestSha, runtime_base_image_id: baseId,
  runtime_base_compatibility_id: compatibilityId, runtime_profile: "zeros-cloud-worker-v4", runtime_engine_protocol_version: 20,
};
const jsonColumns = new Set(["contract", "manifest_header", "evidence", "effective_document", "provenance", "source_versions", "repository_manifest"]);
async function insert(tx: Tx, table: string, row: Record<string, unknown>) {
  // All identifiers are fixture constants; data remains parameterized.
  const keys = Object.keys(row);
  await tx.query(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
    keys.map(key => jsonColumns.has(key) ? JSON.stringify(row[key]) : row[key]));
}

/** A valid registered v4 engine and recorded initiating lease. Tests can also
 * use its consent/session to exercise fresh runtime credential admission. */
export async function seedComputerToolsFixture(pool: pg.Pool, marked = true, qualification: {
  mode?: "full" | "smoke"; mcpQualified?: boolean;
} = {}) {
  const fixture = await seedReadyCloudWorkspace(pool);
  const config = { settingsSecretKeyV1: randomBytes(32).toString("base64url") } as CloudWorkspaceBackendConfig;
  const computer = new DatabaseCloudComputerV2Service(pool, config);
  const encryption = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
  const providerId = randomUUID(), setupId = randomUUID(), grantId = randomUUID(), settingsId = randomUUID();
  const engineInstanceId = randomUUID(), heartbeatToken = `zwh_${randomBytes(32).toString("base64url")}`;
  const sourceBuildId = randomUUID(), sourceConfigId = randomUUID();
  const sourceSandboxId = "zeros-v2-test-tools-template", sourceImageRef = `boat-template:${sourceSandboxId}`;
  const scope = { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, engineInstanceId, heartbeatToken, generation: 2 };
  const { files: _files, ...header } = manifest;
  await withSystemTx(pool, async tx => {
    await insert(tx, "cloud_runtime_base_contracts", { base_compatibility_id: compatibilityId, contract_sha256: baseSha, contract: JSON.parse(baseRaw.toString("utf8")) });
    await insert(tx, "cloud_runtime_base_images", { base_image_id: baseId, provider: "boat", image_ref: baseId, base_compatibility_id: compatibilityId,
      source_commit: "c".repeat(40), image_build_sha256: "d".repeat(64), architecture: "linux/amd64", storage_mib: 20480, approved_at: new Date() });
    await insert(tx, "cloud_runtime_bundles", { runtime_id: runtimeId, manifest_sha256: manifestSha, archive_sha256: "d".repeat(64), archive_bytes: 100,
      expanded_bytes: 6, object_key: `runtime/v1/${runtimeId}.tar.gz`, source_commit: manifest.source.commit, architecture: "linux/amd64",
      node_version: "22.23.1", node_modules_abi: 127, bootstrap_protocol_version: 1, setup_protocol_version: 2, engine_protocol_version: 20, manifest_header: header });
    await insert(tx, "cloud_runtime_qualifications", { runtime_id: runtimeId, base_compatibility_id: compatibilityId, credential_kind: "cursor-api-key",
      profile: "zeros-cloud-worker-v4", enabled: true, mcp_qualified: qualification.mcpQualified ?? true,
      evidence: { mode: qualification.mode ?? "full", checks: ["manifest_digest"] }, qualified_at: new Date() });
    await insert(tx, "provider_connections", { id: providerId, org_id: fixture.organizationId, owner_kind: "organization", provider: "boat",
      display_name: "Computer tools fixture", credential_source: "hosted", current_version: 1, state: "active" });
    await insert(tx, "provider_connection_versions", { connection_id: providerId, org_id: fixture.organizationId, version: 1,
      credential_source: "hosted", endpoint: "hosted://boat", created_by: fixture.userId });
    const head = (await tx.query<{ revision: string; next_version: string }>(
      "SELECT revision,next_version FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE", [fixture.organizationId])).rows[0]!;
    const sourceVersion = Number(head.next_version);
    await insert(tx, "cloud_computer_v2_configs", { id: sourceConfigId, org_id: fixture.organizationId,
      install_script: "", timeout_seconds: 900, metadata_digest: randomBytes(32), created_by: fixture.userId });
    await insert(tx, "cloud_computer_v2_builds", { id: sourceBuildId, org_id: fixture.organizationId, version: sourceVersion,
      config_id: sourceConfigId, accepted_revision: Number(head.revision), requested_by: fixture.userId, operation_id: randomUUID(),
      state: "succeeded", stage: "done", base_image_id: baseId, runtime_id: runtimeId, repository_manifest: [], completed_at: new Date() });
    await insert(tx, "cloud_computer_templates", { build_id: sourceBuildId, org_id: fixture.organizationId, state: "ready",
      provider_resource_id: sourceSandboxId, account_scope: "zeros-v2-test-account", billing_org: "zeros-v2-test-wallet",
      protected_contract_digest: randomBytes(32), stopped_at: new Date() });
    await tx.query("UPDATE cloud_computer_v2_heads SET next_version=$2 WHERE org_id=$1", [fixture.organizationId, sourceVersion + 1]);
    await insert(tx, "cloud_workspace_generations", { workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      provider: "boat", image_ref: sourceImageRef, architecture: "linux/amd64", cpu_millicores: 2000, memory_mib: 4096, storage_mib: 20480,
      source_commit: "c".repeat(40), created_by: fixture.userId, provider_connection_id: providerId, ...pin });
    await insert(tx, "cloud_workspace_computer_sources", { workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      build_id: sourceBuildId, template_id: sourceBuildId, config_id: sourceConfigId });
    await insert(tx, "workspace_settings_versions", { id: settingsId, workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      effective_document: { schemaVersion: 1, values: {} }, provenance: {},
      source_versions: { fixture: 1, computerEnvironment: { configId: sourceConfigId, bindings: [] } }, created_by: fixture.userId });
    await tx.query(`INSERT INTO cloud_workspace_setup_specs(workspace_id,generation,org_id,repository_forge,repository_owner,repository_name,
      repository_revision,settings_snapshot,settings_snapshot_sha256,workspace_settings_version_id)
      SELECT workspace_id,2,org_id,repository_forge,repository_owner,repository_name,repository_revision,settings_snapshot,settings_snapshot_sha256,$2
      FROM cloud_workspace_setup_specs WHERE workspace_id=$1 AND generation=1`, [fixture.workspaceId, settingsId]);
    await insert(tx, "cloud_workspace_setup_runs", { id: setupId, workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      attempt: 1, state: "running", claim_count: 1, execution_fence: 1, lease_owner: "zeros-v2-test-computer", lease_expires_at: new Date(Date.now() + 600_000),
      last_heartbeat_at: new Date(), started_at: new Date() });
    await insert(tx, "cloud_workspace_endpoint_grants", { id: grantId, workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      account_user_id: fixture.userId, purpose: "setup", setup_run_id: setupId, setup_execution_fence: 1, audience: "zeros-v2-test-computer",
      token_hash: randomBytes(32), account_revision: 1, authorization_revision: 1, expires_at: new Date(Date.now() + 600_000), consumed_at: new Date() });
    await insert(tx, "cloud_workspace_engine_instances", { id: engineInstanceId, workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId,
      account_user_id: fixture.userId, setup_run_id: setupId, setup_execution_fence: 1, registration_grant_id: grantId, protocol_version: 20, actor_protocol_version: 2,
      state: "ready", bridge_token_hash: randomBytes(32), heartbeat_token_hash: createHash("sha256").update(heartbeatToken).digest(), registered_at: new Date(),
      last_heartbeat_at: new Date(), lease_expires_at: new Date(Date.now() + 600_000), ...pin,
      runtime_installer_receipt_sha256: "e".repeat(64), runtime_boot_id: randomUUID(), runtime_supervisor_session_id: randomUUID() });
    await tx.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [fixture.engineInstanceId]);
    // The generation projection trigger retires generation 1 and creates the
    // active execution for generation 2 in this same transaction.
    await tx.query("UPDATE cloud_workspaces SET current_generation=2,sharing_mode='private' WHERE id=$1", [fixture.workspaceId]);
    await insert(tx, "cloud_workspace_provider_bindings", { workspace_id: fixture.workspaceId, generation: 2, org_id: fixture.organizationId, provider: "boat",
      provider_resource_id: "zeros-v2-test-private-provider-id", observed_state: "running", last_observed_at: new Date() });
    if (marked) await markAdminWorkspace(tx, { workspaceId: fixture.workspaceId, orgId: fixture.organizationId, creatorUserId: fixture.userId });
  });

  // Fund the synthetic Boat allocation through the real ledger/coordinator.
  // Runtime authority must retain its normal compute checks in this fixture.
  await pool.query("UPDATE managed_compute_provider_requirements SET require_credit=true WHERE provider='boat'");
  const intentId = randomUUID();
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,generation,org_id,requested_by,operation,idempotency_key,request_sha256)
    VALUES($1,$2,2,$3,$4,'create',$5,$6)`, [intentId, fixture.workspaceId, fixture.organizationId, fixture.userId, randomUUID(), randomBytes(32)]);
  await new DatabaseManagedComputeCreditLedger({ pool, workosEnabled: false }).grant({
    organizationId: fixture.organizationId, userId: fixture.userId, startsAt: new Date(Date.now() - 3600_000),
    endsAt: new Date(Date.now() + 3600_000), amountMicroUsd: 20_000, policyId: "zeros-v2-test-compute", idempotencyKey: randomUUID(),
  });
  const resource = (ttl: number) => ({ workspaceId: fixture.workspaceId, generation: 2, resourceId: "zeros-v2-test-private-provider-id",
    state: "running" as const, target: null, metadata: { computeLeaseExpiresAt: new Date(Date.now() + ttl * 1000).toISOString() } });
  const provider = {
    name: "boat", computeWeight: () => ({ numerator: 1, denominator: 1 }),
    createWithComputeLease: async (_input: unknown, ttl: number) => resource(ttl),
    startWithComputeLease: async (_id: string, ttl: number) => resource(ttl),
    renewComputeLease: async (_id: string, ttl: number) => ({ expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }),
    readComputeUsage: async () => { throw new Error("Unexpected fixture metering"); },
  } as unknown as CloudWorkspaceProvider;
  await new CloudWorkspaceComputeLeaseCoordinator({ pool, workosEnabled: false,
    policy: { provider: "boat", policyId: "zeros-v2-test-price", secondsPerDollar: 100_000, minimumTtlSeconds: 600,
      maximumTtlSeconds: 900, requestMarginSeconds: 60 } }).allocate({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
    generation: 2, intentId, idempotencyKey: intentId, imageRef: sourceImageRef, architecture: "linux/amd64",
    cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, provider, null);

  const installationId = randomUUID();
  await withSystemTx(pool, async tx => {
    await tx.query("UPDATE repositories SET forge_repository_id='123' WHERE id=$1", [fixture.repositoryId]);
    await tx.query("INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','fixture-user')", [fixture.userId]);
    await tx.query(`INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      VALUES($1,123,'github.com',$2,'withso','Organization','Organization')`, [installationId, fixture.userId]);
    await tx.query("INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)", [fixture.organizationId, fixture.userId, installationId]);
    await tx.query(`INSERT INTO cloud_github_source_access(org_id,owner_user_id,installation_id,repository_owner,repository_name,forge_repository_id,actor_fingerprint,expires_at)
      VALUES($1,$2,$3,'withso','zeros','123',cloud_github_actor_fingerprint($1,$2),now()+interval '10 minutes')`, [fixture.organizationId, fixture.userId, installationId]);
  });
  const draft = { installScript: "echo initial", timeoutSeconds: 120,
    repositories: [{ id: "123", owner: "withso", name: "zeros", installationId, requestedRef: null }] };
  const head = (await pool.query<{ revision: string; next_version: string }>(
    "SELECT revision,next_version FROM cloud_computer_v2_heads WHERE org_id=$1", [fixture.organizationId])).rows[0]!;
  const saved = await computer.saveDraft(fixture.organizationId, fixture.userId, { ...draft, expectedRevision: Number(head.revision),
    environment: [{ op: "set", name: "APPLICATION_SECRET", value: "synthetic-org-environment-value" }] });
  const initialBuildCount = (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM cloud_computer_v2_builds")).rows[0]!.count;

  async function actor(userId = fixture.userId) {
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${userId}`, email: `durable-${userId}@example.test`, displayName: "Fixture",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [user.authentication.sessionId, user.identity.subject, user.id]);
    return user;
  }
  async function lease(user: AuthedUser) {
    const pair = generateKeyPairSync("ed25519"), publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    const device = (await pool.query<{ id: string }>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Computer fixture','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const proof = { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action: "engine.connect",
      payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") };
    const sessions = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: false });
    const issued = await sessions.issue({ ...scope, actorUserId: user.id, authenticatedUser: user, proof });
    const actorSessionId = (await sessions.consume({ ...scope, token: issued.grantToken })).actorSessionId;
    const credentialId = randomUUID(), delegationId = randomUUID(), leaseId = randomUUID(), executionId = randomUUID();
    await new DatabaseCloudAgentCredentialService(pool, encryption).put({ ownerUserId: user.id, credentialId, operationId: randomUUID(), expectedRevision: 0,
      displayName: "Computer fixture", material: { kind: "cursor-api-key", apiKey: "synthetic-private-provider-key" } });
    await withSystemTx(pool, async tx => {
      const authority = await authorizeCloudWorkspaceActor(tx, { workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, actorUserId: user.id, capability: "run" });
      const compute = (await readCloudAgentComputeTrust(tx, fixture.workspaceId))!;
      await insert(tx, "cloud_agent_credential_delegations", { id: delegationId, credential_id: credentialId, credential_revision: 1, owner_user_id: user.id,
        workspace_id: fixture.workspaceId, org_id: fixture.organizationId, grantee_user_id: user.id, owner_fingerprint: authority.fingerprint,
        grantee_fingerprint: authority.fingerprint, compute_fingerprint: compute.fingerprint, compute_trust: compute.trust,
        models: ["grok-4.6"], expires_at: new Date(Date.now() + 3600_000) });
      await insert(tx, "cloud_agent_execution_leases", { id: leaseId, delegation_id: delegationId, credential_id: credentialId, credential_revision: 1,
        workspace_id: fixture.workspaceId, org_id: fixture.organizationId, generation: 2, engine_instance_id: engineInstanceId, actor_source_session_id: actorSessionId,
        execution_id: executionId, model: "grok-4.6", provider: "cursor", expires_at: new Date(Date.now() + 45_000) });
    });
    return { leaseId, actorSessionId, credentialId, delegationId, executionId };
  }
  const owner = await actor(), initiating = await lease(owner);
  return { fixture, scope, computer, config, encryption, actor, lease, owner, initiating, draft, runtimeId, compatibilityId,
    initialRevision: saved.revision, nextBuildVersion: Number(head.next_version), initialBuildCount };
}

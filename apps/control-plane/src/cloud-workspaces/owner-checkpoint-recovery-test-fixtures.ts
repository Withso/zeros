import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { CloudOwnerCheckpointRecoverySchema } from "../cloud-owner-checkpoint-recovery-contract.js";
import { manageCloudProviderLoss, validateCloudProviderLossRequest } from "../manage-cloud-provider-loss.js";
import { seedFinalSave } from "./final-save-test-fixtures.js";
import { computerTestAccount, computerTestWallet, seedComputerTemplate } from "./computer-workspace-test-fixtures.js";
import { seedRuntimeBundle } from "./runtime-test-fixtures.js";

export const ownerRecoveryConfig = { provider: "boat", imageRef: "qualified-image", sourceCommit: "b".repeat(40),
  architecture: "linux/amd64", cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480,
  settingsSecretEncryptionKeys: {}, currentSettingsSecretEncryptionKeyVersion: null,
  boat: { accountScope: computerTestAccount, billingOrg: computerTestWallet } } as CloudWorkspaceBackendConfig;

export async function seedOwnerCheckpointRecovery(pool: pg.Pool) {
  const resourceId = "bx_zst7k2m4";
  // A real Postgres incarnation includes microseconds. Date round trips must
  // not turn exact SQL registration equality into a false scope mismatch.
  const registeredAt=new Date(Date.now()-60_000).toISOString().replace("Z","123Z");
  const f = await seedFinalSave(pool, { providerResourceId: resourceId, sealed: false, registeredAt });
  const prepared = await f.prepareCommit();
  const { requestId:_requestId,...periodic } = prepared.body;
  const checkpointId = (await prepared.content.commitCheckpoint({ ...periodic, ...f.scope,
    idempotencyKey: randomUUID(), reason: "periodic" })).checkpointId;
  const wakeId = randomUUID();
  await pool.query("UPDATE cloud_workspace_lifecycle_intents SET affects_workspace=false WHERE id=$1", [f.intentId]);
  await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
    (id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,resume_after_intent_id,restart_version)
    VALUES($1::uuid,$2,$3,1,$4,'wake',$1::text,digest($1::text,'sha256'),$5,1)`,
  [wakeId,f.scope.workspaceId,f.scope.organizationId,f.fixture.userId,f.intentId]);
  await pool.query("UPDATE cloud_workspaces SET accepted_lifecycle_intent_id=$2 WHERE id=$1", [f.scope.workspaceId,wakeId]);
  await f.send(); await f.expire();
  const retired = await f.send(f.report("reconcile"));
  if (retired.state !== "retired") throw new Error("Fixture did not positively retire its capture");
  await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.scope.engineInstanceId]);
  await pool.query(`UPDATE cloud_workspace_setup_runs SET state='succeeded',completed_at=now(),lease_owner=NULL,lease_expires_at=NULL
    WHERE workspace_id=$1`, [f.scope.workspaceId]);
  await pool.query("UPDATE users SET staff_role='platform_owner' WHERE id=$1", [f.fixture.userId]);
  const computer = await withSystemTx(pool, async tx => {
    const installationId = randomUUID();
    await tx.query(`INSERT INTO github_installations(id,github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      VALUES($1,20,'github.com',$2,'withso','Organization','Organization')`, [installationId,f.fixture.userId]);
    const repository = (await tx.query("SELECT forge_repository_id FROM repositories WHERE id=$1", [f.fixture.repositoryId])).rows[0];
    const runtime = await seedRuntimeBundle(tx, { digit: "2", releaseOrder: 2 });
    const selected = await seedComputerTemplate(tx, { organizationId:f.scope.organizationId,ownerUserId:f.fixture.userId,
      installationId,version:20,runtimeId:runtime.pin.runtimeId,sourceSandboxId:"bx_23456789",
      repositories:[{id:repository.forge_repository_id,owner:"withso",name:"zeros",sha:"1".repeat(40)}] });
    await tx.query("UPDATE cloud_computer_templates SET manifest_sha256=$2 WHERE build_id=$1", [selected.buildId,Buffer.alloc(32,20)]);
    await tx.query(`INSERT INTO cloud_computer_template_snapshots
      (build_id,org_id,channel,account_scope,billing_org,source_sandbox_id,snapshot_name,manifest_sha256,
       state,save_requested_at,snapshot_id,size_bytes,tree_sha256,verified_at,ready_at)
      VALUES($1,$2,'alpha',$3,$4,$5,'fixture-alpha-computer-v20',$6,'ready',now(),'fixture_snapshot',4096,$6,now(),now())`,
    [selected.buildId,f.scope.organizationId,computerTestAccount,computerTestWallet,selected.sourceSandboxId,Buffer.alloc(32,20)]);
    await tx.query("UPDATE cloud_computer_templates SET named_snapshot_required=true WHERE build_id=$1", [selected.buildId]);
    await tx.query(`INSERT INTO cloud_workspace_provider_operations
      (provider,account_scope,workspace_id,generation,org_id,idempotency_key,request_sha256,create_attempts_tracked,resource_id)
      VALUES('boat',$1,$2,1,$3,$4,$5,true,$6)`,
    [computerTestAccount,f.scope.workspaceId,f.scope.organizationId,randomUUID(),"a".repeat(64),resourceId]);
    await tx.query(`INSERT INTO cloud_workspace_quotas(org_id,max_workspaces,max_running_workspaces,max_cpu_millicores,max_memory_mib,max_storage_mib)
      VALUES($1,10,10,100000,100000,1000000) ON CONFLICT(org_id) DO NOTHING`, [f.scope.organizationId]);
    return { ...selected,runtimeId:runtime.pin.runtimeId };
  });
  const slug = (await pool.query("SELECT slug::text FROM organizations WHERE id=$1", [f.scope.organizationId])).rows[0].slug;
  const lossRequest = validateCloudProviderLossRequest({ databaseUrl:process.env.TEST_DATABASE_URL!,channel:"alpha",execute:false,
    organizationId:f.scope.organizationId,expectedOrganizationSlug:slug,actorUserId:f.fixture.userId,workspaceId:f.scope.workspaceId,
    generation:"1",resourceId,accountScope:computerTestAccount,expectedProviderAccount:"fixture-account",reason:"Owner approved restoring the selected durable checkpoint" });
  const observedAt = (await pool.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const inventory = { observedAt,providerAccount:"fixture-account",accountProof:null,resources:[] };
  const lookup = { observedAt,resourceId,notFound:true };
  const plan = await manageCloudProviderLoss(pool,lossRequest,inventory,lookup);
  await manageCloudProviderLoss(pool,{ ...lossRequest,execute:true,approval:plan.approval },inventory,lookup);
  const loss = (await pool.query("SELECT id FROM cloud_workspace_provider_loss_attestations WHERE workspace_id=$1", [f.scope.workspaceId])).rows[0];
  const point = (await pool.query("SELECT * FROM workspace_checkpoints WHERE id=$1", [checkpointId])).rows[0];
  const request = CloudOwnerCheckpointRecoverySchema.parse({ version:1,operationId:randomUUID(),channel:"alpha",
    organizationId:f.scope.organizationId,expectedOrganizationSlug:slug,workspaceId:f.scope.workspaceId,
    ownerUserId:f.fixture.userId,operatorUserId:f.fixture.userId,sourceGeneration:1,stopIntentId:f.intentId,wakeIntentId:wakeId,
    recoveryId:f.intentId,requestId:f.request.id,retirementId:retired.retirementId,custodyId:retired.custodyId,
    providerResourceId:resourceId,providerAccountScope:computerTestAccount,providerLossAttestationId:loss.id,
    checkpointId,checkpointSha256:point.integrity_sha256.toString("hex"),checkpointContentRevision:Number(point.content_revision),
    checkpointRecordRevision:Number(point.record_revision),checkpointAt:point.durable_at.toISOString(),
    computerBuildId:computer.buildId,computerConfigId:computer.configId,runtimeId:computer.runtimeId,
    ownerAcknowledgedUnsavedLoss:true,ownerApprovalReference:"Fixture owner explicitly accepts all newer unsaved work loss",
    reason:"Restore the exact durable checkpoint after owner-attested source discard" });
  return { ...f,requestInput:request,wakeId,checkpointId,computer };
}

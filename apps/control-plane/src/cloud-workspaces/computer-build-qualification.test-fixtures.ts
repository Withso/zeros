import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Tx } from "../db.js";
import { ensureCloudComputerIdentity } from "./computer-identity.js";
import { seedRuntimeBase, seedRuntimeBundle } from "./runtime-test-fixtures.js";
import { CloudComputerBuildQualificationSchema, canonicalBuildQualification, type CloudComputerBuildQualification } from "./computer-build-qualification-contract.js";

export async function seedBuildQualification(tx: Tx, organizationId: string, userId: string) {
  await seedRuntimeBase(tx);
  const runtime = await seedRuntimeBundle(tx);
  await ensureCloudComputerIdentity(tx, organizationId, userId);
  const buildId = randomUUID(), configId = randomUUID();
  const evidence = CloudComputerBuildQualificationSchema.parse(JSON.parse(readFileSync(new URL(
    "../../../../packages/protocol/src/__tests__/fixtures/cloud-build-qualification.valid.json", import.meta.url), "utf8")));
  evidence.scope = { ...evidence.scope, organizationId, buildId, configId };
  evidence.builder.operationKey = `computer-build:${buildId}`;
  evidence.runtime.engineProtocolVersion = runtime.descriptor.engineProtocolVersion;
  evidence.qualifiedAt = new Date().toISOString();
  await tx.query("INSERT INTO cloud_computer_v2_heads(org_id) VALUES($1)", [organizationId]);
  await tx.query(`INSERT INTO cloud_computer_v2_configs(id,org_id,install_script,timeout_seconds,metadata_digest,created_by)
    VALUES($1,$2,'',900,$3,$4)`, [configId, organizationId, Buffer.alloc(32, 1), userId]);
  await tx.query(`INSERT INTO cloud_computer_v2_builds(id,org_id,version,config_id,accepted_revision,requested_by,operation_id,
    state,stage,base_image_id,runtime_id,worker_fence,helper_fence,started_at,deadline_at)
    VALUES($1,$2,1,$3,1,$4,$5,'running','integrity',$6,$7,1,1,clock_timestamp()-interval '1 second',clock_timestamp()+interval '10 minutes')`,
  [buildId, organizationId, configId, userId, randomUUID(), evidence.base.baseImageId, evidence.runtime.runtimeId]);
  await tx.query(`INSERT INTO cloud_builder_vm_operations(account_scope,operation_key,purpose,request_sha256,intent,
    provider_request,state,sandbox_id,create_dispatched_at) VALUES($1,$2,'computer-build',$3,'{}','{}','ready',$4,clock_timestamp())`,
  [evidence.scope.accountScope, evidence.builder.operationKey, "f".repeat(64), evidence.builder.sandboxId]);
  await tx.query(`INSERT INTO cloud_computer_templates(build_id,org_id,state,provider_resource_id,account_scope,billing_org,
    builder_operation_key,builder_name,allocation_requested_at,protected_contract_digest)
    VALUES($1,$2,'pending',$3,$4,$5,$6,'fixture-builder',clock_timestamp(),$7)`,
  [buildId, organizationId, evidence.builder.sandboxId, evidence.scope.accountScope, evidence.scope.billingOrg,
    evidence.builder.operationKey, Buffer.from(evidence.base.protectedContractSha256, "hex")]);
  return evidence;
}

export async function insertQualification(tx: Tx, evidence: CloudComputerBuildQualification) {
  const raw = canonicalBuildQualification(evidence), scope = evidence.scope;
  return tx.query(`INSERT INTO cloud_computer_build_qualifications
    (build_id,config_id,org_id,runtime_id,runtime_manifest_sha256,base_image_id,base_compatibility_id,canonical_evidence,evidence_sha256)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
  [scope.buildId, scope.configId, scope.organizationId, evidence.runtime.runtimeId, evidence.runtime.manifestSha256,
    evidence.base.baseImageId, evidence.base.baseCompatibilityId, raw, createHash("sha256").update(raw).digest()]);
}

export async function publishQualifiedBuild(tx: Tx, evidence: CloudComputerBuildQualification, options: {
  snapshot?: boolean; snapshotChannel?: string; snapshotManifest?: string; templateManifest?: string; succeeded?: boolean;
} = {}) {
  const { scope, builder } = evidence;
  if (options.snapshot !== false) await tx.query(`INSERT INTO cloud_computer_template_snapshots
    (build_id,org_id,channel,account_scope,billing_org,source_sandbox_id,snapshot_name,manifest_sha256,state,
      save_requested_at,snapshot_id,size_bytes,tree_sha256,verified_at,ready_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',clock_timestamp(),'fixture_snapshot',4096,$9,clock_timestamp(),clock_timestamp())`,
  [scope.buildId, scope.organizationId, options.snapshotChannel ?? scope.channel, scope.accountScope, scope.billingOrg,
    builder.sandboxId, `fixture-${options.snapshotChannel ?? scope.channel}-computer-v1`,
    Buffer.from(options.snapshotManifest ?? evidence.sanitationManifestSha256, "hex"), Buffer.alloc(32, 13)]);
  await tx.query(`UPDATE cloud_computer_templates SET state='ready',stopped_at=clock_timestamp(),manifest_sha256=$2 WHERE build_id=$1`,
  [scope.buildId, Buffer.from(options.templateManifest ?? evidence.sanitationManifestSha256, "hex")]);
  if (options.succeeded !== false) await tx.query(`UPDATE cloud_computer_v2_builds
    SET state='succeeded',stage='done',completed_at=clock_timestamp() WHERE id=$1`, [scope.buildId]);
}

import { randomUUID } from "node:crypto";
import type { Tx } from "../db.js";
import { ensureCloudComputerIdentity } from "./computer.js";
import { runtimeBase } from "./runtime-test-fixtures.js";

export const computerTestWallet = "team_0f5c2a9e-4b1d-4c8e-9a70-3d2b1e6f8c41";
export const computerTestAccount = "zeros-v2-test-account";

/** Seed C1's public storage contract directly; C5 does not depend on the C3 worker. */
export async function seedComputerTemplate(tx: Tx, input: {
  organizationId: string;
  ownerUserId: string;
  installationId: string;
  version?: number;
  runtimeId?: string;
  primaryName?: string;
  sourceSandboxId?: string;
  environment?: Array<{ name: string; bindingId: string; bindingVersion: number }>;
}) {
  const version = input.version ?? 1;
  const buildId = randomUUID(), configId = randomUUID();
  const repositories = [
    { id: "123456789", owner: "withso", name: input.primaryName ?? "zeros", sha: "1".repeat(40) },
    { id: "987654321", owner: "withso", name: "secondary", sha: "2".repeat(40) },
  ];
  const sourceSandboxId = input.sourceSandboxId ?? `zeros-v2-test-template-${version}`;
  await ensureCloudComputerIdentity(tx, input.organizationId, input.ownerUserId);
  await tx.query("INSERT INTO cloud_computer_v2_heads(org_id) VALUES($1) ON CONFLICT DO NOTHING", [input.organizationId]);
  await tx.query(`INSERT INTO cloud_computer_v2_configs(id,org_id,install_script,timeout_seconds,metadata_digest,created_by)
    VALUES($1,$2,'',900,$3,$4)`, [configId, input.organizationId, Buffer.alloc(32, version), input.ownerUserId]);
  for (const [position, repo] of repositories.entries()) {
    await tx.query(`INSERT INTO cloud_computer_v2_config_repositories
      (config_id,org_id,position,repository_id,repository_owner,repository_name,installation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [configId, input.organizationId, position, repo.id, repo.owner, repo.name, input.installationId]);
  }
  for (const binding of input.environment ?? []) {
    await tx.query(`INSERT INTO cloud_computer_environment_refs(config_id,org_id,name,binding_id,binding_version)
      VALUES($1,$2,$3,$4,$5)`, [configId,input.organizationId,binding.name,binding.bindingId,binding.bindingVersion]);
  }
  await tx.query(`INSERT INTO cloud_computer_v2_builds
    (id,org_id,version,config_id,accepted_revision,requested_by,operation_id,state,stage,base_image_id,runtime_id,repository_manifest,completed_at)
    VALUES($1,$2,$3,$4,$3,$5,$6,'succeeded','done',$7,$8,$9::jsonb,now())`,
  [buildId, input.organizationId, version, configId, input.ownerUserId, randomUUID(), runtimeBase.id,
    input.runtimeId ?? `r1-${"a".repeat(64)}`, JSON.stringify(repositories)]);
  await tx.query(`INSERT INTO cloud_computer_templates
    (build_id,org_id,state,provider_resource_id,account_scope,billing_org,protected_contract_digest,stopped_at)
    VALUES($1,$2,'ready',$3,$4,$5,$6,now())`,
  [buildId, input.organizationId, sourceSandboxId, computerTestAccount, computerTestWallet, Buffer.alloc(32, 3)]);
  await tx.query(`UPDATE cloud_computer_v2_heads SET active_build_id=$2,draft_config_id=$3,
    revision=$4::bigint,next_version=$4::bigint+1 WHERE org_id=$1`, [input.organizationId, buildId, configId, version]);
  return { buildId, templateId: buildId, configId, sourceSandboxId, repositories };
}

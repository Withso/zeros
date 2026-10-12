// Frozen pre-0142 Computer lookup for D1's populated-schema expansion test.
// Newer application readers require later tables, so only fixture admission
// uses this old query contract while the database is still at migration 0141.
// The test restores the current reader before migrating and exercising purge.
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { CloudComputerV2RepositoryManifestSchema } from "./computer-v2-contract.js";
import type { CloudComputerWorkspaceSource } from "./computer-workspace-source.js";

const templateRef = /^boat-template:([A-Za-z0-9_-]{1,128})$/;
const pathName = /^[a-z0-9_.-]{1,100}$/;
type TemplateRow = {
  build_id: string; version: string | number; config_id: string; provider_resource_id: string | null;
  account_scope: string | null; billing_org: string | null;
  base_image_id: string; base_compatibility_id: string; runtime_id: string;
  manifest_sha256: string; engine_protocol_version: number;
  source_commit: string; architecture: "linux/amd64"; storage_mib: number | string;
  repository_manifest: unknown; protected_contract_digest: Buffer;
};

function buildRequired(): never {
  throw new HttpError(409, "cloud_computer_build_required", "Build your Cloud Computer before creating a workspace.");
}

const templateSelect = `SELECT build.id AS build_id,build.version,build.config_id,template.provider_resource_id,
  template.account_scope,template.billing_org,template.protected_contract_digest,
  build.base_image_id,base.base_compatibility_id,build.runtime_id,bundle.manifest_sha256,bundle.engine_protocol_version,
  base.source_commit,base.architecture,base.storage_mib,build.repository_manifest
  FROM cloud_computer_v2_builds build
  JOIN cloud_computer_templates template ON template.build_id=build.id AND template.org_id=build.org_id
  JOIN cloud_runtime_base_images base ON base.base_image_id=build.base_image_id AND base.provider='boat'
  JOIN cloud_runtime_bundles bundle ON bundle.runtime_id=build.runtime_id
  WHERE build.id=$1 AND build.org_id=$2 AND build.state='succeeded' AND template.state='ready'
    AND template.stopped_at IS NOT NULL AND template.protected_contract_digest IS NOT NULL
  FOR SHARE OF build,template`;

async function sourceFromRow(tx: Tx, organizationId: string, row: TemplateRow): Promise<CloudComputerWorkspaceSource> {
  const manifest = CloudComputerV2RepositoryManifestSchema.safeParse(row.repository_manifest);
  const configured = await tx.query<{ repository_id: string; repository_owner: string; repository_name: string }>(
    `SELECT repository_id,repository_owner,repository_name FROM cloud_computer_v2_config_repositories
     WHERE config_id=$1 AND org_id=$2 ORDER BY position`, [row.config_id, organizationId]);
  if (!row.provider_resource_id || !templateRef.test(`boat-template:${row.provider_resource_id}`) ||
    !manifest.success || configured.rows.length !== manifest.data.length ||
    configured.rows.some((repo, index) => {
      const built = manifest.data[index]!;
      return repo.repository_id !== built.id || repo.repository_owner !== built.owner || repo.repository_name !== built.name ||
        [built.owner, built.name].some(name => !pathName.test(name) || name === "." || name === "..");
    })) buildRequired();
  return { buildId: row.build_id, templateId: row.build_id, configId: row.config_id, sourceSandboxId: row.provider_resource_id,
    baseImageId: row.base_image_id, baseCompatibilityId: row.base_compatibility_id, templateRuntimeId: row.runtime_id,
    protectedContractDigest: row.protected_contract_digest.toString("hex"), repositories: manifest.data };
}


export async function loadPrePurgeComputerWorkspaceSource(tx: Tx, input: { workspaceId: string; generation: number; organizationId: string }) {
  const saved = (await tx.query<{ build_id: string; config_id: string; image_ref: string; runtime_base_image_id: string }>(
    `SELECT source.build_id,source.config_id,generation.image_ref,generation.runtime_base_image_id
     FROM cloud_workspace_generations generation
     JOIN cloud_workspace_computer_sources source USING(workspace_id,generation,org_id)
     WHERE generation.workspace_id=$1 AND generation.generation=$2 AND generation.org_id=$3`,
    [input.workspaceId, input.generation, input.organizationId])).rows[0];
  if (!saved) return null;
  const row = (await tx.query<TemplateRow>(templateSelect, [saved.build_id, input.organizationId])).rows[0];
  if (!row || row.config_id !== saved.config_id || row.base_image_id !== saved.runtime_base_image_id ||
    saved.image_ref !== `boat-template:${row.provider_resource_id}`) buildRequired();
  return sourceFromRow(tx, input.organizationId, row);
}

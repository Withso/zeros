import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudComputerOrganization } from "./computer.js";
import { CloudComputerV2RepositoryManifestSchema, type CloudComputerV2RepositoryManifest } from "./computer-v2-contract.js";
import { loadPinnedCloudRuntime, selectCloudRuntime, type CloudRuntimePin } from "./runtime-selection.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import { CloudProviderError, type CloudProviderCreateInput } from "./provider.js";

const templateRef = /^boat-template:([A-Za-z0-9_-]{1,128})$/;
const pathName = /^[a-z0-9_.-]{1,100}$/;
type TemplateRow = {
  build_id: string; config_id: string; provider_resource_id: string | null;
  account_scope: string | null; billing_org: string | null;
  base_image_id: string; base_compatibility_id: string; runtime_id: string;
  manifest_sha256: string; engine_protocol_version: number;
  source_commit: string; architecture: "linux/amd64"; storage_mib: number | string;
  repository_manifest: unknown; protected_contract_digest: Buffer;
};
export type CloudComputerWorkspaceSource = {
  buildId: string; templateId: string; configId: string; sourceSandboxId: string;
  baseImageId: string; baseCompatibilityId: string; templateRuntimeId: string;
  protectedContractDigest: string; repositories: CloudComputerV2RepositoryManifest;
};
export type CloudComputerRepositoryGrant = {
  id: string; githubInstallationId: number; repositoryId: string;
};

/** Exact C3 sanitation-manifest shape, delivered through private setup material. */
export function computerWorkspaceTemplateManifest(source: CloudComputerWorkspaceSource) {
  return { schema: "zeros.computer-template/v1" as const, buildId: source.buildId, configId: source.configId,
    baseImageId: source.baseImageId, runtimeId: source.templateRuntimeId, baseCompatibilityId: source.baseCompatibilityId,
    repositoryManifest: source.repositories, protectedContractDigest: source.protectedContractDigest };
}

function buildRequired(): never {
  throw new HttpError(409, "cloud_computer_build_required", "Build your Cloud Computer before creating a workspace.");
}

const templateSelect = `SELECT build.id AS build_id,build.config_id,template.provider_resource_id,
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

/** A C1 config's approved repository is the org read grant. It deliberately
 * does not borrow the creating member's short-lived personal source proof. */
export async function resolveComputerRepositoryGrant(tx: Tx, input: {
  organizationId: string; configId: string; owner: string; name: string;
  installationId: string; repositoryId?: string;
}): Promise<CloudComputerRepositoryGrant> {
  const repo = (await tx.query<{ repository_id: string; installation_id: string }>(
    `SELECT repository_id,installation_id FROM cloud_computer_v2_config_repositories
     WHERE org_id=$1 AND config_id=$2 AND repository_owner=lower($3) AND repository_name=lower($4)`,
    [input.organizationId, input.configId, input.owner, input.name])).rows[0];
  if (!repo || repo.installation_id !== input.installationId || (input.repositoryId !== undefined && repo.repository_id !== input.repositoryId))
    throw new HttpError(409, "cloud_computer_repository_not_configured", "Choose a repository from the active Cloud Computer. Refresh before trying again.");
  const installation = (await tx.query<{ github_installation_id: string | number }>(
    `SELECT github_installation_id FROM github_installations WHERE id=$1 AND app_variant='github.com'
     AND suspended_at IS NULL AND lower(account_login)=lower($2) FOR SHARE`, [repo.installation_id, input.owner])).rows[0];
  const githubInstallationId = Number(installation?.github_installation_id);
  if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId < 1)
    throw new HttpError(409, "cloud_computer_repository_unavailable", "The Cloud Computer repository read grant is unavailable.");
  return { id: repo.installation_id, githubInstallationId, repositoryId: repo.repository_id };
}

/** Only the engineering-staff create path calls this. The organization and
 * head locks serialize enrollment/activation/retirement with source retention.
 * No provider or GitHub request runs while these locks are held. */
export async function selectComputerWorkspaceSource(tx: Tx, input: {
  organizationId: string; qualificationMode: CloudRuntimeQualificationMode;
  accountScope?: string; billingOrg?: string;
  expectedActiveBuildId?: string | null;
}) {
  await lockCloudComputerOrganization(tx, input.organizationId);
  // C6 claims retirement under this same UPDATE lock and rechecks source
  // references. Keep it through the final generation/source INSERT commit.
  const head = (await tx.query<{ active_build_id: string | null }>(
    "SELECT active_build_id FROM cloud_computer_v2_heads WHERE org_id=$1 FOR UPDATE", [input.organizationId])).rows[0];
  if (input.expectedActiveBuildId !== undefined && (head
    ? input.expectedActiveBuildId === null || head.active_build_id !== input.expectedActiveBuildId
    : input.expectedActiveBuildId !== null))
    throw new HttpError(409, "cloud_computer_changed", "Cloud Computer changed during workspace creation. Refresh before trying again.");
  if (!head) return null;
  if (!head.active_build_id) buildRequired();
  const row = (await tx.query<TemplateRow>(templateSelect, [head.active_build_id, input.organizationId])).rows[0];
  if (!row) buildRequired();
  const source = await sourceFromRow(tx, input.organizationId, row);
  if (!input.accountScope || !input.billingOrg || row.account_scope !== input.accountScope || row.billing_org !== input.billingOrg)
    throw new HttpError(409, "cloud_computer_template_unavailable", "The active Cloud Computer template is unavailable. Rebuild the computer.");
  const pin: CloudRuntimePin = { runtimeId: row.runtime_id, manifestSha256: row.manifest_sha256,
    baseImageId: row.base_image_id, baseCompatibilityId: row.base_compatibility_id,
    profile: "zeros-cloud-worker-v4", engineProtocolVersion: row.engine_protocol_version };
  // A fork retains the template's physical base. A newer default base cannot
  // turn this fallback into a bare-base allocation or a mismatched runtime.
  const runtime = await loadPinnedCloudRuntime(tx, pin, input.qualificationMode) ? pin :
    (await selectCloudRuntime(tx, input.qualificationMode, pin.baseImageId))?.pin;
  if (!runtime) throw new HttpError(409, "cloud_runtime_unavailable", "A qualified cloud runtime is unavailable");
  return { source, runtime, imageRef: `boat-template:${source.sourceSandboxId}`,
    sourceCommit: row.source_commit, architecture: row.architecture, storageMiB: Number(row.storage_mib) };
}

export async function pinComputerWorkspaceSource(tx: Tx, input: {
  workspaceId: string; generation: number; organizationId: string; source: CloudComputerWorkspaceSource;
}) {
  await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
    VALUES($1,$2,$3,$4,$5,$6)`, [input.workspaceId, input.generation, input.organizationId,
    input.source.buildId, input.source.templateId, input.source.configId]);
}

/** B8's single generation-pin copy helper calls this in its INSERT transaction.
 * Legacy generations have no source row. Active selection is never consulted. */
export async function copyComputerWorkspaceSource(tx: Tx, input: {
  workspaceId: string; organizationId: string; sourceGeneration: number; targetGeneration: number;
}) {
  await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
    SELECT workspace_id,$4,org_id,build_id,template_id,config_id FROM cloud_workspace_computer_sources
    WHERE workspace_id=$1 AND org_id=$2 AND generation=$3`,
  [input.workspaceId, input.organizationId, input.sourceGeneration, input.targetGeneration]);
}

/** Saved-generation lookup shared by setup and the provider's fork admission.
 * A later activation never changes the environment of an accepted generation. */
export async function loadComputerWorkspaceSource(tx: Tx, input: { workspaceId: string; generation: number; organizationId: string }) {
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

/** C4's environment and per-repository setup resolver attaches here. Resolve
 * from the accepted config/source, with a live org read grant, never the head.
 * No environment or script is read from a template or supplied by its disk. */
export async function resolveComputerWorkspaceSetup(tx: Tx, input: {
  workspaceId: string; generation: number; organizationId: string;
  owner: string; name: string; installationId: string; requestedRevision: string;
}) {
  const source = await loadComputerWorkspaceSource(tx, input);
  if (!source) throw new HttpError(409, "cloud_computer_build_required", "The saved Cloud Computer template is unavailable.");
  const grant = await resolveComputerRepositoryGrant(tx, { ...input, configId: source.configId });
  return { source, repositoryId: grant.repositoryId, requestedRevision: input.requestedRevision };
}

export async function resolveComputerTemplateFork(pool: pg.Pool, accountScope: string, billingOrg: string, input: CloudProviderCreateInput) {
  return withSystemTx(pool, async tx => {
    const saved = (await tx.query<{ org_id: string }>(`SELECT generation.org_id FROM cloud_workspace_generations generation
      JOIN cloud_workspace_computer_sources source USING(workspace_id,generation,org_id)
      JOIN cloud_computer_templates template ON template.build_id=source.template_id AND template.org_id=source.org_id
      WHERE generation.workspace_id=$1 AND generation.generation=$2 AND generation.image_ref=$3
        AND template.account_scope=$4 AND template.billing_org=$5`,
    [input.workspaceId, input.generation, input.imageRef, accountScope, billingOrg])).rows[0];
    const source = saved && await loadComputerWorkspaceSource(tx, { ...input, organizationId: saved.org_id });
    if (!source) throw new CloudProviderError("provider_template_identity_mismatch", "Cloud Computer template identity is unavailable", false);
    return source.sourceSandboxId;
  });
}

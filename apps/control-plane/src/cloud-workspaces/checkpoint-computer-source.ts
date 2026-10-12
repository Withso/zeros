import { HttpError } from "../authz.js";
import type { CloudWorkspaceBackendConfig, CloudWorkspaceProvisioningProfile } from "../config.js";
import type { Tx } from "../db.js";
import { loadGenerationSource } from "./generation-pins.js";
import { CloudWorkspaceCheckoutSourceSchema, type CloudWorkspaceCheckoutSource } from "./computer-v2-contract.js";
import { resolveComputerRepositoryGrant, selectComputerWorkspaceSource, type CloudComputerWorkspaceSource } from "./computer-workspace-source.js";
import { cloudRuntimePinValues, type CloudRuntimePin } from "./runtime-selection.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";

type Scope = { workspaceId: string; organizationId: string; sourceGeneration: number };
type CurrentComputerRecovery = {
  profile: CloudWorkspaceProvisioningProfile;
  runtime: CloudRuntimePin;
  computer: CloudComputerWorkspaceSource;
  checkoutSource: CloudWorkspaceCheckoutSource | null;
  installationId: string;
};

/** Only fresh checkpoint generations consult the current Computer. The old
 * generation and its checkout identity never change, even across activation. */
export async function selectCheckpointComputerSource(tx: Tx, input: Scope & {
  config: CloudWorkspaceBackendConfig; qualificationMode: CloudRuntimeQualificationMode;
}): Promise<CurrentComputerRecovery> {
  const original = await loadGenerationSource(tx, { ...input, generation: input.sourceGeneration });
  const selected = await selectComputerWorkspaceSource(tx, { organizationId: input.organizationId,
    qualificationMode: input.qualificationMode,
    ...(input.config.boat ? { accountScope: input.config.boat.accountScope, billingOrg: input.config.boat.billingOrg } : {}) });
  if (!selected || selected.source.namedSnapshot?.state !== "ready")
    throw new HttpError(409, "cloud_recovery_computer_unavailable", "Build the current Cloud Computer before restoring this workspace.");
  // Match immutable forge identity as well as the name. A removed or replaced
  // repository must not acquire the old checkpoint through a current config.
  const repository = (await tx.query<{ installation_id: string; repository_id: string; repository_owner: string; repository_name: string; checkout_source: unknown }>(
    `SELECT configured.installation_id,configured.repository_id,configured.repository_owner,configured.repository_name,saved.checkout_source
     FROM cloud_workspaces workspace
     JOIN repositories repository ON repository.id=workspace.repository_id AND repository.org_id=workspace.org_id
     JOIN cloud_workspace_computer_sources saved ON saved.workspace_id=workspace.id AND saved.org_id=workspace.org_id AND saved.generation=$3
     JOIN cloud_computer_v2_config_repositories configured ON configured.config_id=$4 AND configured.org_id=workspace.org_id
       AND configured.repository_id=repository.forge_repository_id
       AND configured.repository_owner=lower(workspace.repository_owner) AND configured.repository_name=lower(workspace.repository_name)
     WHERE workspace.id=$1 AND workspace.org_id=$2 AND repository.forge='github.com'`,
    [input.workspaceId,input.organizationId,input.sourceGeneration,selected.source.configId])).rows[0];
  if (!repository)
    throw new HttpError(409, "cloud_recovery_repository_unavailable", "The current Cloud Computer must include this workspace's repository before it can be restored.");
  await resolveComputerRepositoryGrant(tx, { organizationId: input.organizationId, configId: selected.source.configId,
    owner: repository.repository_owner, name: repository.repository_name, repositoryId: repository.repository_id,
    installationId: repository.installation_id });
  return { profile: { ...original.profile, imageRef: selected.imageRef, sourceCommit: selected.sourceCommit,
    architecture: selected.architecture, storageMiB: selected.storageMiB }, runtime: selected.runtime, computer: selected.source,
    installationId: repository.installation_id,
    checkoutSource: repository.checkout_source == null ? null : CloudWorkspaceCheckoutSourceSchema.parse(repository.checkout_source) };
}

export async function pinCheckpointComputerSource(tx: Tx, input: Scope & {
  targetGeneration: number; actorUserId: string; providerConnectionId: string; providerConnectionVersion: number;
  checkpointId: string; selected: CurrentComputerRecovery;
}): Promise<void> {
  const { profile, runtime, computer, checkoutSource } = input.selected;
  await tx.query(`INSERT INTO cloud_workspace_generations
    (workspace_id,generation,org_id,provider,image_ref,architecture,cpu_millicores,memory_mib,storage_mib,source_commit,
     created_by,provider_connection_id,provider_connection_version,sandbox_class,recovery_checkpoint_id,
     runtime_id,runtime_manifest_sha256,runtime_base_image_id,runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [input.workspaceId,input.targetGeneration,input.organizationId,profile.provider,profile.imageRef,profile.architecture,
      profile.cpuMillicores,profile.memoryMiB,profile.storageMiB,profile.sourceCommit,input.actorUserId,input.providerConnectionId,
      input.providerConnectionVersion,profile.sandboxClass ?? null,input.checkpointId,...cloudRuntimePinValues(runtime)]);
  await tx.query(`INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id,checkout_source)
    VALUES($1,$2,$3,$4,$4,$5,$6::jsonb)`, [input.workspaceId,input.targetGeneration,input.organizationId,computer.buildId,
    computer.configId,checkoutSource === null ? null : JSON.stringify(checkoutSource)]);
}

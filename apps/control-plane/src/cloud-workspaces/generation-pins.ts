import { HttpError } from "../authz.js";
import type { CloudWorkspaceProvisioningProfile } from "../config.js";
import type { Tx } from "../db.js";
import { cloudRuntimeQualificationMode, type CloudRuntimeQualificationMode } from "./runtime-config.js";
import { cloudRuntimePin, cloudRuntimePinValues, requirePinnedCloudRuntime, type CloudRuntimePin, type CloudRuntimePinRow } from "./runtime-selection.js";
import { copyComputerWorkspaceSource } from "./computer-workspace-source.js";

type GenerationScope = { workspaceId: string; organizationId: string; generation: number };

export async function loadGenerationSource(tx: Tx, scope: GenerationScope) {
  const row = (await tx.query<CloudRuntimePinRow & CloudWorkspaceProvisioningProfile>(`SELECT
    provider, image_ref AS "imageRef", architecture, cpu_millicores AS "cpuMillicores",
    memory_mib AS "memoryMiB", storage_mib AS "storageMiB", source_commit AS "sourceCommit", sandbox_class AS "sandboxClass",
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile, runtime_engine_protocol_version
    FROM cloud_workspace_generations WHERE workspace_id=$1 AND org_id=$2 AND generation=$3`,
  [scope.workspaceId, scope.organizationId, scope.generation])).rows[0];
  if (!row) throw new HttpError(404, "cloud_generation_not_qualified", "Source generation is unavailable");
  const profile: CloudWorkspaceProvisioningProfile = {
    provider: row.provider, imageRef: row.imageRef, architecture: row.architecture,
    cpuMillicores: row.cpuMillicores, memoryMiB: row.memoryMiB, storageMiB: row.storageMiB,
    sourceCommit: row.sourceCommit, ...(row.sandboxClass ? { sandboxClass: row.sandboxClass } : {}),
  };
  return { profile, runtime: cloudRuntimePin(row) };
}

export async function requireGenerationRuntime(tx: Tx, scope: GenerationScope, mode = cloudRuntimeQualificationMode()) {
  const source = await loadGenerationSource(tx, scope);
  if (source.runtime) await requirePinnedCloudRuntime(tx, source.runtime, mode);
  return source;
}

/** Single generation-copy boundary. Pins must be written in the INSERT: the
 * database forbids even a NULL-to-v4 update. Wake/retry reuse the existing row.
 * Copy the accepted Cloud Computer source in the same transaction. */
export async function copyGenerationPins(tx: Tx, input: {
  workspaceId: string;
  organizationId: string;
  sourceGeneration: number;
  targetGeneration: number;
  actorUserId: string;
  providerConnectionId: string;
  legacyProfile: CloudWorkspaceProvisioningProfile;
  qualificationMode: CloudRuntimeQualificationMode;
  recoveryCheckpointId?: string;
  runtimeUpgrade?: CloudRuntimePin;
}) {
  const source = await loadGenerationSource(tx, { ...input, generation: input.sourceGeneration });
  if (input.runtimeUpgrade && (!source.runtime ||
      input.runtimeUpgrade.baseImageId !== source.runtime.baseImageId ||
      input.runtimeUpgrade.baseCompatibilityId !== source.runtime.baseCompatibilityId)) {
    throw new HttpError(409, "cloud_runtime_base_changed", "A runtime upgrade must keep the generation's base");
  }
  const runtime = input.runtimeUpgrade ?? source.runtime;
  if (runtime) await requirePinnedCloudRuntime(tx, runtime, input.qualificationMode);
  const profile = source.runtime ? source.profile : input.legacyProfile;
  await tx.query(`INSERT INTO cloud_workspace_generations (
    workspace_id, generation, org_id, provider, image_ref, architecture, cpu_millicores, memory_mib,
    storage_mib, source_commit, created_by, provider_connection_id, sandbox_class, recovery_checkpoint_id,
    runtime_id, runtime_manifest_sha256, runtime_base_image_id, runtime_base_compatibility_id, runtime_profile, runtime_engine_protocol_version
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
  [input.workspaceId, input.targetGeneration, input.organizationId, profile.provider, profile.imageRef, profile.architecture,
    profile.cpuMillicores, profile.memoryMiB, profile.storageMiB, profile.sourceCommit, input.actorUserId,
    input.providerConnectionId, profile.sandboxClass ?? null, input.recoveryCheckpointId ?? null, ...cloudRuntimePinValues(runtime)]);
  await copyComputerWorkspaceSource(tx, input);
}

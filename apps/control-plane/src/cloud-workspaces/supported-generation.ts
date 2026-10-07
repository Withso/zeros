import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { loadComputerWorkspaceSource } from "./computer-workspace-source.js";
import { cloudRuntimePin, type CloudRuntimePinRow } from "./runtime-selection.js";

export const CLOUD_WORKSPACE_V2_REQUIRED = "cloud_workspace_v2_required" as const;
export const CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE =
  "This workspace uses a retired cloud runtime — create a new workspace.";

export function cloudWorkspaceV2Required(): HttpError {
  return new HttpError(409, CLOUD_WORKSPACE_V2_REQUIRED, CLOUD_WORKSPACE_V2_REQUIRED_MESSAGE);
}

/** Admission only: historical metadata and settlement remain readable. Never
 * consult the active Computer/channel or migrate an accepted generation here.
 * Callers retain their separate runtime qualification and revocation fences. */
export async function requireSupportedCloudWorkspaceGeneration(
  tx: Tx,
  scope: { organizationId: string; workspaceId: string; generation: number },
) {
  const row = (await tx.query<CloudRuntimePinRow>(
    `SELECT runtime_id,runtime_manifest_sha256,runtime_base_image_id,
            runtime_base_compatibility_id,runtime_profile,runtime_engine_protocol_version
     FROM cloud_workspace_generations
     WHERE workspace_id=$1 AND generation=$2 AND org_id=$3 FOR SHARE`,
    [scope.workspaceId, scope.generation, scope.organizationId],
  )).rows[0];
  if (!row || row.runtime_profile !== "zeros-cloud-worker-v4" ||
    !row.runtime_id || !row.runtime_manifest_sha256 || !row.runtime_base_image_id ||
    !row.runtime_base_compatibility_id || !Number.isSafeInteger(row.runtime_engine_protocol_version) ||
    row.runtime_engine_protocol_version! < 1) throw cloudWorkspaceV2Required();
  const runtimePin = cloudRuntimePin(row)!;
  let source;
  try {
    source = await loadComputerWorkspaceSource(tx, scope);
  } catch (error) {
    if (error instanceof HttpError && error.code === "cloud_computer_build_required")
      throw cloudWorkspaceV2Required();
    throw error;
  }
  if (!source || source.baseImageId !== runtimePin.baseImageId ||
    source.baseCompatibilityId !== runtimePin.baseCompatibilityId)
    throw cloudWorkspaceV2Required();
  return { source, runtimePin };
}

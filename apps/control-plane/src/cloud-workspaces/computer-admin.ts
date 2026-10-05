import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import type { CloudComputerV2AdminWorkspaceRequest } from "./computer-v2-contract.js";
import type { CloudComputerWorkspaceSource } from "./computer-workspace-source.js";
import type { CloudRuntimeQualificationMode } from "./runtime-config.js";
import {
  cloudRuntimePin,
  loadPinnedCloudRuntime,
  type CloudRuntimePinRow,
} from "./runtime-selection.js";

type AdminWorkspaceReceipt = {
  workspace_id: string;
  intent_id: string;
  reused: boolean;
};
type AdminWorkspaceRequest = CloudComputerV2AdminWorkspaceRequest & {
  organizationId: string;
  creatorUserId: string;
};

/** The caller holds the organization create lock and has reauthorized the admin. */
export async function loadAdminWorkspaceReceipt(
  tx: Tx,
  input: AdminWorkspaceRequest,
): Promise<AdminWorkspaceReceipt | null> {
  const receipt = (
    await tx.query<
      AdminWorkspaceReceipt & {
        creator_user_id: string;
        expected_active_version: string;
      }
    >(
      `SELECT workspace_id,intent_id,reused,creator_user_id,expected_active_version
     FROM cloud_computer_admin_workspace_requests WHERE org_id=$1 AND operation_id=$2`,
      [input.organizationId, input.operationId],
    )
  ).rows[0];
  if (!receipt) return null;
  if (receipt.creator_user_id !== input.creatorUserId)
    throw new HttpError(404, "not_found", "Cloud workspace request not found");
  if (Number(receipt.expected_active_version) !== input.expectedActiveVersion)
    throw new HttpError(
      409,
      "idempotency_key_reused",
      "operationId was already used with different parameters.",
    );
  return receipt;
}

export async function recordAdminWorkspaceReceipt(
  tx: Tx,
  input: AdminWorkspaceRequest & {
    workspaceId: string;
    intentId: string;
    reused: boolean;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO cloud_computer_admin_workspace_requests
    (org_id,operation_id,creator_user_id,expected_active_version,workspace_id,intent_id,reused)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.organizationId,
      input.operationId,
      input.creatorUserId,
      input.expectedActiveVersion,
      input.workspaceId,
      input.intentId,
      input.reused,
    ],
  );
}

export async function matchingAdminWorkspace(
  tx: Tx,
  input: {
    organizationId: string;
    creatorUserId: string;
    buildId: string;
    qualificationMode: CloudRuntimeQualificationMode;
  },
): Promise<AdminWorkspaceReceipt | null> {
  const candidates = await tx.query<AdminWorkspaceReceipt & CloudRuntimePinRow>(
    `SELECT workspace.id AS workspace_id,receipt.intent_id,true AS reused,
      generation.runtime_id,generation.runtime_manifest_sha256,generation.runtime_base_image_id,
      generation.runtime_base_compatibility_id,generation.runtime_profile,generation.runtime_engine_protocol_version
    FROM cloud_computer_admin_workspaces admin
    JOIN cloud_workspaces workspace ON workspace.id=admin.workspace_id AND workspace.org_id=admin.org_id
    JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id
      AND generation.org_id=workspace.org_id AND generation.generation=workspace.current_generation
    JOIN cloud_workspace_computer_sources source ON source.workspace_id=generation.workspace_id
      AND source.org_id=generation.org_id AND source.generation=generation.generation
    JOIN workspace_billing_epochs billing ON billing.workspace_id=workspace.id AND billing.org_id=workspace.org_id
      AND billing.billing_epoch=workspace.current_billing_epoch
    JOIN cloud_computer_admin_workspace_requests receipt ON receipt.workspace_id=workspace.id
      AND receipt.org_id=workspace.org_id AND NOT receipt.reused
    WHERE admin.org_id=$1 AND admin.creator_user_id=$2 AND source.build_id=$3
      AND workspace.created_by=$2 AND workspace.owner_user_id=$2 AND workspace.assignee_user_id=$2
      AND billing.billing_owner_user_id=$2 AND workspace.sharing_mode='private'
      AND workspace.deleted_at IS NULL AND workspace.desired_state<>'deleted'
      AND workspace.status NOT IN ('deleting','deleted','failed') AND generation.retired_at IS NULL
      AND generation.runtime_profile='zeros-cloud-worker-v4'
    ORDER BY workspace.created_at DESC,workspace.id DESC FOR UPDATE OF workspace`,
    [input.organizationId, input.creatorUserId, input.buildId],
  );
  for (const candidate of candidates.rows) {
    const pin = cloudRuntimePin(candidate);
    if (pin && (await loadPinnedCloudRuntime(tx, pin, input.qualificationMode)))
      return candidate;
  }
  return null;
}

/** The active build manifest preserves configured order and exact checkout SHAs. */
export async function adminWorkspaceRepository(
  tx: Tx,
  organizationId: string,
  source: CloudComputerWorkspaceSource,
) {
  const primary = source.repositories[0];
  if (!primary)
    throw new HttpError(
      409,
      "cloud_computer_repository_required",
      "Configure at least one repository and build your Cloud Computer before configuring it with an agent.",
    );
  const repository = (
    await tx.query<{ installation_id: string }>(
      `SELECT installation_id FROM cloud_computer_v2_config_repositories
     WHERE org_id=$1 AND config_id=$2 AND position=0 AND repository_id=$3`,
      [organizationId, source.configId, primary.id],
    )
  ).rows[0];
  if (!repository)
    throw new HttpError(
      409,
      "cloud_computer_repository_unavailable",
      "The first Cloud Computer repository is unavailable.",
    );
  return {
    forge: "github.com" as const,
    owner: primary.owner,
    name: primary.name,
    revision: primary.sha,
    githubInstallationId: repository.installation_id,
  };
}

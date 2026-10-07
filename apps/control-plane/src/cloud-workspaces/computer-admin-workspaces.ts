import { z } from "zod";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { requireCloudComputerAuthority } from "./computer-identity.js";
import { cloudRuntimeQualificationMode } from "./runtime-config.js";
import { runtimeCredentialQualificationJoin } from "./runtime-selection.js";

const marker = z.object({
  workspaceId: z.string().uuid(), orgId: z.string().uuid(), creatorUserId: z.string().uuid(),
}).strict();
export function computerToolsRejected(): never {
  throw new HttpError(403, "cloud_agent_authority_rejected", "Agent execution authority is unavailable");
}

/** D1 must call this in its workspace/generation transaction, after normal
 * creation admission. Nothing in a workspace filesystem can author a marker. */
export async function markAdminWorkspace(tx: Tx, value: z.infer<typeof marker>): Promise<void> {
  const parsed = marker.safeParse(value);
  if (!parsed.success) computerToolsRejected();
  const { workspaceId, orgId, creatorUserId } = parsed.data;
  await requireAdmin(tx, orgId, creatorUserId);
  const workspace = await tx.query(`SELECT 1 FROM cloud_workspaces
    WHERE id=$1 AND org_id=$2 AND created_by=$3 AND owner_user_id=$3
      AND assignee_user_id=$3 AND sharing_mode='private' AND deleted_at IS NULL FOR UPDATE`,
  [workspaceId, orgId, creatorUserId]);
  if (!workspace.rowCount) computerToolsRejected();
  await tx.query(`INSERT INTO cloud_computer_admin_workspaces(workspace_id,org_id,creator_user_id)
    VALUES($1,$2,$3)`, [workspaceId, orgId, creatorUserId]);
}

async function requireAdmin(tx: Tx, orgId: string, userId: string) {
  const user = (await tx.query(
    "SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL AND auth_status='active' FOR SHARE", [userId],
  )).rows[0];
  if (!user) throw new HttpError(404, "not_found", "Cloud Computer not found");
  await requireCloudComputerAuthority(tx, orgId, userId, true);
}
export { requireAdmin as requireCloudComputerAdmin };

/** Called only after authenticating/locking the current engine and resolving
 * the initiating actor. Absence is ordinary execution, never an opt-in flag. */
export async function adminComputerToolsVersion(tx: Tx, scope: {
  workspaceId: string; organizationId: string; generation: number; engineInstanceId: string;
}, actorUserId: string, credentialKind: string): Promise<1 | undefined> {
  const admin = (await tx.query<{ creator_user_id: string }>(
    "SELECT creator_user_id FROM cloud_computer_admin_workspaces WHERE workspace_id=$1 AND org_id=$2",
    [scope.workspaceId, scope.organizationId],
  )).rows[0];
  if (!admin) return undefined;
  if (admin.creator_user_id !== actorUserId) computerToolsRejected();
  await requireAdmin(tx, scope.organizationId, actorUserId);
  const runtime = (await tx.query<{ qualified: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM (SELECT $5::text AS kind) credential
      ${runtimeCredentialQualificationJoin("$6", "true")}
    ) AS qualified
    FROM cloud_workspace_engine_instances engine JOIN cloud_workspace_generations generation
      ON generation.workspace_id=engine.workspace_id AND generation.org_id=engine.org_id AND generation.generation=engine.generation
    WHERE engine.id=$1 AND engine.workspace_id=$2 AND engine.org_id=$3 AND engine.generation=$4
      AND engine.runtime_profile='zeros-cloud-worker-v4' AND generation.runtime_profile=engine.runtime_profile`,
  [scope.engineInstanceId, scope.workspaceId, scope.organizationId, scope.generation, credentialKind, cloudRuntimeQualificationMode()])).rows[0];
  if (!runtime) throw new HttpError(409, "cloud_computer_tools_update_required", "Update the cloud runtime to configure this computer.");
  if (!runtime.qualified) computerToolsRejected();
  return 1;
}

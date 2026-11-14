import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { HttpError } from "../authz.js";
import type { CloudV2Workspace } from "./store.js";

type SetupBuildPin = { setupBuildId: string | null; setupLegacy?: true };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const setupSelectionUnavailable = () => new HttpError(409, "cloud_repository_setup_review_required",
  "This workspace's original setup selection could not be verified. Create a new workspace to use the configured repository script.");

/** The replacement disk's build can change; setup keeps the first build's
 * selection, including an absent script. Old journals cannot prove an opt-in. */
export function originalSetupBuild(current: string | null, restore: unknown): SetupBuildPin {
  if (restore === null || restore === undefined) return { setupBuildId: current };
  if (typeof restore !== "object" || Array.isArray(restore)) throw setupSelectionUnavailable();
  const record = restore as Record<string, unknown>;
  if (!Object.hasOwn(record, "setupBuildId")) return { setupBuildId: current, setupLegacy: true };
  if (record.setupBuildId !== null && (typeof record.setupBuildId !== "string" || !UUID.test(record.setupBuildId))) throw setupSelectionUnavailable();
  if (record.setupLegacy !== undefined && record.setupLegacy !== true) throw setupSelectionUnavailable();
  return { setupBuildId: record.setupBuildId as string | null, ...(record.setupLegacy === true ? { setupLegacy: true } : {}) };
}

export async function workspaceSetupBuild(pool: pg.Pool, workspace: CloudV2Workspace, transaction?: Tx): Promise<SetupBuildPin | null> {
  const read = (tx: Tx) => tx.query<{ computer_build_id: string | null; restore_create: unknown }>(
    `SELECT computer_build_id,restore_create FROM cloud_v2_workspaces
     WHERE id=$1 AND org_id=$2 AND creator_user_id=$3 AND state NOT IN ('deleted','deleting')`,
    [workspace.id, workspace.organizationId, workspace.creatorUserId]);
  const { rows } = await (transaction ? read(transaction) : withSystemTx(pool, read));
  return rows[0] ? originalSetupBuild(rows[0].computer_build_id, rows[0].restore_create) : null;
}

import type pg from "pg";
import { withSystemTx } from "../db.js";
import type { CloudGithubPrStore } from "./github-pr-store.js";
import type { CloudV2Workspace } from "./store.js";
import type { CloudGithubWorkspaceDocument } from "./routes.js";
import { CLOUD_V2_LIVE_ACCESS } from "./workspace-access.js";

export function createCloudGithubCatalog(deps: { pool: pg.Pool; metadata: CloudGithubPrStore }) {
  return async (rows: readonly CloudV2Workspace[]): Promise<CloudGithubWorkspaceDocument[]> => {
    if (!rows.length) return [];
    return withSystemTx(deps.pool, async tx => {
      const enriched = new Map((await deps.metadata.documents(rows.filter(row => !row.sourcePending), undefined, tx)).map(row => [row.id, row]));
      // A provider outage or a person's GitHub selection cannot hide shared
      // checkout metadata. Membership still has to survive the metadata read.
      const current = await tx.query<{ id: string }>(`SELECT w.id FROM cloud_v2_workspaces w
        JOIN unnest($1::uuid[],$2::uuid[]) AS before(id,creator) ON before.id=w.id AND before.creator IS NOT DISTINCT FROM w.creator_user_id
        WHERE w.state<>'deleted' AND ${CLOUD_V2_LIVE_ACCESS}`,
      [rows.map(row => row.id), rows.map(row => row.creatorUserId)]);
      const allowed = new Set(current.rows.map(row => row.id));
      return rows.filter(row => allowed.has(row.id)).map(row => enriched.get(row.id) ?? row);
    });
  };
}

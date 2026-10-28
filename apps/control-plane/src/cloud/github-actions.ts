import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";

/** Durable short lease, with no transaction/connection held over GitHub I/O.
 * A failed request is never retried here. The API's operation-specific recovery
 * reconciles ambiguous creates; comments and merges retain their outcome. */
export class CloudGithubActions {
  private readonly current = new AsyncLocalStorage<{
    workspaceId: string;
    lease: string;
  }>();
  constructor(private readonly pool: pg.Pool) {}
  async assertCurrent(workspaceId: string): Promise<void> {
    const action = this.current.getStore();
    if (!action || action.workspaceId !== workspaceId) return;
    const { rows } = await withSystemTx(this.pool, (tx) =>
      tx.query(
        `SELECT 1 FROM cloud_v2_github_workspaces
      WHERE workspace_id=$1 AND mutation_lease=$2 AND mutation_until>clock_timestamp()+interval '20 seconds'`,
        [workspaceId, action.lease],
      ),
    );
    if (!rows.length)
      throw new HttpError(
        409,
        "github_action_expired",
        "This pull request action expired. Refresh before trying again.",
      );
  }
  async run<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const lease = randomUUID();
    const { rowCount } = await withSystemTx(this.pool, (tx) =>
      tx.query(
        `INSERT INTO cloud_v2_github_workspaces(workspace_id,mutation_lease,mutation_until)
      VALUES($1,$2,clock_timestamp()+interval '3 minutes') ON CONFLICT(workspace_id) DO UPDATE SET
      mutation_lease=EXCLUDED.mutation_lease,mutation_until=EXCLUDED.mutation_until
      WHERE cloud_v2_github_workspaces.mutation_lease IS NULL OR cloud_v2_github_workspaces.mutation_until<clock_timestamp() RETURNING workspace_id`,
        [workspaceId, lease],
      ),
    );
    if (!rowCount)
      throw new HttpError(
        409,
        "github_action_in_progress",
        "Another pull request action is running. Wait for it to finish.",
      );
    try {
      return await this.current.run({ workspaceId, lease }, action);
    } finally {
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          "UPDATE cloud_v2_github_workspaces SET mutation_lease=NULL,mutation_until=NULL WHERE workspace_id=$1 AND mutation_lease=$2",
          [workspaceId, lease],
        ),
      ).catch(() => {});
    }
  }
}

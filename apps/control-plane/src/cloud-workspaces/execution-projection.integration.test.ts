import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

type ExecutionRow = {
  generation: number;
  authority_epoch: string;
  state: string;
  ended_at: Date | null;
};

d("cloud workspace execution projection", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  async function executions(workspaceId: string): Promise<ExecutionRow[]> {
    return (
      await pool.query<ExecutionRow>(
        `SELECT generation, authority_epoch::text, state, ended_at
         FROM workspace_executions
         WHERE workspace_id = $1
         ORDER BY generation`,
        [workspaceId],
      )
    ).rows;
  }

  it("projects stop, wake, generation switch, retirement, and failure atomically", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspaces
         SET desired_state = 'stopped', status = 'stopping',
             authority_epoch = authority_epoch + 1
         WHERE id = $1`,
        [fixture.workspaceId],
      ),
    );
    expect(await executions(fixture.workspaceId)).toMatchObject([
      { generation: 1, authority_epoch: "2", state: "stopped" },
    ]);
    expect((await executions(fixture.workspaceId))[0]!.ended_at).not.toBeNull();

    await withSystemTx(pool, (tx) =>
      tx.query(
        `UPDATE cloud_workspaces
         SET desired_state = 'running', status = 'waking',
             authority_epoch = authority_epoch + 1
         WHERE id = $1`,
        [fixture.workspaceId],
      ),
    );
    expect(await executions(fixture.workspaceId)).toEqual([
      {
        generation: 1,
        authority_epoch: "3",
        state: "provisioning",
        ended_at: null,
      },
    ]);

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         )
         SELECT workspace_id, 2, org_id, provider, image_ref, architecture,
                cpu_millicores, memory_mib, storage_mib, source_commit,
                created_by, provider_connection_id
         FROM cloud_workspace_generations
         WHERE workspace_id = $1 AND generation = 1`,
        [fixture.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspaces
         SET current_generation = 2, status = 'provisioning',
             authority_epoch = authority_epoch + 1
         WHERE id = $1`,
        [fixture.workspaceId],
      );
    });

    const switched = await executions(fixture.workspaceId);
    expect(switched).toMatchObject([
      { generation: 1, state: "retired" },
      { generation: 2, authority_epoch: "4", state: "provisioning" },
    ]);
    expect(switched[0]!.ended_at).not.toBeNull();
    expect(switched[1]!.ended_at).toBeNull();

    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `UPDATE cloud_workspaces SET status = 'failed' WHERE id = $1`,
        [fixture.workspaceId],
      );
      await tx.query(
        `UPDATE cloud_workspace_generations
         SET retired_at = now()
         WHERE workspace_id = $1 AND generation = 2`,
        [fixture.workspaceId],
      );
    });
    expect(await executions(fixture.workspaceId)).toMatchObject([
      { generation: 1, state: "retired" },
      { generation: 2, state: "retired" },
    ]);
  });

  it("enforces one live execution per workspace across authority epochs", async () => {
    const fixture = await seedReadyCloudWorkspace(pool);
    await withSystemTx(pool, async (tx) => {
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by, provider_connection_id
         )
         SELECT workspace_id, 2, org_id, provider, image_ref, architecture,
                cpu_millicores, memory_mib, storage_mib, source_commit,
                created_by, provider_connection_id
         FROM cloud_workspace_generations
         WHERE workspace_id = $1 AND generation = 1`,
        [fixture.workspaceId],
      );
      await expect(
        tx.query(
          `INSERT INTO workspace_executions (
             workspace_id, execution_id, org_id, generation,
             authority_epoch, placement, state
           ) VALUES ($1, $2, $3, 2, 999, 'cloud', 'active')`,
          [fixture.workspaceId, randomUUID(), fixture.organizationId],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });
  });
});

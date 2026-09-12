import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withSystemTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  CloudWorkspaceOutboxDeliveryError,
  CloudWorkspaceOutboxWorker,
  type CloudWorkspaceOutboxEvent,
  type CloudWorkspaceOutboxSink,
} from "./outbox.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace transactional outbox", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  it("rejects an empty worker identity before it can create an unclaimable lease", () => {
    expect(
      () =>
        new CloudWorkspaceOutboxWorker(
          pool,
          { deliver: async () => undefined },
          { workerId: "" },
        ),
    ).toThrow("worker identity is invalid");
  });

  async function event(): Promise<string> {
    const fixture = await seedReadyCloudWorkspace(pool);
    const id = randomUUID();
    await withSystemTx(pool, (tx) =>
      tx.query(
        `INSERT INTO cloud_workspace_outbox (
           id, org_id, workspace_id, event_type, aggregate_key,
           aggregate_revision, idempotency_key, payload
         ) VALUES ($1, $2, $3, 'workspace.test_event', $4, 1, $5, $6::jsonb)`,
        [
          id,
          fixture.organizationId,
          fixture.workspaceId,
          `workspace-test:${fixture.workspaceId}`,
          `test:${randomUUID()}`,
          JSON.stringify({ workspaceId: fixture.workspaceId }),
        ],
      ),
    );
    return id;
  }

  it("leases one event to only one replica and marks it delivered", async () => {
    const id = await event();
    const delivered: CloudWorkspaceOutboxEvent[] = [];
    const sink: CloudWorkspaceOutboxSink = {
      deliver: vi.fn(async (value) => {
        delivered.push(value);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }),
    };
    const first = new CloudWorkspaceOutboxWorker(pool, sink, {
      workerId: "test-outbox-a",
    });
    const second = new CloudWorkspaceOutboxWorker(pool, sink, {
      workerId: "test-outbox-b",
    });
    await Promise.all([first.runOnce(), second.runOnce()]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ id, attempt: 1 });
    expect(
      (
        await pool.query(
          `SELECT state, attempt_count, lease_owner, completed_at
           FROM cloud_workspace_outbox WHERE id = $1`,
          [id],
        )
      ).rows[0],
    ).toMatchObject({
      state: "succeeded",
      attempt_count: 1,
      lease_owner: null,
    });
  });

  it("requeues retryable failures and dead-letters permanent failures", async () => {
    const retryId = await event();
    const retry = new CloudWorkspaceOutboxWorker(
      pool,
      {
        deliver: async () => {
          throw new CloudWorkspaceOutboxDeliveryError("sink_busy", true);
        },
      },
      { workerId: "test-outbox-retry", maxAttempts: 3, logger: console },
    );
    await retry.runOnce();
    expect(
      (
        await pool.query(
          `SELECT state, attempt_count, last_error_code,
                  next_attempt_at > now() AS delayed
           FROM cloud_workspace_outbox WHERE id = $1`,
          [retryId],
        )
      ).rows[0],
    ).toEqual({
      state: "queued",
      attempt_count: 1,
      last_error_code: "sink_busy",
      delayed: true,
    });

    await pool.query(
      `UPDATE cloud_workspace_outbox SET next_attempt_at = now() WHERE id = $1`,
      [retryId],
    );
    const permanent = new CloudWorkspaceOutboxWorker(
      pool,
      {
        deliver: async () => {
          throw new CloudWorkspaceOutboxDeliveryError("sink_rejected", false);
        },
      },
      { workerId: "test-outbox-dead", logger: console },
    );
    await permanent.runOnce();
    expect(
      (
        await pool.query(
          `SELECT state, attempt_count, last_error_code,
                  completed_at IS NOT NULL AS completed
           FROM cloud_workspace_outbox WHERE id = $1`,
          [retryId],
        )
      ).rows[0],
    ).toEqual({
      state: "dead",
      attempt_count: 2,
      last_error_code: "sink_rejected",
      completed: true,
    });
  });
});

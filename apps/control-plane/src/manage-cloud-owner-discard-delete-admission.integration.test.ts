import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "./db.js";
import { resetMigratedTestDatabase } from "./test-database.js";
import { manageCloudOwnerDiscardDelete } from "./manage-cloud-owner-discard-delete.js";
import { ownerDiscardDeleteRequest, seedOwnerDiscardDelete } from "./cloud-workspaces/owner-discard-delete-test-fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve: () => resolve() };
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("W3 owner Delete admission races", () => {
  let pool: pg.Pool;
  let app: pg.Pool;
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6 });
    app = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: "-c role=zeros_app", max: 2 });
  });
  afterAll(async () => { await app.end(); await pool.end(); });
  beforeEach(async () => resetMigratedTestDatabase(pool));
  const options = () => ({ databaseUrl: process.env.TEST_DATABASE_URL! });

  async function fixture() {
    const f = await seedOwnerDiscardDelete(pool, { crashedReady: true });
    const historicalId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents
      (id,workspace_id,org_id,generation,operation,state,completed_at,idempotency_key,request_sha256,affects_workspace)
      VALUES($1::uuid,$2,$3,1,'stop','superseded',now(),$1::text,digest($1::text,'sha256'),false)`,
    [historicalId, f.workspaceId, f.organizationId]);
    const request = await ownerDiscardDeleteRequest(pool, f);
    const plan = await manageCloudOwnerDiscardDelete(pool, request, options());
    return { ...f, historicalId, request, plan };
  }

  function pauseAfterReceipt() {
    const inserted = latch(), resume = latch();
    const gated = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (text: string, values?: unknown[]) => {
            const result = await client.query(text, values);
            if (text.includes("INSERT INTO cloud_workspace_owner_delete_receipts")) {
              inserted.resolve();
              await resume.promise;
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    } as unknown as pg.Pool;
    return { inserted, resume, pool: gated };
  }

  it.each(["source", "historical"] as const)("does not commit a plan after %s intent attempt drift behind an uncommitted receipt", async kind => {
    const f = await fixture(), gate = pauseAfterReceipt();
    const id = kind === "source" ? f.stopId : f.historicalId;
    const running = manageCloudOwnerDiscardDelete(gate.pool, f.request, { ...options(), execute: true, approval: f.plan.approval })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await Promise.race([gate.inserted.promise, running.then(result => { throw result.error ?? new Error("Receipt gate not reached"); })]);
    let mutationRefusal: string | undefined;
    try {
      // This is the real app-role transaction with the operator holding the
      // workspace lock, not a simulated row update or timer race.
      await withSystemTx(app, async tx => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        await tx.query("UPDATE cloud_workspace_lifecycle_intents SET attempt_count=attempt_count+1 WHERE id=$1", [id]);
      });
    } catch (error) { mutationRefusal = (error as { code?: string }).code; }
    finally { gate.resume.resolve(); }
    const result = await running;
    if (mutationRefusal) expect(["55P03", "40001", "23514"]).toContain(mutationRefusal);
    if (result.error) {
      expect(result.error).toMatchObject({ code: "40001" });
      expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
      return;
    }
    expect(result.value?.state).toBe("deleting");
    const approved = (await pool.query(`SELECT (entry->>'attemptCount')::int AS attempts
      FROM cloud_workspace_owner_delete_receipts receipt, jsonb_array_elements(receipt.source->'history') entry
      WHERE receipt.id=$1 AND entry->>'id'=$2`, [f.request.operationId, id])).rows[0].attempts;
    expect(approved).toBe(0);
    const actual = (await pool.query("SELECT attempt_count FROM cloud_workspace_lifecycle_intents WHERE id=$1", [id])).rows[0].attempt_count;
    expect(actual).toBe(approved);
  });

  it("control: a late content append is serialized before the first receipt is visible", async () => {
    const f = await fixture(), gate = pauseAfterReceipt();
    const running = manageCloudOwnerDiscardDelete(gate.pool, f.request, { ...options(), execute: true, approval: f.plan.approval })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await Promise.race([gate.inserted.promise, running.then(result => { throw result.error ?? new Error("Receipt gate not reached"); })]);
    try {
      await expect(withSystemTx(app, async tx => {
        await tx.query("SET LOCAL lock_timeout='250ms'");
        await tx.query("UPDATE workspace_content_heads SET current_revision=current_revision+1 WHERE workspace_id=$1", [f.workspaceId]);
      })).rejects.toMatchObject({ code: "55P03" });
    } finally { gate.resume.resolve(); }
    const result = await running;
    expect(result.error).toBeUndefined();
    expect(result.value?.state).toBe("deleting");
    expect((await pool.query("SELECT current_revision FROM workspace_content_heads WHERE workspace_id=$1", [f.workspaceId])).rows[0].current_revision).toBe("12");
  });

  it("control: a historical request digest changed before execution requires new approval", async () => {
    const f = await fixture();
    await withSystemTx(app, tx => tx.query("UPDATE cloud_workspace_lifecycle_intents SET request_sha256=digest('w3 changed request','sha256') WHERE id=$1", [f.historicalId]));
    await expect(manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.plan.approval }))
      .rejects.toMatchObject({ code: "owner_delete_approval_mismatch" });
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_workspace_owner_delete_receipts")).rows[0].n).toBe(0);
  });

  it("control: retry scheduling changes do not invalidate the exact approved source", async () => {
    const f = await fixture();
    await withSystemTx(app, tx => tx.query(`UPDATE cloud_workspace_final_save_recoveries SET retry_count=retry_count+1,
      next_attempt_at=now()+interval '10 seconds',last_checked_at=now(),updated_at=now() WHERE lifecycle_intent_id=$1`, [f.stopId]));
    expect(await manageCloudOwnerDiscardDelete(pool, f.request, { ...options(), execute: true, approval: f.plan.approval }))
      .toMatchObject({ state: "deleting" });
  });
});

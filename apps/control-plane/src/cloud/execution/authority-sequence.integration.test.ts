import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

// A new R2 boot starts at the workspace's current authority sequence (default-create.integration.test.ts); that start
// must never hide an event that lands after the bind.
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("an R2 boot's authority acknowledgement", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool, { teamOwnership: true }); await f.login(); await f.activate(); });
  afterEach(async () => { await f?.close(); });
  afterAll(() => pool.end());

  const r2 = () => `${f.features},message-authority-v1`;
  const authority = async (acked: string, contextIds: string[] = []) => (await f.worker("execution-leases/authority", { acked, contextIds }, { features: r2() })).json();
  const sequence = async () => (await withSystemTx(pool, tx => tx.query("SELECT coalesce(max(id),0)::text AS n FROM cloud_v2_authority_events WHERE workspace_id=$1", [f.workspace.id]))).rows[0].n as string;
  const stored = async () => (await pool.query("SELECT authority_mode,authority_acked_sequence::text AS acked FROM cloud_v2_execution_boots WHERE boot_id=$1", [f.boot])).rows[0];

  it("an event after the boot's bind stays pending until this boot acknowledges it; a re-hello of the same boot does not acknowledge it", async () => {
    const hello = await f.hello(r2());
    expect(hello.status).toBe(200);
    const mode = await stored();
    expect(mode.authority_mode).toBe("message-authority-v1");
    expect(mode.acked).toBe("0");
    const turn = await f.dispatch(f.prompt(), f.viewer);
    expect((await f.worker("turn-lease", turn.lease, { features: r2() })).status).toBe(200);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_execution_contexts SET state='revoked',reason='access_revoked',revoked_at=clock_timestamp() WHERE id=$1", [turn.begun.contextId]));
    const head = await sequence();
    expect(Number(head)).toBeGreaterThan(0);
    await f.cp.authorityBarrier.tick();
    const pending = await authority("0", [turn.begun.contextId]);
    expect(pending).toMatchObject({ sequence: head, fresh: false, ended: [{ contextId: turn.begun.contextId, reason: "access_revoked" }] });
    // The same boot says hello again (a reconnect): its stored acknowledgement must not jump to the head.
    const again = await f.worker("hello", { protocol: 2, bootId: f.boot, runtimeSha256: "b".repeat(64) }, { features: r2() });
    expect(again.status).toBe(200);
    expect((await stored()).acked).toBe("0");
    await f.cp.authorityBarrier.tick();
    expect(await authority("0")).toMatchObject({ fresh: false });
    // The worker acknowledges; the next barrier read is fresh.
    await authority(head);
    expect((await stored()).acked).toBe(head);
    await f.cp.authorityBarrier.tick();
    expect(await authority(head)).toMatchObject({ sequence: head, fresh: true });
    // A worker that lost its own counter (claims 0) is still fresh on the stored acknowledgement.
    expect(await authority("0")).toMatchObject({ sequence: head, fresh: true });
  });
});

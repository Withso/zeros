// A workspace whose creator path lost access (Hold, an organization losing
// cloud, a Personal owner's Pro ending) can never report its pending prompts:
// the worker is refused. Those prompts must not hold the idle stop open forever.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureCloudPersonal } from "../db-context.js";
import { CLOUD_V2_IDLE_STOP_MS } from "./lifecycle.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("the idle stop after the creator path loses access", () => {
  let pool: pg.Pool, f: ExecutionFixture | undefined;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); f = undefined; configureCloudPersonal(pool, false); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());

  /** Running, last active `minutes` ago, with one prompt the worker had accepted. */
  async function running(fixture: ExecutionFixture, minutes: number) {
    const id = fixture.workspace.id;
    expect((await fixture.send()).status).toBe(201);
    await pool.query(`UPDATE cloud_v2_workspaces SET state='running',worker_boot_id=$2,active_at=clock_timestamp()-$3*interval '1 minute' WHERE id=$1`,
      [id, randomUUID(), minutes]);
    await pool.query("UPDATE cloud_v2_prompt_outbox p SET state='accepted',access_epoch=w.access_epoch FROM cloud_v2_workspaces w WHERE w.id=p.workspace_id AND w.id=$1", [id]);
    return id;
  }
  const cutoff = () => new Date(Date.now() - CLOUD_V2_IDLE_STOP_MS);
  const idle = async (fixture: ExecutionFixture, id: string) => (await fixture.cp.store.idleSince(cutoff())).some(row => row.id === id);
  const state = async (id: string) => (await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [id])).rows[0].state;
  const prompt = async (id: string) => (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [id])).rows[0].state;

  it("a pending prompt still holds the idle stop while the creator has access", async () => {
    f = await executionFixture(pool);
    const id = await running(f, 21);
    expect(await idle(f, id)).toBe(false);
    await f.cp.store.stopIdle(id, cutoff());
    expect(await state(id)).toBe("running");
  });

  it.each([
    ["the organization loses cloud", (fixture: ExecutionFixture) => pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [fixture.organizationId])],
    ["the creator leaves the organization", (fixture: ExecutionFixture) => pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [fixture.organizationId, fixture.creator.id])],
  ] as const)("stops an organization's workspace 20 minutes after its last activity when %s, with a prompt pending", async (_name, lose) => {
    f = await executionFixture(pool);
    const id = await running(f, 19);
    await lose(f);
    expect(await idle(f, id)).toBe(false);
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '21 minutes' WHERE id=$1", [id]);
    expect(await idle(f, id)).toBe(true);
    await f.cp.store.stopIdle(id, cutoff());
    expect(await state(id)).toBe("stopping");
    // The prompt is kept: the stop does not drop it.
    expect(await prompt(id)).toBe("accepted");
  });

  it("stops a Personal workspace whose owner's Pro ended mid-turn, 20 minutes after its last activity", async () => {
    f = await executionFixture(pool, { personal: true });
    const id = await running(f, 21);
    expect(await idle(f, id)).toBe(false);
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [f.creator.id]);
    expect(await idle(f, id)).toBe(true);
    await f.cp.store.stopIdle(id, cutoff());
    expect(await state(id)).toBe("stopping");
    expect(await prompt(id)).toBe("accepted");
  });

  /** Running, last active `minutes` ago, with one prompt sent and never started. */
  async function queued(fixture: ExecutionFixture, minutes: number) {
    const id = fixture.workspace.id;
    expect((await fixture.send()).status).toBe(201);
    await pool.query(`UPDATE cloud_v2_workspaces SET state='running',worker_boot_id=$2,active_at=clock_timestamp()-$3*interval '1 minute' WHERE id=$1`,
      [id, randomUUID(), minutes]);
    expect(await prompt(id)).toBe("queued");
    return id;
  }
  const outbox = async (id: string) => (await pool.query("SELECT state,terminal_at IS NOT NULL AS terminal,payload IS NOT NULL AS payload FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [id])).rows[0];

  it("ends prompts never started once the idle stop is taken after access ended by the clock; nothing runs on reopen", async () => {
    // A Pro window closing writes nothing, so only the stop ends them: fence_cloud_v2_prompts (0202) cancels
    // every queued or inboxed prompt when a workspace starts stopping, as for any Stop.
    f = await executionFixture(pool, { personal: true });
    const id = await queued(f, 21);
    await pool.query("UPDATE account_entitlements SET valid_from=clock_timestamp()-interval '1 day',valid_until=clock_timestamp()-interval '1 second' WHERE user_id=$1", [f.creator.id]);
    expect(await prompt(id)).toBe("queued");
    await f.cp.store.stopIdle(id, cutoff());
    expect(await state(id)).toBe("stopping");
    // Its payload is released with every terminal prompt's, seven days on.
    expect(await outbox(id)).toEqual({ state: "cancelled", terminal: true, payload: true });
    // Access back, the workspace opened on a new boot: nothing old runs, and the transcript shows it cancelled.
    await pool.query("UPDATE account_entitlements SET valid_until=NULL WHERE user_id=$1", [f.creator.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [id]);
    const token = await f.cp.store.rotateWorkerToken(id), boot = randomUUID();
    await pool.query("UPDATE cloud_v2_workspaces SET worker_boot_id=$2 WHERE id=$1", [id, boot]);
    expect((await f.cp.store.prompts.pull(token, boot)).prompts).toEqual([]);
    const transcript = await f.call(`/v1/cloud-v2/workspaces/${id}/prompts?chatId=chat&after=0&includePayload=false`);
    expect(transcript.status).toBe(200);
    expect((await transcript.json()).items.map((row: { state: string }) => row.state)).toEqual(["cancelled"]);
  });

  it("leaves a queued prompt untouched while the workspace has access", async () => {
    f = await executionFixture(pool);
    const id = await queued(f, 21);
    await f.cp.store.stopIdle(id, cutoff());
    expect(await state(id)).toBe("running");
    expect(await outbox(id)).toEqual({ state: "queued", terminal: false, payload: true });
  });
});

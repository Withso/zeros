import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystemTx } from "../db.js";
import { newCloudV2Token } from "./tokens.js";
import { executionFixture, type ExecutionFixture } from "./execution/test-fixture.js";

// These routes skip the separate worker-session read (one transaction each) because their handlers verify the worker
// again inside their own transaction. This table is that safety argument: a stale worker is refused and changes nothing.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("worker routes that verify the worker inside their own transaction", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  const features = () => `${f.features},history-replace-v1,history-digest-v1,chat-edit-v1,history-batch-v1,begin-lease-v1`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.login(); await f.activate();
    expect((await f.hello(features())).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); await f?.cp.teamSharing.signals.close(); });

  const routes = (bootId: string): Array<[string, unknown]> => [
    ["history", { t: "history", bootId, sequence: 1, chats: [{ id: "stale" }] }],
    ["history/batch", { bootId, sequence: 1, frames: [{ chats: [{ id: "stale" }] }] }],
    ["prompts/ack", { userMessageId: randomUUID(), deliveryId: randomUUID() }],
    ["prompts/begin", { userMessageId: randomUUID(), deliveryId: randomUUID(), dispatchId: randomUUID() }],
    ["prompts/outcome", { userMessageId: randomUUID(), deliveryId: randomUUID(), state: "failed" }],
    ["prompts/stop-ack", { chatId: "stale", epoch: "1" }],
    ["prompts/stop", { chatId: "stale", throughEpoch: "0" }],
    ["turn-lease", { chatId: "stale", userMessageId: randomUUID(), dispatchId: randomUUID(), generation: "1", contextId: randomUUID() }],
    [`execution-leases/${randomUUID()}/retired`, { retirementId: randomUUID(), reason: "outcome", processes: 0 }],
  ];
  const states: Array<[string, () => Promise<{ token?: string; boot?: string }>]> = [
    ["another boot", async () => ({ boot: randomUUID() })],
    ["an unknown token", async () => ({ token: newCloudV2Token("worker").token })],
    ["a deleting workspace", async () => { await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET state='deleting' WHERE id=$1", [f.workspace.id])); return {}; }],
    ["a stopped workspace", async () => { await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id])); return {}; }],
    ["an organization without cloud access", async () => {
      await withSystemTx(pool, tx => tx.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId])); return {}; }],
  ];

  it.each(states)("refuses %s on every such route, and writes nothing", async (_name, prepare) => {
    const options = await prepare();
    const before = (await pool.query("SELECT worker_history_sequence FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0];
    for (const [path, body] of routes(options.boot ?? f.boot)) {
      const response = await f.worker(path, body, { features: features(), ...options });
      expect([path, response.status]).toEqual([path, 401]);
    }
    expect((await pool.query("SELECT worker_history_sequence FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0]).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_chats WHERE workspace_id=$1 AND chat_id='stale'", [f.workspace.id])).rows[0].n).toBe(0);
  });
});

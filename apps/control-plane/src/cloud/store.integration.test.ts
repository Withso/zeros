import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2Store } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;

d("cloud v2 store", () => {
  let pool: pg.Pool;
  let store: CloudV2Store;
  let org: string;
  let creator: string;
  let member: string;

  async function user(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'User')`, [id, `u-${id}@example.test`]);
    return id;
  }

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool);
    creator = await user();
    member = await user();
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1, $2, 'Org', $3, false, true)`, [org, `org-${org}`, creator]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [org, creator, member]);
  });

  const create = () => store.createWorkspace({
    id: randomUUID(), organizationId: org, creatorUserId: creator, name: "zeros", repository: "withso/zeros", branch: "zeros/w", baseBranch: "main",
    computerBuildId: null,
  });

  it("creates a workspace only its creator can read, and returns the worker token once", async () => {
    const workspace = await create();
    expect(workspace.state).toBe("creating");
    const workerToken = await store.rotateWorkerToken(workspace.id);
    expect(workerToken).toMatch(/^zw2w_/);
    expect((await store.get(workspace.id, creator)).id).toBe(workspace.id);
    await expect(store.get(workspace.id, member)).rejects.toMatchObject({ status: 404 });
    expect(await store.list(org, member)).toEqual([]);
    expect((await store.byWorkerToken(workerToken))?.id).toBe(workspace.id);
    const stored = await pool.query(`SELECT worker_token_hash FROM cloud_v2_workspaces WHERE id = $1`, [workspace.id]);
    expect(stored.rows[0].worker_token_hash.toString("utf8")).not.toContain(workerToken);
  });

  it("refuses non-members, personal organizations and organizations without cloud", async () => {
    const outsider = await user();
    await expect(store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: outsider, name: "x", repository: "o/r",
      branch: "main", baseBranch: "main", computerBuildId: null })).rejects.toMatchObject({ status: 404 });
    await pool.query(`UPDATE organizations SET cloud_workspaces_allowed = false WHERE id = $1`, [org]);
    await expect(create()).rejects.toMatchObject({ status: 404 });
  });

  it("moves state only from the expected states and forgets the worker on delete", async () => {
    const workspace = await create();
    const workerToken = await store.rotateWorkerToken(workspace.id);
    expect(await store.transition(workspace.id, ["stopped"], "starting")).toBeNull();
    expect((await store.transition(workspace.id, ["creating"], "running", { boatSandboxId: "bx_abc" }))?.boatSandboxId).toBe("bx_abc");
    expect((await store.transition(workspace.id, ["running"], "deleted"))?.state).toBe("deleted");
    expect(await store.byWorkerToken(workerToken)).toBeNull();
    await expect(store.get(workspace.id, creator)).rejects.toMatchObject({ status: 404 });
  });

  it("consumes a connect ticket exactly once, and only for its workspace and creator", async () => {
    const workspace = await create();
    const other = await create();
    const { token } = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator, ttlMs: 60_000 });
    expect(await store.consumeConnectTicket(token, other.id)).toBeNull();
    expect(await store.consumeConnectTicket(token, workspace.id)).toEqual({ userId: creator });
    expect(await store.consumeConnectTicket(token, workspace.id)).toBeNull();
    const expired = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator, ttlMs: -1 });
    expect(await store.consumeConnectTicket(expired.token, workspace.id)).toBeNull();
  });

  it("mirrors chats and rows in Local's order, keeping first-insert position on update", async () => {
    const workspace = await create();
    await store.writeHistory(workspace.id, { chats: [{ id: "c1", title: "One" } as { id: string }] });
    const row = (msgId: string, text: string) => ({ msgId, kind: "agent", payload: JSON.stringify({ id: msgId, text }), createdAt: 1 });
    await store.writeHistory(workspace.id, { messages: { chatId: "c1", rows: [row("m1", "a"), row("m2", "b")] } });
    await store.writeHistory(workspace.id, { messages: { chatId: "c1", rows: [row("m1", "a, edited")] } });
    expect((await store.windowMessages(workspace.id, "c1", 10)).map(r => [r.msgId, JSON.parse(r.payload).text])).toEqual([["m1", "a, edited"], ["m2", "b"]]);
    expect((await store.windowMessages(workspace.id, "c1", 1)).map(r => r.msgId)).toEqual(["m2"]);
    await store.writeHistory(workspace.id, { chatDeletions: ["c1"] });
    expect(await store.listChats(workspace.id)).toEqual({ chats: [], chatDeletions: ["c1"] });
    expect(await store.windowMessages(workspace.id, "c1", 10)).toEqual([]);
  });

  it("verifies proxy tokens only while the workspace runs", async () => {
    const workspace = await create();
    const { token } = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    expect(await store.verifyProxyToken(token)).toBeNull();
    await store.transition(workspace.id, ["creating"], "running");
    expect((await store.verifyProxyToken(token))?.id).toBe(workspace.id);
  });
});

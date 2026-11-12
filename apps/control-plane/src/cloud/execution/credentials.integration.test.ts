import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("per-context API and broker authority", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 4000 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); await f.login(f.viewer); await f.activate(); expect((await f.hello()).status).toBe(200); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const api = (token: string, path: string, body?: unknown) => f.app.request(`/api/v0/${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it("attributes a turn token to its caller across chats, and keeps an accepted send after its origin ends", async () => {
    const member = await f.dispatch(f.prompt(randomUUID(), { chatId: "member-chat" }), f.viewer);
    const creator = await f.dispatch(f.prompt(randomUUID(), { chatId: "creator-chat" }));
    const leaseResponse = await f.worker("turn-lease", member.lease); expect(leaseResponse.status).toBe(200);
    const lease = await leaseResponse.json();
    const me = await api(lease.api.token, "me"); expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ userId: f.viewer.id, credential: "workspace_token" });
    const sentId = randomUUID(), sent = await api(lease.api.token, "sessions/creator-chat/messages", { message: "Member's follow-up", messageId: sentId });
    expect(sent.status).toBe(201);
    expect((await pool.query("SELECT creator_user_id,sender_context_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, sentId])).rows[0])
      .toEqual({ creator_user_id: f.viewer.id, sender_context_id: member.begun.contextId });
    expect((await f.worker("prompts/outcome", { userMessageId: member.input.userMessageId, dispatchId: member.begin.dispatchId, state: "completed" })).status).toBe(200);
    expect((await api(lease.api.token, "me")).status).toBe(401);
    expect((await pool.query("SELECT state,cancel_requested FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [f.workspace.id, sentId])).rows[0])
      .toEqual({ state: "queued", cancel_requested: false });
    expect((await f.worker("turn-lease", creator.lease)).status).toBe(200);
  });

  it("permits member API keys on an activated direct target but refuses without that person's agent login", async () => {
    const key = await f.cp.api.credentials.create(f.organizationId, f.admin.id, "Fixture");
    const response = await api(key.key, "sessions", { workspaceId: f.workspace.id, agent: "claude", message: "No login", sessionId: "admin-chat", messageId: randomUUID() });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "agent_login_required", agent: "claude" } });
    await f.login(f.admin);
    const accepted = await api(key.key, "sessions", { workspaceId: f.workspace.id, agent: "claude", message: "Personal login", sessionId: "admin-chat", messageId: randomUUID() });
    expect(accepted.status).toBe(201);
    expect((await api(key.key, `workspaces/${f.workspace.id}`)).status).toBe(200);
    expect((await api(key.key, "workspaces")).status).toBe(200);
    expect((await (await api(key.key, "workspaces")).json()).data).toEqual([]);
  });

  it("wakes a direct API target using the caller's source access even when the Creator cannot read it", async () => {
    const key = await f.cp.api.credentials.create(f.organizationId, f.viewer.id, "Fixture");
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [f.workspace.id]);
    await pool.query("DELETE FROM cloud_github_source_verifications WHERE owner_user_id=$1", [f.creator.id]);
    const fetcher = f.fetcher.getMockImplementation()!;
    f.fetcher.mockClear();
    f.fetcher.mockImplementation(async (input, init) => {
      if (new Headers(init?.headers).get("authorization") === `Bearer synthetic-${f.creator.id}`)
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
      return fetcher(input, init);
    });
    const response = await api(key.key, `workspaces/${f.workspace.id}/wake`, {});
    expect(response.status).toBe(200);
    expect((await pool.query("SELECT execution_initiator_user_id,state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ execution_initiator_user_id: f.viewer.id, state: "starting" });
    expect(f.fetcher.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") !== `Bearer synthetic-${f.creator.id}`)).toBe(true);
  });

  it("refuses contextless worker credential requests after activation", async () => {
    const before = f.fetcher.mock.calls.length;
    const response = await f.worker("github-token", { purpose: "git" });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "actor_changed" } });
    expect(f.fetcher.mock.calls.length).toBe(before);
    const mcp = await f.worker(`mcp/${randomUUID()}/authorization`, {});
    expect(mcp.status).toBe(409); expect(await mcp.json()).toMatchObject({ error: { code: "actor_changed" } });
  });

  it("returns the active person's GitHub credential and refuses it after the turn ends", async () => {
    const a = await f.dispatch(f.prompt(randomUUID(), { chatId: "member-chat" }), f.viewer);
    const response = await f.worker("github-token", { purpose: "git", contextId: a.begun.contextId });
    expect(response.status).toBe(200);
    expect((await response.json()).token).toBe(`synthetic-${f.viewer.id}`);
    expect((await f.worker("prompts/outcome", { userMessageId: a.input.userMessageId, dispatchId: a.begin.dispatchId, state: "completed" })).status).toBe(200);
    const late = await f.worker("github-token", { contextId: a.begun.contextId });
    expect(late.status).toBe(409);
  });
});

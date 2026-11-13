import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../authz.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const actions = ["connect", "start", "restart", "prompts", "prompts/stop", "github"] as const;
type Action = typeof actions[number];

database("Creator execution with a team-sharing header", () => {
  let pool: pg.Pool, f: TeamSharingFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await teamSharingFixture(pool); });
  afterEach(async () => { vi.restoreAllMocks(); await f.sharing.signals.close(); });
  afterAll(async () => { await pool.end(); });
  const path = (action: Action) => `/v1/cloud-v2/workspaces/${f.workspace.id}/${action}${action === "connect" ? "?wakePolicy=explicit" : ""}`;
  const prompt = () => ({ chatId: "chat", userMessageId: randomUUID(), agentId: "codex", startedAt: 1,
    prompt: [{ type: "text", text: "Creator fixture" }] });
  const body = (action: Action) => action === "prompts" ? prompt() : action === "prompts/stop" ? { chatId: "chat", throughEpoch: "0" }
    : action === "connect" ? { wake: false } : action === "github" ? { op: "gh.authStatus", params: {} } : {};
  async function prepare(action: Action) {
    if (action === "connect") await f.store.transition(f.workspace.id, ["stopped"], "running");
    if (action === "prompts/stop") await f.store.prompts.enqueue(f.workspace.id, f.creator.id, prompt(), f.creator);
  }

  it.each(actions)("keeps a Creator's %s on its existing authorization path without viewer admission", async action => {
    await prepare(action);
    const viewer = vi.spyOn(f.github.source, "viewer");
    const response = await f.call(path(action), "POST", body(action), f.creator);
    expect(response.status).toBe(action === "prompts" ? 201 : ["start", "restart"].includes(action) ? 202 : 200);
    expect(viewer).not.toHaveBeenCalled();
    if (action === "connect") expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='connect'", [f.workspace.id])).rows[0].n).toBe(1);
    if (action === "prompts") expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rows[0].n).toBe(1);
  });

  it("adds at most one indexed lookup and no GitHub call to a warm Creator connect", async () => {
    await prepare("connect");
    expect((await f.call(path("connect"), "POST", body("connect"), f.creator, false)).status).toBe(200);
    const connects = vi.spyOn(pool, "connect"), samples: { optIn: boolean; checkouts: number; githubCalls: number }[] = [];
    for (const optIn of [false, true]) {
      connects.mockClear(); f.fetcher.mockClear();
      expect((await f.call(path("connect"), "POST", body("connect"), f.creator, optIn)).status).toBe(200);
      samples.push({ optIn, checkouts: connects.mock.calls.length, githubCalls: f.fetcher.mock.calls.length });
    }
    process.stdout.write(`[team-sharing] creator-connect-cost ${JSON.stringify(samples)}\n`);
    expect(samples[1]!.checkouts).toBeLessThanOrEqual(samples[0]!.checkouts + 1);
    expect(samples[1]!.githubCalls).toBe(0);
  });

  it("does not make a Creator depend on the viewer-admission service", async () => {
    await prepare("connect");
    const admission = vi.spyOn(f.sharing.authority, "admit").mockRejectedValue(new HttpError(503, "github_verification_unavailable", "Fixture viewer failure"));
    expect((await f.call(path("connect"), "POST", body("connect"), f.creator)).status).toBe(200);
    expect(admission).not.toHaveBeenCalled();
  });

  it.each(["viewer", "admin"] as const)("requires activation for the %s without asking GitHub for workspace access", async role => {
    const viewer = vi.spyOn(f.github.source, "viewer");
    for (const action of actions) {
      const response = await f.call(path(action), "POST", { ...body(action), creatorUserId: f[role].id, viewerRole: "creator" }, f[role]);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "workspace_read_only" } });
    }
    expect(viewer).not.toHaveBeenCalled();
    expect((await pool.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0].state).toBe("stopped");
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("hides missing and foreign workspaces but retains the activation guard for a member without GitHub access", async () => {
    f.denied.add(`${f.viewer.id}:42`);
    for (const action of actions) {
      expect((await f.call(path(action), "POST", body(action), f.viewer)).status).toBe(409);
      expect((await f.call(path(action), "POST", body(action), f.outsider)).status).toBe(404);
      expect((await f.call(path(action).replace(f.workspace.id, randomUUID()), "POST", body(action), f.creator)).status).toBe(404);
    }
    expect((await f.store.get(f.workspace.id, f.creator.id)).state).toBe("stopped");
  });

  it.each(["connect", "start", "prompts"] as const)("admits the Creator's local %s without repository access", async action => {
    await prepare(action);
    f.denied.add(`${f.creator.id}:42`);
    const response = await f.call(path(action), "POST", body(action), f.creator);
    expect(response.status).toBe(action === "prompts" ? 201 : action === "start" ? 202 : 200);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["connect", "start", "prompts"] as const)("rechecks current ownership and live access after classifying %s", async action => {
    await prepare(action);
    const classify = f.sharing.authority.isCreator.bind(f.sharing.authority);
    const selected = vi.spyOn(f.sharing.authority, "isCreator");
    for (const change of ["creator", "membership", "account", "organization", "deleted"] as const) {
      selected.mockImplementationOnce(async (...args) => {
        const result = await classify(...args);
        expect(result).toBe(true);
        if (change === "creator") await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id, f.viewer.id]);
        if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]);
        if (change === "account") await pool.query("UPDATE users SET auth_status='deleted',deleted_at=now() WHERE id=$1", [f.creator.id]);
        if (change === "organization") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [f.organizationId]);
        if (change === "deleted") await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE id=$1", [f.workspace.id]);
        return result;
      });
      const response = await f.call(path(action), "POST", body(action), f.creator);
      expect(response.status, change).toBe(404);
      expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
      if (change === "creator") await pool.query("UPDATE cloud_v2_workspaces SET creator_user_id=$2 WHERE id=$1", [f.workspace.id, f.creator.id]);
      if (change === "membership") await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [f.organizationId, f.creator.id]);
      if (change === "account") await pool.query("UPDATE users SET auth_status='active',deleted_at=NULL WHERE id=$1", [f.creator.id]);
      if (change === "organization") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=true WHERE id=$1", [f.organizationId]);
    }
    expect(selected).toHaveBeenCalledTimes(5);
  });

  it.each(["connect", "prompts"] as const)("rechecks the session after classifying %s", async action => {
    await prepare(action);
    const classify = f.sharing.authority.isCreator.bind(f.sharing.authority);
    vi.spyOn(f.sharing.authority, "isCreator").mockImplementationOnce(async (...args) => {
      const result = await classify(...args);
      await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [f.creator.authentication.sessionId]);
      return result;
    });
    expect((await f.call(path(action), "POST", body(action), f.creator)).status).toBe(401);
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  });

  it("does not acquire a workspace mutation lock to classify a Creator", async () => {
    const lock = await pool.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspace.id]);
      expect(await f.sharing.authority.isCreator(f.workspace.id, f.creator.id)).toBe(true);
      expect(await f.sharing.authority.isCreator(f.workspace.id, f.viewer.id)).toBe(false);
    } finally { await lock.query("ROLLBACK"); lock.release(); }
  }, 10_000);

  it("retains viewer admission for opted-in reads even for a Creator", async () => {
    const admission = vi.spyOn(f.sharing.authority, "admit");
    const classify = vi.spyOn(f.sharing.authority, "isCreator");
    expect((await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}/history`, "POST", { op: "chats.list", params: {} }, f.creator)).status).toBe(200);
    expect(admission).toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});

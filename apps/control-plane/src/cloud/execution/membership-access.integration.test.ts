import { randomUUID } from "node:crypto";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const sharing = { "X-Zeros-Team-Sharing": "1", "X-Zeros-Team-Ownership": "1" };

database("organization membership admits work independently of GitHub network access", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
  beforeEach(async () => {
    f = await executionFixture(pool, { teamOwnership: true });
    await f.activate(); await f.login();
    expect((await f.hello(`${f.features},creator-commit-identity-v1,creator-agent-logins-v1`)).status).toBe(200);
  });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const path = () => `/v1/cloud-v2/workspaces/${f.workspace.id}`;
  const call = (suffix = "", method = "GET", body?: unknown, user = f.viewer) => f.call(`${path()}${suffix}`, method, body, user, sharing);
  const disconnect = () => withSystemTx(pool, async tx => {
    await tx.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id]);
    await tx.query("DELETE FROM cloud_github_credentials WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id]);
  });
  const open = async () => {
    const response = await call("/connect", "POST", { wake: false }); expect(response.status).toBe(200);
    const { protocols } = await response.json();
    const ticket = await f.cp.store.consumeConnectTicket(protocols[1].slice(7), f.workspace.id); expect(ticket).not.toBeNull();
    const clientId = randomUUID(), context = await f.cp.execution.clients.open(f.workspace.id, clientId, ticket!);
    return { clientId, context };
  };

  it.each(["disconnected", "denied", "unavailable"] as const)("lists, opens and reads history with GitHub %s, without provider I/O", async state => {
    if (state === "disconnected") await disconnect();
    if (state === "denied") f.denied.add(`${f.viewer.id}:42`);
    if (state === "unavailable") f.unavailable.add(f.viewer.id);
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'history',$2)", [f.workspace.id, { id: "history", title: "Shared history" }]);
    f.fetcher.mockClear();
    const list = await f.call(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`, "GET", undefined, f.viewer, sharing);
    expect(list.status).toBe(200);
    expect((await list.json()).workspaces.some((row: { id: string }) => row.id === f.workspace.id)).toBe(true);
    expect((await call()).status).toBe(200);
    const history = await call("/history", "POST", { op: "chats.list", params: {} }); expect(history.status).toBe(200);
    expect((await history.json()).result.chats).toMatchObject([{ id: "history" }]);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await call("", "GET", undefined, f.outsider)).status).toBe(404);
  });

  it("issues a Creator-funded turn, terminal and file operation for a member with no GitHub connection", async () => {
    await disconnect(); f.fetcher.mockClear();
    const client = await open();
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "PTY_CREATE", id: "terminal", sessionId: "terminal" });
    expect((await f.worker("terminal-lease", { clientId: client.clientId, requestId: "terminal", terminalId: "terminal" })).status).toBe(200);
    await f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: "write", op: "file.write" });
    expect((await f.worker("client-lease", { clientId: client.clientId, requestId: "write", operation: "file.write" })).status).toBe(200);
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const response = await f.worker("turn-lease", turn.lease); expect(response.status).toBe(200);
    const lease = await response.json(); expect(lease.userId).toBe(f.viewer.id); expect(lease.agents.claude).toBeDefined();
    expect(f.fetcher).not.toHaveBeenCalled();
    const github = await f.worker("github-token", { contextId: lease.contextId, purpose: "git" });
    expect(github.status).toBe(409);
    expect(await github.json()).toEqual({ error: { code: "github_token_unavailable", reason: "connection-required" } });
    const renewed = await f.worker("execution-leases/renew", { contextIds: [client.context.contextId, lease.contextId] });
    expect(renewed.status).toBe(200); expect((await renewed.json()).leases.every((row: { refused?: unknown }) => !row.refused)).toBe(true);
  });

  it.each(["denied", "unavailable"] as const)("preserves the worker's GitHub refusal reason when access is %s", async state => {
    const turn = await f.dispatch(f.prompt(), f.viewer);
    const response = await f.worker("turn-lease", turn.lease); expect(response.status).toBe(200);
    const lease = await response.json();
    if (state === "denied") f.denied.add(`${f.viewer.id}:42`);
    else f.unavailable.add(f.viewer.id);
    const github = await f.worker("github-token", { contextId: lease.contextId, purpose: "git" });
    expect(github.status).toBe(409);
    expect(await github.json()).toEqual({ error: { code: "github_token_unavailable", reason: state === "denied" ? "access-denied" : "unavailable" } });
    const renewed = await f.worker("execution-leases/renew", { contextIds: [lease.contextId] });
    expect(renewed.status).toBe(200);
    const leases = (await renewed.json()).leases;
    expect(leases).toMatchObject([{ contextId: lease.contextId }]);
    expect(leases.every((row: { refused?: unknown }) => !row.refused)).toBe(true);
  });

  it.each(["denial", "selection", "disconnect"] as const)("keeps live authority on GitHub %s, but still cuts membership loss", async change => {
    if (change === "denial") await f.cp.execution.deps.authority.source.viewer(f.organizationId, f.viewer.id,
      [{ repository: f.workspace.repository, repositoryId: "42" }], false);
    const client = await open();
    await withSystemTx(pool, async tx => {
      const changed = change === "denial"
        ? await tx.query("UPDATE cloud_github_source_verifications SET failure_code='github_access_required',failure_status=403 WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id])
        : change === "selection"
          ? await tx.query("UPDATE cloud_github_selections SET generation=gen_random_uuid() WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id])
          : await tx.query("DELETE FROM cloud_github_credentials WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.viewer.id]);
      expect(changed.rowCount).toBeGreaterThan(0);
    });
    const contextState = async () => (await pool.query("SELECT state FROM cloud_v2_execution_contexts WHERE id=$1", [client.context.contextId])).rows[0].state;
    expect(await contextState()).toBe("active");
    await expect(f.cp.execution.clients.forward(f.workspace.id, client.context.contextId, { type: "WORKSPACE_REQUEST", id: "history", op: "messages.windowOlder" })).resolves.toBeUndefined();
    await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]));
    expect(await contextState()).not.toBe("active");
    expect((await call()).status).toBe(404);
  });

  it("makes missing repository access a hint on an eligible Reassign target", async () => {
    await disconnect(); f.fetcher.mockClear();
    const candidates = await call("/reassign-candidates", "GET", undefined, f.creator); expect(candidates.status).toBe(200);
    const listed = await candidates.json();
    const oldReply = z.object({ candidates: z.array(z.union([
      z.object({ userId: z.uuid(), eligible: z.literal(true), agentLogins: z.object({ claude: z.literal(true).optional(),
        codex: z.literal(true).optional(), cursor: z.literal(true).optional() }).strict().optional() }).strict(),
      z.object({ userId: z.uuid(), eligible: z.literal(false), reason: z.enum(["on_hold", "account_inactive", "repository_access_required"]) }).strict(),
    ])), creatorRevision: z.string(), nextCursor: z.string().nullable() }).passthrough();
    expect(oldReply.safeParse(listed).success).toBe(true);
    expect(listed.candidates.find((row: { userId: string }) => row.userId === f.viewer.id))
      .toMatchObject({ eligible: true, agentLogins: {} });
    expect(listed.candidateHints[f.viewer.id]).toEqual(["repository_access"]);
    const before = await (await call("", "GET", undefined, f.creator)).json();
    const reassigned = await call("/reassign", "POST", { requestId: randomUUID(), toUserId: f.viewer.id,
      expectedCreatorUserId: f.creator.id, expectedCreatorRevision: before.workspace.creatorRevision }, f.creator);
    expect(reassigned.status).toBe(200); expect((await reassigned.json()).workspace.creatorUserId).toBe(f.viewer.id);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { Hono } from "hono";
import WebSocket, { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser, type AuthedUser } from "../auth.js";
import { createRoutes } from "../routes.js";
import { PostgresSecurityEventBroker } from "../security-events.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { ingestWorkOSManagementEvent } from "../workos-sync-events.js";
import { CLOUD_V2_BRIDGE_PROTOCOL, CloudV2Relay } from "./relay.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("cloud access through membership routes and security publication", () => {
  let pool: pg.Pool, store: CloudV2Store, owner: AuthedUser, creator: AuthedUser;
  let org: string, workspace: CloudV2Workspace, relay: CloudV2Relay, server: Server;
  let broker: PostgresSecurityEventBroker, workerServer: WebSocketServer;
  const workerFrames = new Map<WebSocket, any[]>();
  const bootId = randomUUID();
  const sockets: WebSocket[] = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const user = () => { const id = randomUUID(); return ensureUser(pool, {
      provider: "workos", providerSubject: id, email: `${id}@example.test`, displayName: "User",
      session: { id: `session_${id}`, clientKind: "desktop", authTime: 1, tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 },
    }); };
    [owner, creator] = await Promise.all([user(), user()]);
    for (const account of [owner, creator]) await pool.query(`INSERT INTO auth_sessions
      (provider_session_id, provider_sub, user_id, client_kind, last_token_expires_at)
      VALUES ($1, $2, $3, 'desktop', now() + interval '1 hour')`,
      [account.authentication.sessionId, account.identity.subject, account.id]);
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1::uuid, ($1::uuid)::text, 'Org', $2, false, true)`, [org, owner.id]);
    await pool.query(`INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`, [org, owner.id, creator.id]);
    store = new CloudV2Store(pool);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator.id,
      name: "w", repository: "fixture/repo", branch: "zeros/w", baseBranch: "main", computerBuildId: null });
    await store.transition(workspace.id, ["creating"], "running");
    broker = new PostgresSecurityEventBroker(pool);
    workerServer = new WebSocketServer({ port: 0, host: "127.0.0.1", handleProtocols: () => "zeros.cloud.v2.worker" });
    await new Promise<void>(resolve => workerServer.once("listening", resolve));
    workerFrames.clear();
    workerServer.on("connection", ws => { const frames: any[] = []; workerFrames.set(ws, frames); ws.on("message", raw => frames.push(JSON.parse(String(raw)))); });
    relay = new CloudV2Relay({ store, securityEvents: broker, wake: async () => {}, answerOffline: async () => null,
      config: async w => ({ t: "config", loginRevision: "0", workspace: { id: w.id, organizationId: org, repository: w.repository,
        checkoutPath: "/home/user/fixture/repo", branch: w.branch, baseBranch: w.baseBranch }, agents: {} }),
      mintWorkerToken: () => "synthetic-grant",
      workerRoute: async id => { const route = await store.workerRoute(id); return route ? { ...route,
        url: `http://127.0.0.1:${(workerServer.address() as AddressInfo).port}`, token: "synthetic-port-token" } : null; } });
    server = createServer();
    server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    relay?.close(); await broker?.stop();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (workerServer) { for (const socket of workerServer.clients) socket.terminate(); await new Promise<void>(resolve => workerServer.close(() => resolve())); }
  });

  async function connected() {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = await store.rotateWorkerToken(workspace.id);
    const proxy = await store.issueToken({ workspaceId: workspace.id, kind: "proxy", userId: null, ttlMs: 60_000 });
    const ticket = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator.id, ttlMs: 60_000, authority: creator });
    await store.acceptWorkerHello(token, bootId);
    const app = new WebSocket(`${url}/v2/cloud/workspaces/${workspace.id}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`]);
    sockets.push(app);
    await new Promise<void>(resolve => app.once("open", resolve));
    await vi.waitFor(() => expect(workerFrames.size).toBe(1));
    const worker = [...workerFrames.keys()][0]!;
    await vi.waitFor(() => expect(workerFrames.get(worker)!.some(frame => frame.t === "open")).toBe(true));
    return { app, worker, token, proxy: proxy.token };
  }

  it("ends the signed-out app session without stopping its VM, revoking its worker, or interrupting an existing turn", async () => {
    const live = await connected(), now = new Date().toISOString();
    live.app.send(JSON.stringify({ type: "AGENT_PROMPT", id: "running-turn" }));
    await vi.waitFor(() => expect(workerFrames.get(live.worker)!.some(frame => frame.frame?.id === "running-turn")).toBe(true));
    const before = (await pool.query("SELECT worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].worker_token_hash;
    const unused = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator.id, ttlMs: 60_000, authority: creator });
    expect(await ingestWorkOSManagementEvent(pool, { id: `event_${randomUUID()}`, createdAt: now, event: "session.revoked",
      data: { id: creator.authentication.sessionId, userId: creator.identity.subject, status: "revoked",
        expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: now } }, "webhook")).toEqual({ status: "applied" });
    await vi.waitFor(() => expect(live.app.readyState).toBe(WebSocket.CLOSED));
    expect((await store.get(workspace.id, creator.id)).state).toBe("running");
    expect((await pool.query("SELECT worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].worker_token_hash).toEqual(before);
    expect(await store.byWorkerToken(live.token)).not.toBeNull();
    expect(await store.verifyProxyToken(live.proxy)).not.toBeNull();
    expect(await store.consumeConnectTicket(unused.token, workspace.id)).toBeNull();
    await expect(store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator.id, ttlMs: 60_000, authority: creator }))
      .rejects.toMatchObject({ code: "session_revoked" });

    const secondSession = `session_${randomUUID()}`;
    await pool.query(`INSERT INTO auth_sessions (provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at)
      VALUES ($1,$2,$3,'desktop',now()+interval '1 hour')`, [secondSession, creator.identity.subject, creator.id]);
    const second = { ...creator, authentication: { ...creator.authentication, sessionId: secondSession } };
    const ticket = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator.id, ttlMs: 60_000, authority: second });
    const app = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/workspaces/${workspace.id}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket.token}`]);
    sockets.push(app); await new Promise<void>(resolve => app.once("open", resolve));
    await vi.waitFor(() => expect(workerFrames.size).toBe(2));
    const connection = [...workerFrames.keys()].at(-1)!;
    await vi.waitFor(() => expect(workerFrames.get(connection)!.some(frame => frame.t === "open")).toBe(true));
    const clientId = workerFrames.get(connection)!.find(frame => frame.t === "open").clientId;
    const completion = new Promise(resolve => app.once("message", raw => resolve(JSON.parse(String(raw)))));
    connection.send(JSON.stringify({ t: "frame", clientId, frame: { type: "AGENT_PROMPT_COMPLETE", requestId: "running-turn" } }));
    expect(await completion).toEqual({ type: "AGENT_PROMPT_COMPLETE", requestId: "running-turn" });
    // The same worker credential can still commit the turn's final HTTP rows.
    await store.writeWorkerHistory(live.token, bootId, 1, { chats: [{ id: "completed-chat" }] });
    expect((await store.listChats(workspace.id)).chats).toEqual([{ id: "completed-chat" }]);
  });

  it.each(["member route", "WorkOS membership"])("retires an already-open room after %s", async path => {
    const live = await connected();
    if (path === "member route") {
      const app = new Hono();
      app.use("*", async (c, next) => { c.set("user", owner); await next(); });
      app.route("/", createRoutes(pool, undefined, { inviteLinkBase: "https://example.test/invite" }));
      expect((await app.request(`/v1/organizations/${org}/members/${creator.id}`, { method: "DELETE" })).status).toBe(200);
    } else {
      const now = new Date().toISOString();
      if (path === "WorkOS membership") {
        await pool.query(`INSERT INTO workos_organization_links (organization_id, workos_organization_id, external_id, state)
          VALUES ($1::uuid, $2, ($1::uuid)::text, 'active')`, [org, `org_${org}`]);
        await pool.query(`UPDATE organization_members SET workos_membership_id = 'membership_test' WHERE org_id = $1 AND user_id = $2`, [org, creator.id]);
      }
      const membership = path === "WorkOS membership";
      expect(await ingestWorkOSManagementEvent(pool, { id: `event_${randomUUID()}`, createdAt: now,
        event: membership ? "organization_membership.deleted" : "session.revoked",
        data: membership ? { id: "membership_test", organizationId: `org_${org}`, userId: creator.identity.subject,
          status: "inactive", directoryManaged: false, role: { slug: "member" }, updatedAt: now }
          : { id: creator.authentication.sessionId, userId: creator.identity.subject, status: "revoked",
            expiresAt: new Date(Date.now() + 60_000).toISOString(), updatedAt: now },
      }, "webhook")).toEqual({ status: "applied" });
    }
    // The committing security event itself notifies the relay; no separate
    // feed-publisher tick or subsequent app request is needed.
    await vi.waitFor(() => expect(live.app.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(live.worker.readyState).toBe(WebSocket.CLOSED));
    expect(await store.byWorkerToken(live.token)).toBeNull();
    expect(await store.verifyProxyToken(live.proxy)).toBeNull();

  });
});

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { JSDOM } from "jsdom";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "../../auth.js";
import { HttpError } from "../../authz.js";
import { teamSharingFixture, type TeamSharingFixture } from "./test-fixture.js";

// The override joins an unmerged desktop checkout without copying its clients.
// Its separate name leaves the local-command and sync source overrides alone.
const root = new URL(process.env.CLOUD_API_TEST_TEAM_CLIENT_ROOT ?? "../../../../../", import.meta.url);
const source = (path: string) => new URL(path, root);
const renderer = "apps/desktop/src/renderer/";
const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function assertSourcePin() {
  const revision = process.env.CLOUD_API_TEST_TEAM_CLIENT_REVISION;
  if (!revision) return;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Use a full desktop source revision");
  execFileSync("git", ["diff", "--exit-code", "--quiet", revision, "--"], {
    cwd: fileURLToPath(root), stdio: ["ignore", "pipe", "pipe"],
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: fileURLToPath(root), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (untracked.trim()) throw new Error("The pinned client checkout contains untracked files");
}

database("real team-sharing desktop clients against the router and PostgreSQL", () => {
  let pool: pg.Pool, f: TeamSharingFixture, now: number;
  let clients: any, token: string, currentUser: AuthedUser, selectedFolder: string | null, selectedDocument: any;
  let cleanups: Array<() => Promise<void>>;
  type Call = { method: string; path: string; body: any; headers: Headers; status?: number; reply?: any };
  let calls: Call[], requests: Set<Promise<Response>>;

  beforeAll(async () => {
    assertSourcePin();
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 7, statement_timeout: 5000 });
    // Only account, native and selected-view context is supplied here. The
    // producers, compatibility transport, schemas and SSE parser stay real.
    vi.doMock(source(`${renderer}platform/runtime.ts`).pathname, () => ({
      isElectron: () => true, isLocalDevelopment: () => false,
      nativeInvoke: async (command: string) => command === "local_commands_device" ? null : { version: "1.0.0", runtimeMode: "dev" },
      nativeListen: async () => () => {},
    }));
    vi.doMock(source(`${renderer}features/auth/auth-store.ts`).pathname, () => ({ getSession: async () => ({ access_token: token }) }));
    vi.doMock(source(`${renderer}features/team/team-store.ts`).pathname, () => ({
      getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({ me: { user: { id: currentUser?.id } } }),
      subscribeOrganizationSnapshots: () => () => {},
    }));
    vi.doMock(source(`${renderer}features/team/control-plane.ts`).pathname, async importOriginal => ({
      ...await importOriginal<Record<string, unknown>>(), CONTROL_PLANE_URL: "https://api.example.test",
    }));
    vi.doMock(source(`${renderer}config/release-channel.ts`).pathname, () => ({ isFeatureEnabled: () => true, CHANNEL: "alpha" }));
    vi.doMock(source(`${renderer}state/use-active-workspace.ts`).pathname, () => ({ useActiveWorkspace: () => ({ folder: selectedFolder }) }));
    vi.doMock(source(`${renderer}state/workspace-store.ts`).pathname, () => ({ useActivePage: () => "workspace" }));
    vi.doMock(source(`${renderer}state/cloud-workspace-catalog.ts`).pathname, () => ({ cloudWorkspaceDocument: () => selectedDocument }));
    clients = Object.assign({},
      await import(source("apps/desktop/src/renderer/platform/cloud-workspaces.ts").href),
      await import(source("apps/desktop/src/renderer/platform/cloud-v2.ts").href),
      await import(source("apps/desktop/src/renderer/platform/cloud-prompt-api.ts").href),
      await import(source("apps/desktop/src/renderer/platform/team-sharing.ts").href),
      await import(source("apps/desktop/src/renderer/platform/team-sharing-state.ts").href),
      await import(source("apps/desktop/src/renderer/platform/cloud-workspace-events.ts").href),
      await import(source("apps/desktop/src/renderer/shared/lib/workspace-name.ts").href),
      await import(source("apps/desktop/src/renderer/state/use-cloud-focus-activity.ts").href),
    );
    // Supply the catalog's held-document lookup through the real registry; request producers decide the header.
    clients.registerSharingRoleLookup?.((workspaceId: string) => selectedDocument?.id === workspaceId ? selectedDocument.sharing?.viewerRole : undefined);
  });
  afterAll(async () => { clients?.registerSharingRoleLookup?.(() => undefined); await pool?.end(); assertSourcePin(); });

  beforeEach(async () => {
    now = Date.now(); calls = []; requests = new Set(); cleanups = []; selectedFolder = null; selectedDocument = undefined;
    f = await teamSharingFixture(pool, { eventNow: () => now });
    // Match app.ts's HttpError envelope; the small shared fixture otherwise
    // omits message, which would conceal the production client's error code.
    f.app.onError((error, c) => {
      if (!(error instanceof HttpError)) throw error;
      return c.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, error.status);
    });
    signIn(f.viewer);
    clients.resetTeamSharingStateForTests();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const done = (async () => {
        const request = new Request(input, init), url = new URL(request.url);
        const call: Call = { method: request.method, path: url.pathname + url.search, headers: new Headers(request.headers),
          body: request.body ? await request.clone().json() : undefined };
        calls.push(call);
        const actor = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!actor || !f.actors.has(actor)) throw new Error("The real client omitted the fixture's authenticated session");
        request.headers.set("x-test-actor", actor);
        const response = await f.app.fetch(request);
        call.status = response.status;
        if (response.headers.get("content-type")?.includes("application/json")) call.reply = await response.clone().json();
        return response;
      })();
      requests.add(done);
      void done.finally(() => requests.delete(done)).catch(() => {});
      return done;
    });
  });
  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await settleRequests();
    await f?.sharing.signals.close();
    vi.unstubAllGlobals();
  });

  function signIn(user: AuthedUser) {
    currentUser = user;
    token = `fixture-session-${randomUUID()}`;
    f.actors.set(token, user);
    return token;
  }
  const target = (workspaceId = f.workspace.id) => ({ organizationId: f.organizationId, workspaceId });
  const path = (suffix = "", workspaceId = f.workspace.id) => `/v1/cloud-v2/workspaces/${workspaceId}${suffix}`;
  const tick = () => pool.query("SELECT pg_notify('zeros_security_event','{}')");
  async function holdDocument() {
    selectedDocument = await clients.getCloudWorkspaceDocument(target());
    selectedFolder = `cloud://${f.organizationId}/${f.workspace.id}`;
    return selectedDocument;
  }
  async function settleRequests() { while (requests.size) await Promise.allSettled([...requests]); }
  function boundary(call = calls.at(-1)!) {
    return JSON.stringify({ method: call.method, path: call.path, teamSharing: call.headers.get("X-Zeros-Team-Sharing"),
      body: call.body, status: call.status, ...(call.status && call.status >= 400 ? { reply: call.reply } : {}) });
  }
  async function observed(operation: Promise<any>) {
    try { return { value: await operation }; }
    catch (error) { return { error: { status: (error as any).status, code: (error as any).code } }; }
  }
  async function unchangedStopped() {
    expect((await pool.query("SELECT state,active_at FROM cloud_v2_workspaces WHERE id=$1", [f.workspace.id])).rows[0])
      .toEqual({ state: "stopped", active_at: null });
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(0);
  }
  function prompt() {
    return { chatId: "chat", userMessageId: randomUUID(), agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Joined fixture" }] };
  }
  async function seedReceipt() {
    const input = prompt();
    const result = await f.store.prompts.enqueue(f.workspace.id, f.creator.id, input, f.creator);
    await f.store.transition(f.workspace.id, ["starting"], "stopped");
    await pool.query("UPDATE cloud_v2_workspaces SET active_at=NULL WHERE id=$1", [f.workspace.id]);
    return result.receipt;
  }

  it("pages the real shared catalog, including the viewer's own workspaces, with the opt-in on every page", async () => {
    for (let n = 0; n < 200; n++) await f.store.createWorkspace({ id: randomUUID(), organizationId: f.organizationId,
      creatorUserId: f.creator.id, name: `Page ${n}`, repository: "example/project", sourceRepositoryId: "42",
      branch: `page-${n}`, baseBranch: "main", computerBuildId: null });
    const result = await clients.listCloudWorkspaceCatalogSnapshot(f.organizationId);
    expect(result.complete).toBe(true);
    expect(result.workspaces).toHaveLength(202);
    expect(new Set(result.workspaces.map((row: any) => row.id)).size).toBe(202);
    expect(result.workspaces.find((row: any) => row.id === f.own.id).sharing).toMatchObject({ viewerRole: "creator", readOnly: false });
    expect(result.workspaces.find((row: any) => row.id === f.workspace.id).sharing).toMatchObject({ viewerRole: "member", readOnly: true });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get("X-Zeros-Team-Sharing")).toBe("1");
      expect(call.status).toBe(200);
      expect(call.reply.teamSharing).toBe(1);
    }
    expect(calls[0]!.reply.workspaces).toHaveLength(200);
    expect(new URL(calls[1]!.path, "https://api.example.test").searchParams.get("cursor")).toBe(calls[0]!.reply.nextCursor);
    expect(calls[1]!.reply.nextCursor).toBeNull();
  }, 20_000);

  it("opens by id and numbered link and preserves the reader's document fields", async () => {
    const direct = await clients.getCloudWorkspaceDocument(target());
    const linked = await clients.getCloudWorkspaceDocumentByNumber({ owner: `org-${f.organizationId}`, number: f.workspace.number });
    expect(linked).toEqual(direct);
    expect(direct).toMatchObject({ id: f.workspace.id, ownerUserId: f.creator.id,
      sharing: { readOnly: true, canManage: false, createdByUserId: f.creator.id, followerIds: [], followerCount: 0 },
      capabilities: { canWrite: false, canManage: false, canStart: false } });
    expect(calls.every(call => call.headers.get("X-Zeros-Team-Sharing") === "1")).toBe(true);
    await unchangedStopped();
  });

  it("reads a teammate's mirrored chats through the real history producer without waking", async () => {
    await holdDocument();
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",
      [f.workspace.id, { id: "chat", title: "Shared transcript" }]);
    const wire = await f.call(path("/history"), "POST", { op: "chats.list", params: {} });
    expect(wire.status).toBe(200);
    const expected = (await wire.json()).result;
    expect(expected.chats).toEqual([expect.objectContaining({ id: "chat", title: "Shared transcript" })]);
    const result = await observed(clients.readCloudV2History(target(), "chats.list", {}));
    await unchangedStopped();
    expect(result, boundary()).toEqual({ value: expected });
    expect(calls.at(-1)!.headers.get("X-Zeros-Team-Sharing")).toBe("1");
  });

  it("reads a teammate's actual transcript messages through the history client", async () => {
    await holdDocument();
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)", [f.workspace.id, { id: "chat", title: "Transcript" }]);
    await pool.query("INSERT INTO cloud_v2_messages(workspace_id,chat_id,msg_id,kind,payload,created_at_ms) VALUES($1,'chat','reply','text',$2,1)",
      [f.workspace.id, JSON.stringify({ role: "assistant", text: "Shared response" })]);
    const wire = await f.call(path("/history"), "POST", { op: "messages.window", params: { chatId: "chat", limit: 100 } });
    expect(wire.status).toBe(200);
    const expected = (await wire.json()).result;
    expect(expected.messages).toEqual([expect.objectContaining({ msgId: "reply" })]);
    const result = await observed(clients.readCloudV2History(target(), "messages.window", { chatId: "chat", limit: 100 }));
    await unchangedStopped();
    expect(result, boundary()).toEqual({ value: expected });
  });

  it("reads a teammate's durable prompt receipts through the real recovery producer without waking", async () => {
    await holdDocument();
    const receipt = await seedReceipt();
    const wire = await f.call(path("/prompts?chatId=chat&after=0&includePayload=true"));
    expect(wire.status).toBe(200);
    const expected = await wire.json();
    expect(expected.items).toEqual([expect.objectContaining({ receipt, payload: expect.objectContaining({ chatId: "chat" }) })]);
    const result = await observed(clients.cloudPromptApi(target(), "chat").list("0", true));
    await unchangedStopped();
    expect(result, boundary()).toEqual({ value: expected });
    expect(calls.at(-1)!.headers.get("X-Zeros-Team-Sharing")).toBe("1");
  });

  it("follows, unfollows, pins and unpins with followers taken from the returned document", async () => {
    expect(await clients.setCloudWorkspaceFollowing(target(), true)).toBe(true);
    expect(await clients.setCloudWorkspaceFollowing(target(), true)).toBe(true);
    expect(await clients.setCloudWorkspacePinned(target(), true)).toBe(true);
    const document = await clients.getCloudWorkspaceDocument(target());
    expect(document.sharing).toMatchObject({ following: true, pinned: true, followerIds: [f.viewer.id], followerCount: 1 });
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspace_followers WHERE workspace_id=$1", [f.workspace.id])).rowCount).toBe(1);
    expect(await clients.setCloudWorkspaceFollowing(target(), false)).toBe(false);
    expect(await clients.setCloudWorkspacePinned(target(), false)).toBe(false);
    expect((await clients.getCloudWorkspaceDocument(target())).sharing)
      .toMatchObject({ following: false, pinned: false, followerIds: [], followerCount: 0 });
    expect(calls.some(call => call.path.includes("/followers"))).toBe(false);
    expect(calls.every(call => call.headers.get("X-Zeros-Team-Sharing") === "1")).toBe(true);
    await unchangedStopped();
  });

  it("can pin one's own workspace but preserves the real own-workspace follow refusal", async () => {
    expect(await clients.setCloudWorkspacePinned(target(f.own.id), true)).toBe(true);
    await expect(clients.setCloudWorkspaceFollowing(target(f.own.id), true)).rejects.toMatchObject({ status: 409, code: "own_workspace" });
    expect(calls.at(-1)!.reply.error.code).toBe("own_workspace");
  });

  it.each(["creator", "admin"] as const)("renames as %s and shows the reply's title, preserving its permanent name and number", async role => {
    signIn(f[role]);
    const before = await clients.getCloudWorkspaceDocument(target());
    const renamed = await clients.renameCloudV2Workspace(target(), "  Reviewed title  ");
    const call = calls.at(-1)!;
    expect(call.body).toEqual({ name: "Reviewed title" });
    expect(call.reply).toMatchObject({ teamSharing: 1, workspace: { id: f.workspace.id, title: "Reviewed title" } });
    const document = clients.cloudV2Document(renamed);
    expect(clients.cloudWorkspaceDocumentTitle(document)).toBe("Reviewed title");
    expect(document).toMatchObject({ name: before.name, number: before.number });
    expect(await clients.getCloudWorkspaceDocument(target())).toEqual(document);
    await unchangedStopped();
  });

  it("refuses a member's rename without changing the displayed title", async () => {
    await expect(clients.renameCloudV2Workspace(target(), "Forbidden title")).rejects.toMatchObject({ status: 403 });
    expect((await clients.getCloudWorkspaceDocument(target())).title).not.toBe("Forbidden title");
    await unchangedStopped();
  });

  it.each((["viewer", "admin"] as const).flatMap(role => (["connect", "start", "restart", "prompts"] as const)
    .map(operation => ({ role, operation }))))("returns the opted-in read-only refusal for $role $operation", async ({ role, operation }) => {
    signIn(f[role]);
    await holdDocument();
    const wire = await f.call(path(`/${operation}`), "POST", {}, f[role]);
    expect(wire.status).toBe(409);
    expect(await wire.json()).toMatchObject({ error: { code: "workspace_read_only" } });
    const result = await observed(operation === "connect" ? clients.connectCloudV2Workspace(target(), { wake: true })
      : operation === "prompts" ? clients.cloudPromptApi(target(), "chat").enqueue(prompt())
      : clients.changeCloudV2Workspace(target(), operation));
    await unchangedStopped();
    expect(result, boundary()).toEqual({ error: { status: 409, code: "workspace_read_only" } });
    expect(calls.at(-1)!.headers.get("X-Zeros-Team-Sharing")).toBe("1");
  });

  it.each(["stop", "archive", "delete", "edit"] as const)("preserves the admin's permitted %s operation through the desktop producer", async operation => {
    signIn(f.admin);
    if (operation === "stop") await f.store.transition(f.workspace.id, ["stopped"], "running");
    if (operation === "edit") await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)",
      [f.workspace.id, { id: "chat", title: "Before" }]);
    await holdDocument();
    const result = await observed(operation === "edit" ? clients.editCloudV2Chat(target(), "chat", { title: "Admin title" })
      : clients.changeCloudV2Workspace(target(), operation));
    expect(result, boundary()).toHaveProperty("value");
    expect(calls.at(-1)!.headers.get("X-Zeros-Team-Sharing")).toBe("1");
    if (operation === "edit") {
      expect(result.value).toEqual({ id: "chat", title: "Admin title", archived: false });
      await unchangedStopped();
    } else {
      expect(result.value).toMatchObject({ id: f.workspace.id, state: operation === "stop" ? "stopping" : operation === "delete" ? "deleting" : "stopped" });
      if (operation === "archive") expect(result.value.archivedAt).toEqual(expect.any(String));
    }
  });

  it.each(["prompts", "history", "connect", "activity"] as const)("keeps a Creator's %s request on the legacy path without an opt-in header", async operation => {
    signIn(f.creator);
    await f.store.transition(f.workspace.id, ["stopped"], "running");
    expect((await holdDocument()).sharing.viewerRole).toBe("creator");
    expect(calls.at(-1)!.headers.get("X-Zeros-Team-Sharing")).toBe("1");
    calls.length = 0;
    const input = prompt();
    const result = operation === "prompts" ? await clients.cloudPromptApi(target(), "chat").enqueue(input)
      : operation === "history" ? await clients.readCloudV2History(target(), "chats.list", {})
      : operation === "connect" ? await clients.connectCloudV2Workspace(target(), { wake: false })
      : await clients.pingCloudV2WorkspaceActivity(target());
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.headers.has("X-Zeros-Team-Sharing"), boundary(call)).toBe(false);
    expect(call.status).toBe(operation === "prompts" ? 201 : 200);
    if (operation === "prompts") {
      expect(result).toEqual(call.reply.receipt);
      expect(result.userMessageId).toBe(input.userMessageId);
    } else if (operation === "history") expect(result).toEqual(call.reply.result);
    else if (operation === "connect") expect(isDeepStrictEqual(result, call.reply)).toBe(true);
    else expect(call.reply).toEqual({ running: true });
  });

  it.each((["viewer", "admin"] as const).flatMap(role => (["history", "activity"] as const)
    .map(operation => ({ role, operation }))))("opts in to $role $operation only after holding the real shared document", async ({ role, operation }) => {
    signIn(f[role]);
    expect((await holdDocument()).sharing.viewerRole).toBe(role === "viewer" ? "member" : "admin");
    calls.length = 0;
    if (operation === "history") await clients.readCloudV2History(target(), "chats.list", {});
    else await clients.pingCloudV2WorkspaceActivity(target());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("X-Zeros-Team-Sharing"), boundary(calls[0])).toBe("1");
    expect(calls[0]!.status).toBe(200);
    await unchangedStopped();
  });

  async function watch(workspaceId = f.workspace.id) {
    const events: any[] = [], handlers = { invalidate: vi.fn(), presence: vi.fn(), ended: vi.fn() };
    let active = 0;
    const sleep = vi.fn((ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, ms);
      if (signal.aborted) finish(); else signal.addEventListener("abort", finish, { once: true });
    }));
    const stop = clients.watchCloudWorkspaceEvents(target(workspaceId), handlers, {
      now: () => now, sleep,
      events: async function* (...args: any[]) {
        active++;
        try { for await (const event of clients.readCloudWorkspaceEvents(...args)) { events.push(event); yield event; } }
        finally { active--; }
      },
    });
    const close = async () => { stop(); await expect.poll(() => active, { timeout: 5000 }).toBe(0); };
    cleanups.push(close);
    const wait = async (predicate: (event: any) => boolean) => {
      await expect.poll(() => events.find(predicate), { timeout: 5000 }).toBeDefined();
      return events.find(predicate);
    };
    return { events, handlers, sleep, close, wait };
  }

  it("parses real ready, changed, presence and heartbeat frames without bridge or activity requests", async () => {
    const member = await watch();
    await member.wait(event => event.event === "ready");
    await member.wait(event => event.event === "presence" && event.total === 1 && event.userIds[0] === f.viewer.id);
    signIn(f.admin);
    const admin = await watch();
    await admin.wait(event => event.event === "ready");
    await member.wait(event => event.event === "presence" && event.total === 2);
    expect(new Set(member.events.find(event => event.event === "presence" && event.total === 2).userIds))
      .toEqual(new Set([f.viewer.id, f.admin.id]));
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)", [f.workspace.id, { id: "chat", title: "Changed" }]);
    await member.wait(event => event.event === "changed");
    await expect.poll(() => member.handlers.invalidate.mock.calls.length).toBeGreaterThanOrEqual(2);
    now += 25_001; await tick();
    await member.wait(event => event.event === "heartbeat");
    const invalidations = member.handlers.invalidate.mock.calls.length;
    await admin.close();
    await expect.poll(() => member.handlers.presence.mock.calls.at(-1)).toEqual([[f.viewer.id], 1]);
    expect(member.handlers.invalidate).toHaveBeenCalledTimes(invalidations);
    expect(calls.every(call => call.path === path("/events") && call.headers.get("X-Zeros-Team-Sharing") === "1")).toBe(true);
    await unchangedStopped();
  });

  it("reconnects a clean token-end EOF with the fresh session and no revoked event or backoff", async () => {
    const expires = Math.floor(now / 1000) + 45;
    signIn({ ...f.viewer, authentication: { ...f.viewer.authentication, tokenExpiresAt: expires } });
    const stream = await watch();
    await stream.wait(event => event.event === "ready");
    const fresh = signIn({ ...f.viewer, authentication: { ...f.viewer.authentication, tokenExpiresAt: expires + 3600 } });
    now = expires * 1000 - 2000; await tick();
    await expect.poll(() => stream.events.filter(event => event.event === "ready").length, { timeout: 5000 }).toBe(2);
    const opens = calls.filter(call => call.path === path("/events"));
    expect(opens).toHaveLength(2);
    expect(opens[1]!.headers.get("authorization") === `Bearer ${fresh}`).toBe(true);
    expect(stream.events.some(event => event.event === "revoked")).toBe(false);
    expect(stream.handlers.ended).not.toHaveBeenCalled();
    expect(stream.sleep).not.toHaveBeenCalled();
    await unchangedStopped();
  });

  it.each(["membership", "session"] as const)("ends only the revoked reader's view after %s loss", async reason => {
    await f.store.transition(f.workspace.id, ["stopped"], "running");
    const member = await watch(); await member.wait(event => event.event === "ready");
    signIn(f.admin);
    const admin = await watch(); await admin.wait(event => event.event === "ready");
    if (reason === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.viewer.id]);
    else await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=now() WHERE provider_session_id=$1", [f.viewer.authentication.sessionId]);
    now += 5001; await tick();
    const code = reason === "session" ? "session_revoked" : "workspace_access_changed";
    expect(await member.wait(event => event.event === "revoked")).toEqual({ event: "revoked", code });
    await expect.poll(() => member.handlers.ended.mock.calls).toEqual([[code]]);
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)", [f.workspace.id, { id: "chat", title: "Still visible" }]);
    await admin.wait(event => event.event === "changed");
    expect(admin.handlers.ended).not.toHaveBeenCalled();
    expect((await f.store.get(f.workspace.id, f.creator.id)).state).toBe("running");
  });

  it("stops a 404 workspace's watcher without stopping another workspace's stream", async () => {
    const kept = await watch(); await kept.wait(event => event.event === "ready");
    const missingId = randomUUID(), missing = await watch(missingId);
    await expect.poll(() => missing.handlers.ended.mock.calls, { timeout: 5000 }).toEqual([["not_found"]]);
    await pool.query("INSERT INTO cloud_v2_chats(workspace_id,chat_id,row) VALUES($1,'chat',$2)", [f.workspace.id, { id: "chat", title: "Still live" }]);
    await kept.wait(event => event.event === "changed");
    expect(kept.handlers.ended).not.toHaveBeenCalled();
    expect(calls.filter(call => call.path === path("/events", missingId))).toHaveLength(1);
    expect(calls.find(call => call.path === path("/events", missingId))!.status).toBe(404);
    await unchangedStopped();
  });

  it.each(["viewer", "admin", "creator", "stopped", "personal-local", "organization-local"] as const)(
    "the real focus hook sends activity only for a running Creator view (%s)", async role => {
    const local = role === "personal-local" || role === "organization-local";
    if (!local && role !== "stopped") await f.store.transition(f.workspace.id, ["stopped"], "running");
    signIn(role === "creator" || role === "admin" ? f[role] : f.viewer);
    selectedDocument = local ? undefined : await clients.getCloudWorkspaceDocument(target());
    selectedFolder = local ? `/fixture/${role}` : `cloud://${f.organizationId}/${f.workspace.id}`;
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://desktop.example.test", pretendToBeVisual: true });
    vi.stubGlobal("window", dom.window); vi.stubGlobal("document", dom.window.document); vi.stubGlobal("navigator", dom.window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(dom.window.document, "hasFocus", { value: () => true });
    // Resolve React beside the client to avoid two hook dispatchers when the
    // pinned worktree has its own pnpm installation.
    const React = await import(source("node_modules/react/index.js").href);
    const { createRoot } = await import(source("node_modules/react-dom/client.js").href);
    const view = createRoot(dom.window.document.getElementById("root"));
    cleanups.push(async () => { await React.act(async () => view.unmount()); dom.window.close(); });
    function Focus() { clients.useCloudFocusActivity(); return null; }
    await React.act(async () => view.render(React.createElement(Focus)));
    await settleRequests();
    const activity = calls.filter(call => call.path.endsWith("/activity"));
    expect(activity.length, activity.map(call => boundary(call)).join("\n")).toBe(role === "creator" ? 1 : 0);
    if (role === "creator") {
      expect(activity[0]!.status).toBe(200);
      expect(activity[0]!.headers.has("X-Zeros-Team-Sharing"), boundary(activity[0])).toBe(false);
    }
    if (local) expect(calls).toHaveLength(0);
  });
});

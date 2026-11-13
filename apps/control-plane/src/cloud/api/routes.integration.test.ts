import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import type { Config, GithubBackendConfig } from "../../config.js";
import { HttpError } from "../../authz.js";
import type { AuthedUser } from "../../auth.js";
import { withSystemTx, withUserTx } from "../../db.js";
import { workosTestAuth } from "../../test-workos-env.js";
import { resetMigratedTestDatabase } from "../../test-database.js";
import { grantTestPro } from "../../test-pro.js";
import { CloudV2Store, type CloudV2Workspace } from "../store.js";
import { CloudV2Lifecycle } from "../lifecycle.js";
import type { CloudV2Compute } from "../boat.js";
import { CloudV2Computers } from "../computer.js";
import { createCloudGithubServices } from "../github-composition.js";
import { createCloudV2Routes, type CloudV2RouteDeps } from "../routes.js";
import { createCloudV2WorkerRoutes, type CloudV2WorkerRouteDeps } from "../worker-routes.js";
import { CloudV2PromptSignals } from "../prompt-signals.js";
import { CloudEnvironments } from "../environment-store.js";
import { CloudV2CapabilitiesSchema } from "../contract.js";
import { CloudApiCredentials } from "./credentials.js";
import { CloudWorkspaceApiTokens } from "./workspace-tokens.js";
import { CloudApiService } from "./service.js";
import { createCloudApiManagementRoutes } from "./management-routes.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("cloud API through the assembled router and PostgreSQL", () => {
  let pool: pg.Pool, store: CloudV2Store, credentials: CloudApiCredentials, tokens: CloudWorkspaceApiTokens;
  let org: string, otherOrg: string, owner: string, member: string, key: string, keyId: string, workspace: CloudV2Workspace;
  let app: Hono, routes: CloudV2RouteDeps;
  let clientAddress: string;
  let clientSequence = 0;
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const config = { databaseUrl: "postgres://unused", auth: workosTestAuth(), workos: null,
    inviteLinkBase: "https://app.example.test/invite", port: 8080, isProduction: true,
    deploymentChannel: "production", github: null, feedback: null, cloudWorkspaces: null, slowRequestLogMs: 60_000 } as Config;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, statement_timeout: 2000 }); });
  afterAll(() => pool.end());
  afterEach(async () => { await credentials?.close(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudV2Store(pool, keys); credentials = new CloudApiCredentials(pool); tokens = new CloudWorkspaceApiTokens(pool, keys);
    [org, otherOrg, owner, member] = Array.from({ length: 4 }, () => randomUUID());
    clientAddress = `198.51.100.${++clientSequence}`;
    for (const id of [owner, member]) {
      await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
      await grantTestPro(pool, id);
    }
    for (const organizationId of [org, otherOrg]) {
      await pool.query(`INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed)
        VALUES($1,$2,'Org',$3,false,true)`, [organizationId, `org-${organizationId}`, owner]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [organizationId, owner, member]);
      const build = randomUUID(), recipe = { repositories: [{ repository: "example/project", branch: "main" }] };
      await pool.query(`INSERT INTO cloud_v2_computer_builds(id,org_id,version,recipe,state,snapshot_id,created_by,source_policy_version,source_targets)
        VALUES($1,$2,1,$3,'succeeded',$4,$5,2,$6)`, [build, organizationId, recipe, `snapshot-${build}`, owner, JSON.stringify([{ repository: "example/project", repositoryId: "42" }])]);
      await pool.query("INSERT INTO cloud_v2_computers(org_id,active_build_id,snapshot_name) VALUES($1,$2,$3)", [organizationId, build, `snapshot-${build}`]);
    }
    const created = await credentials.create(org, owner, "Fixture key"); key = created.key; keyId = created.apiKey.id;
    workspace = await createWorkspace();
    routes = { store, computers: new CloudV2Computers(pool), promptOutbox: true,
      bridgeBaseUrl: "wss://api.example.test", installedRepositories: id => store.installedRepositories(id),
      authorizeSource: vi.fn(async () => {}), continueSource: vi.fn(async () => ({ status: "allowed" } as never)),
      authorizeBuildRepository: vi.fn(async (_org, _user, _build, repository) => ({ repository, repositoryId: "42" })),
      remoteHead: vi.fn(async () => "a".repeat(40)),
    };
    const service = new CloudApiService({ store, routes, credentials, appBaseUrl: "https://app.example.test" });
    app = createApp(config, pool, { from: null, token: null, apiUrl: "", inviteLinkBase: "" } as never, { cloudApi: { credentials, service } });
  });
  const createWorkspace = (organizationId = org, creatorUserId = owner) => store.createWorkspace({ id: randomUUID(),
    organizationId, creatorUserId, name: "Fixture", repository: "example/project", branch: "work", baseBranch: "main", computerBuildId: null });
  const request = (path: string, body?: unknown, credential = key, headers: Record<string, string> = {}) => app.request(`/api/v0${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "x-real-ip": clientAddress, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const mcp = (method: string, params: unknown = {}, credential = key, headers: Record<string, string> = {}) => app.request("/api/mcp", {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", "x-real-ip": clientAddress, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  async function tool(name: string, args: Record<string, unknown> = {}, credential = key) {
    const response = await mcp("tools/call", { name, arguments: args }, credential);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).not.toHaveProperty("error");
    return body.result;
  }
  function management(userId = owner, authority: Partial<AuthedUser> = {}) {
    const router = new Hono();
    router.use("*", async (c, next) => { c.set("user", { id: userId, ...authority } as AuthedUser); await next(); });
    router.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    router.route("/", createCloudApiManagementRoutes(credentials));
    router.route("/", createCloudV2Routes(routes));
    return router;
  }
  async function workspaceCredential() {
    const worker = await store.rotateWorkerToken(workspace.id), bootId = randomUUID();
    await store.acceptWorkerHello(worker, bootId);
    const credential = await tokens.token(workspace.id);
    expect(typeof credential).toBe("string");
    return { credential: credential!, worker, bootId };
  }
  function workerRouter(promptOutbox = false, waitForPrompts?: CloudV2WorkerRouteDeps["waitForPrompts"], environments?: CloudEnvironments) {
    const router = new Hono();
    const apiConfiguration = vi.fn(async (id: string) => {
      const token = await tokens.token(id);
      return token ? { url: "https://api.example.test/api/v0", token } : undefined;
    });
    router.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: { code: "internal" } }, 500));
    router.route("/", createCloudV2WorkerRoutes({ store, apiConfiguration, promptOutbox, runtimeSha256: "a".repeat(64),
      ...(waitForPrompts ? { waitForPrompts } : {}),
      config: async row => ({ t: "config", workspace: { id: row.id, organizationId: row.organizationId, repository: row.repository,
        checkoutPath: `/home/user/${row.repository}`, branch: row.branch, baseBranch: row.baseBranch }, agents: {},
        ...(environments ? { environment: await environments.resolve(row) } : {}) }),
      githubToken: async () => ({ token: "synthetic-github", expiresAt: 5000 }),
    }));
    return { router, apiConfiguration };
  }

  async function cloudCli() {
    // The worker joins this branch at integration. An isolated CP worktree can
    // point the test at that same source without copying or merging it.
    const source = new URL(process.env.CLOUD_API_TEST_CLI_SOURCE ?? "../../../../cloud-worker/src/cli/zeros.ts", import.meta.url);
    const { run } = await import(source.href);
    const env = { ZEROS_API_URL: "https://api.example.test/api/v0", ZEROS_API_KEY: key,
      ZEROS_WORKSPACE_ID: workspace.id, ZEROS_SESSION_ID: randomUUID() };
    async function command(...args: string[]) {
      let output = "", error = "", apiObject: unknown, requests = 0;
      const exit = await run(["cloud", ...args, "--json"], { env,
        stdout: (text: string) => { output += text; }, stderr: (text: string) => { error += text; },
        stdin: async () => "A message from stdin", fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          request.headers.set("x-real-ip", clientAddress);
          const response = await app.fetch(request);
          apiObject = await response.clone().json(); requests++;
          return response;
        },
      });
      expect({ exit, error }, args.join(" ")).toEqual({ exit: 0, error: "" });
      expect(requests).toBeGreaterThan(0);
      const result = JSON.parse(output);
      expect(result, args.join(" ")).toEqual(apiObject);
      return result;
    }
    return { env, command };
  }

  it("drives every initial cloud CLI command through the real router and PostgreSQL", async () => {
    const github = createCloudGithubServices(pool, null, keys, store, async input => {
      const path = new URL(String(input)).pathname;
      if (path === "/user") return Response.json({ id: 12, login: "contributor" });
      if (path === "/repositories/42/branches") return Response.json([]);
      if (path === "/repositories/42") return Response.json({ id: 42, name: "project", owner: { login: "example" },
        default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
      throw new Error("Unexpected synthetic GitHub request");
    });
    const scope = { organizationId: org, userId: owner };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope),
      { id: "12", login: "contributor" }, { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    routes.githubConnections = github.connections;
    const { env, command } = await cloudCli();
    expect((await command("me")).userId).toBe(owner);
    expect((await command("models")).data.length).toBeGreaterThan(0);
    expect((await command("repo", "list")).data).toEqual([{ repository: "example/project", defaultBranch: "main" }]);
    const created = await command("workspace", "create", "--repository", "example/project", "--name", "CLI workspace",
      "--branch", "cli-work", "--base-branch", "main", "--agent", "codex", "--message", "First",
      "--session-name", "CLI first session", "--idempotency-key", randomUUID());
    const workspaceId = created.workspace.id;
    env.ZEROS_WORKSPACE_ID = workspaceId;
    expect(created.session.name).toBe("CLI first session");
    expect((await command("workspace", "list", "--name", "CLI", "--include-archived", "--limit", "10", "--offset", "0")).data).toHaveLength(1);
    expect((await command("workspace", "get")).id).toBe(workspaceId);
    expect((await command("workspace", "status")).status).toBe("initializing");
    expect((await command("workspace", "rename", "--name", "CLI title")).title).toBe("CLI title");
    const sessionId = randomUUID(), messageId = randomUUID();
    const session = await command("session", "create", "--agent", "claude", "--message", "Next", "--name", "CLI task",
      "--session-id", sessionId, "--message-id", messageId);
    expect(session.session.name).toBe("CLI task");
    expect((await command("session", "get", sessionId)).id).toBe(sessionId);
    expect((await command("session", "status", sessionId)).status).toBe("working");
    expect((await command("workspace", "sessions", "--include-archived")).data).toHaveLength(2);
    const nextId = randomUUID();
    expect(await command("message", "send", "--session", sessionId, "--message-file", "-", "--message-id", nextId))
      .toEqual({ message: { id: nextId, createdBySessionId: null } });
    await store.writeHistory(workspaceId, { messages: { chatId: sessionId, rows: [
      { msgId: messageId, kind: "text", payload: JSON.stringify({ role: "user", text: "Next" }), createdAt: 123 },
      { msgId: nextId, kind: "text", payload: JSON.stringify({ role: "user", text: "A message from stdin" }), createdAt: 124 },
    ] } });
    expect((await command("session", "messages", sessionId, "--after", messageId)).data.map((row: { id: string }) => row.id)).toEqual([nextId]);
    expect((await command("message", "get", nextId, "--session", sessionId)).id).toBe(nextId);
    expect((await command("session", "cancel", sessionId)).status).toBe("idle");
    expect((await command("session", "wait", sessionId, "--timeout", "1")).status).toBe("idle");
    await store.transition(workspaceId, ["creating"], "stopped");
    expect((await command("workspace", "archive")).archived).toBe(true);
    expect((await command("workspace", "unarchive")).state).toBe("starting");
    expect((await command("workspace", "sleep")).state).toBe("stopping");
    await store.transition(workspaceId, ["stopping"], "stopped");
    expect((await command("workspace", "wake")).state).toBe("starting");
  });

  describe("session edits", () => {
    const chat = (id = randomUUID()) => ({ id, title: "Original", folder: "/home/user/example/project",
      agentId: "codex", agentName: "Codex", model: null, effort: "", archived: false, createdAt: 123, updatedAt: 456 });
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    }
    async function worker(features = "chat-edit-v1", waitForPrompts?: CloudV2WorkerRouteDeps["waitForPrompts"]) {
      const token = await store.rotateWorkerToken(workspace.id), bootId = randomUUID();
      const { router } = workerRouter(true, waitForPrompts);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-zeros-worker-boot": bootId,
        "x-zeros-worker-features": `prompt-outbox-v1,${features}` };
      const post = (path: string, body: unknown) => router.request(`/v2/cloud/worker/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      const hello = await post("hello", { bootId, protocol: 2, runtimeSha256: "a".repeat(64) });
      expect(hello.status).toBe(200);
      return { post, token, bootId, headers, router,
        history: (sequence: number, data: object) => post("history", { t: "history", bootId, sequence, ...data }),
        pull: (waitMs = 0) => post("prompts/pull", { waitMs, held: [] }),
      };
    }
    const mutate = (id: string, action: string, body?: object) => app.request(`/api/v0/sessions/${id}/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "x-real-ip": clientAddress,
        ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const edit = (id: string, body?: unknown, userId = owner, workspaceId = workspace.id) =>
      management(userId).request(`/v1/cloud-v2/workspaces/${workspaceId}/chats/${encodeURIComponent(id)}/edit`, {
        method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    describe("app chat edit route", () => {
      it("advertises chatEdits only at the top level and remains readable by released strict capability parsers", async () => {
        const router = management(), base = "/v1/cloud-v2/workspaces";
        const one = await (await router.request(`${base}/${workspace.id}`)).json();
        const listed = await (await router.request(`${base}?organizationId=${org}`)).json();
        const numbered = await (await router.request(`${base}/by-number/org-${org}/${workspace.number}`)).json();
        const created = await router.request(base, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId: org, repository: "example/project" }) });
        expect(created.status).toBe(201);
        const legacy = z.object({ version: z.literal(2), capabilities: CloudV2CapabilitiesSchema }).passthrough();
        for (const document of [one.workspace, ...listed.workspaces, numbered.workspace, (await created.json()).workspace]) {
          expect(document.chatEdits).toBe(1);
          expect(document.capabilities).not.toHaveProperty("chatEdits");
          expect(legacy.safeParse(document).success).toBe(true);
        }
      });

      it("matches API rename/archive/unarchive while stopped without waking, source checks or activity", async () => {
        const native = chat(), api = chat();
        await store.writeHistory(workspace.id, { chats: [native, api] });
        await store.transition(workspace.id, ["creating"], "stopped");
        const before = await store.get(workspace.id, owner), lifecycle = vi.spyOn(store, "requestLifecycle"), active = vi.spyOn(store, "markActive");
        for (const [action, input, patch] of [
          ["rename", { name: "  Shared title  " }, { title: "  Shared title  " }],
          ["archive", undefined, { archived: true }], ["unarchive", undefined, { archived: false }],
        ] as const) {
          const nativeReply = await edit(native.id, patch), apiReply = await mutate(api.id, action, input);
          expect([nativeReply.status, apiReply.status]).toEqual([200, 200]);
          expect(nativeReply.headers.get("cache-control")).toBe("no-store");
          const session = await apiReply.json();
          expect(await nativeReply.json()).toEqual({ chat: { id: native.id, title: session.name, archived: session.archived } });
        }
        const combined = await edit(native.id, { title: "Combined", archived: true });
        expect(combined.status).toBe(200);
        expect(await combined.json()).toEqual({ chat: { id: native.id, title: "Combined", archived: true } });
        expect(await store.get(workspace.id, owner)).toEqual(before);
        expect(lifecycle).not.toHaveBeenCalled(); expect(active).not.toHaveBeenCalled();
        expect(routes.authorizeSource).not.toHaveBeenCalled(); expect(routes.continueSource).not.toHaveBeenCalled();
        expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(0);
        expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_chats")).rowCount).toBe(0);
      });

      it.each([true, false])("matches the API for a running worker with chat-edit-v1=%s", async capable => {
        await worker(capable ? "chat-edit-v1" : "");
        const row = chat(); await store.writeHistory(workspace.id, { chats: [row] });
        for (const [action, input, patch] of [
          ["rename", { name: "New title" }, { title: "New title" }],
          ["archive", undefined, { archived: true }], ["unarchive", undefined, { archived: false }],
        ] as const) {
          const native = await edit(row.id, patch), api = await mutate(row.id, action, input);
          expect([native.status, api.status]).toEqual([capable ? 200 : 409, capable ? 200 : 409]);
          if (!capable) for (const response of [native, api]) expect((await response.json()).error.code).toBe("worker_update_required");
        }
        if (!capable) {
          expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits")).rowCount).toBe(0);
          await store.requestLifecycle(workspace.id, owner, "stop");
          await store.transition(workspace.id, ["stopping"], "stopped");
          expect((await edit(row.id, { title: "Next boot" })).status).toBe(200);
        }
      });

      it("returns the API's session_busy refusal and permits archiving after cancel", async () => {
        await worker();
        const created = await (await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "Working" })).json();
        const id = created.session.id;
        for (const response of [await edit(id, { archived: true }), await mutate(id, "archive")]) {
          expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("session_busy");
        }
        expect((await edit(id, { title: "Working title" })).status).toBe(200);
        expect((await mutate(id, "cancel")).status).toBe(200);
        expect((await edit(id, { archived: true })).status).toBe(200);
        expect((await edit(id, { archived: false })).status).toBe(200);
      });

      it("enforces strict fields, the same title bounds and exact creator/workspace/chat ownership", async () => {
        const row = chat(), terminal = { ...chat(), kind: "terminal" }, deleted = chat();
        await store.writeHistory(workspace.id, { chats: [row, terminal, deleted], chatDeletions: [deleted.id] });
        await store.transition(workspace.id, ["creating"], "stopped");
        for (const body of [undefined, {}, null, { title: "" }, { title: "  " }, { title: "x".repeat(121) }, { title: "line\nbreak" },
          { title: "tab\tname" }, { title: "control\u0085" }, { title: "Allowed", extra: true }, { archived: "true" }, { title: null }])
          expect((await edit(row.id, body)).status).toBe(400);
        expect((await edit(row.id, { title: "Allowed" }, member)).status).toBe(404);
        for (const id of [terminal.id, deleted.id, randomUUID(), "cloud:invalid"])
          expect((await edit(id, { archived: true })).status).toBe(404);
        const another = await createWorkspace(org, member), foreignChat = chat();
        await store.writeHistory(another.id, { chats: [foreignChat] });
        expect((await edit(foreignChat.id, { archived: true }, owner, another.id)).status).toBe(404);
        expect((await edit(row.id, { archived: true }, owner, another.id)).status).toBe(404);
        expect((await edit(foreignChat.id, { archived: true })).status).toBe(404);
        expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits")).rowCount).toBe(0);
      });

      it("rechecks the WorkOS session after waiting for the mutation lock", async () => {
        const row = chat(), subject = `user_${randomUUID()}`, sessionId = `session_${randomUUID()}`;
        await store.writeHistory(workspace.id, { chats: [row] });
        await store.transition(workspace.id, ["creating"], "stopped");
        await pool.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link) VALUES($1,'workos',$2,$3)", [owner, subject, `${owner}@example.test`]);
        await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind) VALUES($1,$2,$3,'desktop')", [sessionId, subject, owner]);
        const authority = { identity: { provider: "workos" as const, subject }, accountRevision: Number((await pool.query("SELECT auth_revision FROM users WHERE id=$1", [owner])).rows[0].auth_revision),
          authentication: { sessionId, clientKind: "desktop" as const, authTime: null, tokenExpiresAt: Math.floor(Date.now() / 1000) + 600 } };
        const router = management(owner, authority), send = (body: object) => router.request(`/v1/cloud-v2/workspaces/${workspace.id}/chats/${row.id}/edit`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        expect((await send({ title: "Before revocation" })).status).toBe(200);
        const held = await pool.connect(); let pending: Promise<Response> | undefined;
        try {
          await held.query("BEGIN");
          await held.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
          const pid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          pending = send({ archived: true });
          await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
          await held.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [sessionId]);
          await held.query("COMMIT");
          const response = await pending;
          expect(response.status).toBe(401); expect((await response.json()).error.code).toBe("session_revoked");
          expect((await (await request(`/sessions/${row.id}`)).json()).archived).toBe(false);
        } finally { await held.query("ROLLBACK"); held.release(); await pending; }
      });
    });

    it("coalesces sleeping session edits in the mirror without waking, activity, or pending prompts", async () => {
      const row = chat();
      await store.writeHistory(workspace.id, { chats: [row] });
      await store.transition(workspace.id, ["creating"], "stopped");
      const before = await store.get(workspace.id, owner);
      for (const [action, body, expected] of [
        ["rename", { name: "  API title  " }, { name: "API title", archived: false }],
        ["archive", undefined, { name: "API title", archived: true }],
        ["unarchive", undefined, { name: "API title", archived: false }],
      ] as const) {
        const response = await mutate(row.id, action, body);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ id: row.id, ...expected, updatedAt: new Date(row.updatedAt).toISOString() });
      }
      expect((await store.listChats(workspace.id)).chats).toEqual([{ ...row, title: "API title" }]);
      expect(await store.get(workspace.id, owner)).toEqual(before);
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_chats")).rowCount).toBe(0);
      const saved = (await pool.query("SELECT version,acknowledged_version,title,archived FROM cloud_v2_chat_edits WHERE chat_id=$1", [row.id])).rows;
      expect(saved).toEqual([{ version: "3", acknowledged_version: "0", title: "API title", archived: false }]);
      await withUserTx(pool, owner, async tx => { expect((await tx.query("SELECT 1 FROM cloud_v2_chat_edits")).rowCount).toBe(0); });
      expect((await tool("rename_session", { sessionId: row.id, name: "MCP title" })).structuredContent.name).toBe("MCP title");
      expect((await tool("archive_session", { sessionId: row.id })).structuredContent.archived).toBe(true);
      expect((await tool("unarchive_session", { sessionId: row.id })).structuredContent.archived).toBe(false);
      const { command } = await cloudCli();
      expect((await command("session", "rename", row.id, "--name", "CLI title")).name).toBe("CLI title");
      expect((await command("session", "archive", row.id)).archived).toBe(true);
      expect((await command("session", "unarchive", row.id)).archived).toBe(false);
      expect(await store.get(workspace.id, owner)).toEqual(before);
    });

    it.each([false, true])("overlays a held older history batch and acknowledges only its edit version (newer=%s)", async newer => {
      const row = chat(), current = await worker();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      const entered = deferred(), release = deferred(), write = store.writeWorkerHistory.bind(store);
      vi.spyOn(store, "writeWorkerHistory").mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return write(...args); });
      const oldBatch = { chats: [{ ...row, title: "Old queued title", effort: "high" }] };
      const old = current.history(2, oldBatch);
      await entered.promise;
      try {
        expect((await mutate(row.id, "rename", { name: "Accepted" })).status).toBe(200);
        const offered = await (await current.pull()).json();
        expect(offered.chatEdits).toEqual([{ chatId: row.id, version: "1", title: "Accepted" }]);
        if (newer) expect((await mutate(row.id, "rename", { name: "Newer" })).status).toBe(200);
        const ack = { chats: [{ ...row, title: "Accepted" }], chatEditAcks: [{ chatId: row.id, version: "1" }] };
        const gap = await current.history(3, ack);
        expect(gap.status).toBe(409); expect((await gap.json()).error.code).toBe("history_sequence_gap");
        release.resolve();
        expect((await old).status).toBe(200);
        expect((await (await request(`/sessions/${row.id}`)).json())).toMatchObject({ name: newer ? "Newer" : "Accepted", effort: "high" });
        expect((await current.history(3, ack)).status).toBe(200);
        expect((await current.history(2, oldBatch)).status).toBe(200);
        expect((await request(`/sessions/${row.id}`)).status).toBe(200);
        expect((await (await request(`/sessions/${row.id}`)).json()).name).toBe(newer ? "Newer" : "Accepted");
        expect((await pool.query("SELECT version,acknowledged_version,title FROM cloud_v2_chat_edits WHERE chat_id=$1", [row.id])).rows)
          .toEqual([{ version: newer ? "2" : "1", acknowledged_version: "1", title: newer ? "Newer" : null }]);
        if (newer) {
          expect((await (await current.pull()).json()).chatEdits).toEqual([{ chatId: row.id, version: "2", title: "Newer" }]);
          expect((await current.history(4, { chats: [{ ...row, title: "Newer" }], chatEditAcks: [{ chatId: row.id, version: "2" }] })).status).toBe(200);
        }
        expect((await current.history(newer ? 5 : 4, { chats: [{ ...row, title: "Later worker title" }] })).status).toBe(200);
        expect((await (await request(`/sessions/${row.id}`)).json()).name).toBe("Later worker title");
      } finally { release.resolve(); await old; }
    });

    it("requires an acknowledgement's chat row in the same history batch and removes edits on deletion", async () => {
      const current = await worker(), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      expect((await mutate(row.id, "archive")).status).toBe(200);
      expect((await current.history(2, { chatEditAcks: [{ chatId: row.id, version: "1" }] })).status).toBe(400);
      expect((await (await request(`/sessions/${row.id}`)).json()).archived).toBe(true);
      expect((await current.history(2, { chatDeletions: [row.id] })).status).toBe(200);
      expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits")).rowCount).toBe(0);
      expect((await mutate(row.id, "unarchive")).status).toBe(404);
      expect((await (await current.pull()).json()).chatEdits ?? []).toEqual([]);
    });

    // Each of the 129 edits crosses the real HTTP and transaction boundary.
    it("does not let an unacknowledged edit starve 128 others or end a held poll", async () => {
      const held = deferred(), dispose = vi.fn(), current = await worker("chat-edit-v1", () => ({ wait: held.promise, dispose }));
      const rows = Array.from({ length: 129 }, () => chat());
      expect((await current.history(1, { chats: rows })).status).toBe(200);
      const unknown = rows[0]!;
      expect((await mutate(unknown.id, "rename", { name: "Unknown to worker" })).status).toBe(200);
      expect((await (await current.pull()).json()).chatEdits.map((edit: { chatId: string }) => edit.chatId)).toEqual([unknown.id]);
      await pool.query("UPDATE cloud_v2_chat_edits SET last_offered_at=clock_timestamp()-interval '31 seconds' WHERE chat_id=$1", [unknown.id]);
      for (const row of rows.slice(1)) expect((await mutate(row.id, "archive")).status).toBe(200);
      const next = (await (await current.pull()).json()).chatEdits;
      expect(next).toHaveLength(128);
      expect(new Set(next.map((edit: { chatId: string }) => edit.chatId))).toEqual(new Set(rows.slice(1).map(row => row.id)));
      const observed = deferred(), pull = store.prompts.pull.bind(store.prompts);
      vi.spyOn(store.prompts, "pull").mockImplementationOnce(async (...args) => {
        const value = await pull(...args); setImmediate(observed.resolve); return value;
      });
      let settled = false;
      const waiting = current.pull(25_000).then(response => { settled = true; return response; });
      await observed.promise;
      try {
        expect(settled).toBe(false); expect(dispose).not.toHaveBeenCalled();
        held.resolve();
        const result = await waiting;
        expect(result.status).toBe(200);
        expect((await result.json()).chatEdits).toEqual([{ chatId: unknown.id, version: "1", title: "Unknown to worker" }]);
        expect(dispose).toHaveBeenCalledOnce();
        expect((await (await current.pull()).json()).chatEdits ?? []).toEqual([]);
      } finally { held.resolve(); await waiting; }
    }, 30_000);

    it("notifies an already-held poll after committing an edit and offers changed versions immediately", async () => {
      const signals = new CloudV2PromptSignals(), current = await worker("chat-edit-v1", (...args) => signals.wait(...args)), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      expect((await mutate(row.id, "rename", { name: "One" })).status).toBe(200);
      expect((await (await current.pull()).json()).chatEdits[0].version).toBe("1");
      const listener = await pool.connect();
      const notify = (notice: pg.Notification) => { if (notice.channel === "zeros_cloud_v2_prompts" && notice.payload) signals.wake(notice.payload); };
      listener.on("notification", notify);
      await listener.query("LISTEN zeros_cloud_v2_prompts");
      const observed = deferred(), pull = store.prompts.pull.bind(store.prompts);
      vi.spyOn(store.prompts, "pull").mockImplementationOnce(async (...args) => {
        const value = await pull(...args); setImmediate(observed.resolve); return value;
      });
      let settled = false;
      const waiting = current.pull(25_000).then(response => { settled = true; return response; });
      try {
        await observed.promise; expect(settled).toBe(false);
        expect((await mutate(row.id, "rename", { name: "Two" })).status).toBe(200);
        const response = await waiting;
        expect(response.status).toBe(200);
        expect((await response.json()).chatEdits).toEqual([{ chatId: row.id, version: "2", title: "Two" }]);
      } finally { signals.wakeAll(); await waiting; await listener.query("UNLISTEN *"); listener.off("notification", notify); listener.release(); }
    });

    it.each(["prompt", "edit"])("reoffers due edits when a new %s makes a held poll ready", async event => {
      const current = await worker("chat-edit-v1", () => ({ wait: Promise.resolve(), dispose() {} }));
      const old = chat(), fresh = chat();
      expect((await current.history(1, { chats: [old, fresh] })).status).toBe(200);
      expect((await mutate(old.id, "rename", { name: "Due again" })).status).toBe(200);
      expect((await (await current.pull()).json()).chatEdits).toHaveLength(1);
      await pool.query("UPDATE cloud_v2_chat_edits SET last_offered_at=clock_timestamp()-interval '31 seconds' WHERE chat_id=$1", [old.id]);
      if (event === "prompt") expect((await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "New work" })).status).toBe(201);
      else expect((await mutate(fresh.id, "rename", { name: "New edit" })).status).toBe(200);
      const calls = vi.spyOn(store.prompts, "pull");
      const response = await current.pull(25_000);
      expect(response.status).toBe(200);
      const reply = await response.json();
      expect(reply.chatEdits).toContainEqual({ chatId: old.id, version: "1", title: "Due again" });
      expect(calls).toHaveBeenCalledOnce();
      if (event === "prompt") expect(reply.prompts).toHaveLength(1);
      else expect(reply.chatEdits).toContainEqual({ chatId: fresh.id, version: "1", title: "New edit" });
    });

    it("reoffers to a new boot and never counts an edit as activity or pending work for idle stop", async () => {
      const current = await worker(), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      await pool.query("UPDATE cloud_v2_workspaces SET active_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [workspace.id]);
      const before = await store.get(workspace.id, owner);
      expect((await mutate(row.id, "rename", { name: "Sleep safely" })).status).toBe(200);
      expect((await (await current.pull()).json()).chatEdits).toHaveLength(1);
      expect((await (await current.pull()).json()).chatEdits ?? []).toEqual([]);
      const nextBoot = randomUUID();
      expect((await current.post("hello", { bootId: nextBoot, protocol: 2, runtimeSha256: "a".repeat(64) })).status).toBe(200);
      current.headers["x-zeros-worker-boot"] = nextBoot;
      expect((await (await current.pull()).json()).chatEdits).toEqual([{ chatId: row.id, version: "1", title: "Sleep safely" }]);
      await pool.query("UPDATE cloud_v2_workspaces SET active_at=$2 WHERE id=$1", [workspace.id, before.activeAt]);
      const cutoff = new Date(Date.now() - 60_000);
      expect((await store.idleSince(cutoff)).map(row => row.id)).toContain(workspace.id);
      await store.stopIdle(workspace.id, cutoff);
      expect((await store.get(workspace.id, owner)).state).toBe("stopping");
      expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits WHERE title IS NOT NULL")).rowCount).toBe(1);
    });

    it.each(["", "chat-edit-v10"])("gates running N-1 workers and omits new wire fields: %s", async feature => {
      const row = chat();
      await store.writeHistory(workspace.id, { chats: [row] });
      await store.transition(workspace.id, ["creating"], "stopped");
      expect((await mutate(row.id, "rename", { name: "Next wake" })).status).toBe(200);
      await store.requestLifecycle(workspace.id, owner, "start");
      const current = await worker(feature);
      expect(await (await current.pull()).json()).not.toHaveProperty("chatEdits");
      for (const action of ["rename", "archive", "unarchive"]) {
        const response = await mutate(row.id, action, action === "rename" ? { name: "Refused" } : undefined);
        expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worker_update_required");
      }
      expect((await current.history(1, { chats: [row], chatEditAcks: [{ chatId: row.id, version: "1" }] })).status).toBe(400);
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      expect((await (await request(`/sessions/${row.id}`)).json()).name).toBe("Next wake");
      await store.requestLifecycle(workspace.id, owner, "stop");
      await store.transition(workspace.id, ["stopping"], "stopped");
      expect((await mutate(row.id, "archive")).status).toBe(200);
    });

    it("refuses archiving working sessions until cancel, rejects invalid names, and keeps owner boundaries", async () => {
      await worker();
      const created = await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "Work" });
      const { session } = await created.json();
      const busy = await mutate(session.id, "archive");
      expect(busy.status).toBe(409); expect((await busy.json()).error.code).toBe("session_busy");
      expect((await mutate(session.id, "rename", { name: "Working title" })).status).toBe(200);
      for (const name of ["", "  ", "x".repeat(121), "line\nbreak", "tab\tname", "control\u0085"])
        expect((await mutate(session.id, "rename", { name })).status).toBe(400);
      expect((await mutate(session.id, "rename")).status).toBe(400);
      expect((await mutate(session.id, "rename", { name: "Valid", unexpected: true })).status).toBe(400);
      expect((await request(`/sessions/${session.id}/cancel`, {})).status).toBe(200);
      expect((await mutate(session.id, "archive")).status).toBe(200);
      const terminal = { ...chat(), kind: "terminal" };
      await store.writeHistory(workspace.id, { chats: [terminal] });
      const foreign = await createWorkspace(otherOrg), anotherCreator = await createWorkspace(org, member);
      const privateIds = [terminal.id];
      for (const target of [foreign, anotherCreator]) {
        const privateChat = chat(); privateIds.push(privateChat.id);
        await store.writeHistory(target.id, { chats: [privateChat] });
      }
      for (const id of privateIds) for (const action of ["rename", "archive", "unarchive"])
        expect((await mutate(id, action, action === "rename" ? { name: "Denied" } : undefined)).status).toBe(404);
    });

    it("does not inherit the prior boot's capability when an N-1 replica publishes a new boot", async () => {
      const current = await worker(), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      expect((await mutate(row.id, "rename", { name: "First boot" })).status).toBe(200);
      await store.acceptWorkerHello(current.token, randomUUID());
      const response = await mutate(row.id, "rename", { name: "Old replica must not inherit" });
      expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worker_update_required");
      expect((await (await request(`/sessions/${row.id}`)).json()).name).toBe("First boot");
    });

    it.each(["key", "member", "busy"])("rechecks %s after waiting on the workspace lock", async change => {
      const current = await worker(), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      const held = await pool.connect();
      let pending: Promise<Response> | undefined;
      try {
        await held.query("BEGIN; SET LOCAL ROLE zeros_app; SELECT set_config('app.system','on',true)");
        await held.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
        const pid = (await held.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        pending = mutate(row.id, "archive");
        await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))", [pid])).rowCount).toBeGreaterThan(0);
        if (change === "key") expect((await held.query("UPDATE cloud_api_keys SET revoked_at=clock_timestamp() WHERE id=$1", [keyId])).rowCount).toBe(1);
        else if (change === "member") expect((await held.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, owner])).rowCount).toBe(1);
        else await store.prompts.enqueueApi(workspace.id, owner, { chatId: row.id, userMessageId: randomUUID(), agentId: "codex", message: "Work arrived" }, held);
        await held.query("COMMIT");
        const response = await pending;
        expect(response.status).toBe(change === "key" ? 401 : change === "member" ? 404 : 409);
        if (change === "busy") expect((await response.json()).error.code).toBe("session_busy");
        expect((await pool.query("SELECT 1 FROM cloud_v2_chat_edits")).rowCount).toBe(0);
        expect((await pool.query("SELECT row->'archived' AS archived FROM cloud_v2_chats WHERE chat_id=$1", [row.id])).rows[0].archived).toBe(false);
      } finally { await held.query("ROLLBACK"); held.release(); await pending; }
    });

    it("serializes concurrent fields and preserves both over a replacement mirror", async () => {
      const current = await worker(), row = chat();
      expect((await current.history(1, { chats: [row] })).status).toBe(200);
      const responses = await Promise.all([mutate(row.id, "rename", { name: "Concurrent" }), mutate(row.id, "archive")]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      expect((await current.history(2, { chats: [row] })).status).toBe(200);
      const edited = await (await request(`/sessions/${row.id}`)).json();
      expect(edited).toMatchObject({ name: "Concurrent", archived: true, updatedAt: new Date(row.updatedAt).toISOString() });
      expect((await (await current.pull()).json()).chatEdits).toEqual([{ chatId: row.id, version: "2", title: "Concurrent", archived: true }]);
      expect((await current.history(3, { chats: [{ ...row, title: "Concurrent", archived: true }], chatEditAcks: [{ chatId: row.id, version: "2" }] })).status).toBe(200);
      expect((await mutate(row.id, "unarchive")).status).toBe(200);
      expect((await (await current.pull()).json()).chatEdits).toEqual([{ chatId: row.id, version: "3", archived: false }]);
    });
  });

  it.each(["archive", "unarchive", "sleep", "wake"])("accepts a bodiless workspace %s without a JSON content type", async action => {
    if (action === "archive" || action === "sleep") await workspaceCredential();
    else await store.transition(workspace.id, ["creating"], "stopped");
    if (action === "unarchive") await store.requestLifecycle(workspace.id, owner, "archive");
    const response = await app.request(`/api/v0/workspaces/${workspace.id}/${action}`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "x-real-ip": clientAddress },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: workspace.id,
      state: action === "archive" || action === "sleep" ? "stopping" : "starting", archived: action === "archive" });
  });

  it("accepts bodiless cancel but still requires input and JSON for nonempty bodies", async () => {
    const created = await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "First" });
    const { session } = await created.json();
    const headers = { authorization: `Bearer ${key}`, "x-real-ip": clientAddress };
    const cancel = await app.request(`/api/v0/sessions/${session.id}/cancel`, { method: "POST", headers });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ sessionId: session.id, status: "idle" });
    for (const path of ["/workspaces", "/sessions", `/workspaces/${workspace.id}/rename`, `/sessions/${session.id}/messages`]) {
      expect((await app.request(`/api/v0${path}`, { method: "POST", headers })).status).toBe(400);
      expect((await app.request(`/api/v0${path}`, { method: "POST", headers, body: "" })).status).toBe(400);
      expect((await app.request(`/api/v0${path}`, { method: "POST", headers, body: "{}" })).status).toBe(415);
    }
    expect((await app.request(`/api/v0/sessions/${session.id}/cancel`, { method: "POST", headers, body: "" })).status).toBe(200);
    expect((await app.request(`/api/v0/sessions/${session.id}/cancel`, { method: "POST", headers, body: "not json" })).status).toBe(415);
  });

  it("refuses creating unusable keys while retaining list and revoke without cloud entitlement", async () => {
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [org]);
    const router = management(), path = `/v1/organizations/${org}/api-keys`;
    const created = await router.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Unavailable" }) });
    expect(created.status).toBe(409);
    expect((await created.json()).error.code).toBe("cloud_workspaces_not_enabled");
    expect((await (await router.request(path)).json()).apiKeys.map((entry: { id: string }) => entry.id)).toEqual([keyId]);
    expect((await router.request(`${path}/${keyId}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await router.request(path)).json()).apiKeys).toEqual([]);
  });

  it("authenticates independently of desktop compatibility and WorkOS and keeps errors private", async () => {
    const response = await request("/me");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ userId: owner, organizationId: org, credential: "api_key" });
    expect((await app.request("/api/v0/me", { headers: { "x-real-ip": clientAddress } })).status).toBe(401);
    expect((await request("/me", undefined, "malformed")).status).toBe(401);
    expect((await request("/me", undefined, key, { "X-Zeros-Session-Id": "cloud:invalid" })).status).toBe(200);
    expect((await app.request(`/v1/organizations/${org}/api-keys`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    for (const path of ["/routines", "/sql", "/attachments", "/sections", "/previews"])
      expect((await request(path)).status).toBe(404);
  });

  it("never crosses organizations or creators even when the key owner belongs to both", async () => {
    const foreign = await createWorkspace(otherOrg), otherCreator = await createWorkspace(org, member);
    for (const target of [foreign, otherCreator]) {
      await store.writeHistory(target.id, { chats: [{ id: target.id, title: "Private", agentId: "codex" } as never] });
      for (const path of [`/workspaces/${target.id}`, `/workspaces/${target.id}/status`, `/workspaces/${target.id}/sessions`, `/sessions/${target.id}`])
        expect((await request(path)).status).toBe(404);
      for (const path of [`/workspaces/${target.id}/rename`, `/workspaces/${target.id}/wake`, `/sessions/${target.id}/messages`])
        expect((await request(path, { name: "Attempt", message: "Attempt" })).status).toBe(404);
    }
    const listing = await (await request("/workspaces")).json();
    expect(listing.data.map((row: { id: string }) => row.id)).toEqual([workspace.id]);
  });

  it("links workspaces and sessions through the organization's fixed ID and numbered route", async () => {
    const created = await request("/workspaces", { repository: "example/project", agent: "codex", message: "First" });
    expect(created.status).toBe(201);
    const document = await created.json();
    const expected = `https://app.example.test/org-${org}/w/${document.workspace.number}`;
    expect(document.workspace.link).toBe(expected);
    expect(document.session.link).toBe(`${expected}?session=${document.session.id}`);
    const resolved = await management().request(`/v1/cloud-v2/workspaces/by-number/org-${org}/${document.workspace.number}`);
    expect(resolved.status).toBe(200); expect((await resolved.json()).workspace.id).toBe(document.workspace.id);
    expect((await (await request(`/workspaces/${document.workspace.id}`)).json()).link).toBe(expected);
    expect((await (await request(`/sessions/${document.session.id}`)).json()).link).toBe(document.session.link);
  });

  it.each(["revoke", "membership", "entitlement", "account"])("rechecks %s on the next request", async change => {
    expect((await request("/me")).status).toBe(200);
    if (change === "revoke") await credentials.revoke(org, owner, keyId);
    if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, owner]);
    if (change === "entitlement") await pool.query("UPDATE organizations SET cloud_workspaces_allowed=false WHERE id=$1", [org]);
    if (change === "account") await pool.query("UPDATE users SET auth_status='suspended' WHERE id=$1", [owner]);
    expect((await request("/me")).status).toBe(401);
  });

  it("keeps one encrypted token across worker boots and retires it on stop before the next run", async () => {
    const first = await workspaceCredential();
    expect(await tokens.token(workspace.id) === first.credential).toBe(true);
    expect((await request("/me", undefined, first.credential)).status).toBe(200);
    const rows = await pool.query("SELECT * FROM cloud_v2_tokens WHERE kind='api'");
    expect(rows.rowCount).toBe(1); expect(JSON.stringify(rows.rows).includes(first.credential)).toBe(false);
    await store.requestLifecycle(workspace.id, owner, "stop");
    expect((await request("/me", undefined, first.credential)).status).toBe(401);
    await store.transition(workspace.id, ["stopping"], "stopped", { revoke: true });
    await store.requestLifecycle(workspace.id, owner, "start");
    const next = await workspaceCredential();
    expect(next.credential === first.credential).toBe(false);
    expect((await request("/me", undefined, next.credential)).status).toBe(200);
    expect((await request("/me", undefined, first.credential)).status).toBe(401);
    await store.beginWorkerHello(next.worker, randomUUID());
    expect((await request("/me", undefined, next.credential)).status).toBe(200);
    expect(await tokens.token(workspace.id) === next.credential).toBe(true);
  });

  it("fences API tokens as zeros_app without definer privileges and survives expiry cleanup", async () => {
    const { credential } = await workspaceCredential();
    const functionRole = await pool.query("SELECT prosecdef FROM pg_proc WHERE proname='fence_cloud_api_tokens'");
    expect(functionRole.rows[0].prosecdef).toBe(false);
    expect((await pool.query("SELECT expires_at::text AS expiry FROM cloud_v2_tokens WHERE kind='api'")).rows[0].expiry).toBe("infinity");
    await withSystemTx(pool, async tx => {
      expect((await tx.query("SELECT current_user AS role")).rows[0].role).toBe("zeros_app");
      await tx.query("DELETE FROM cloud_v2_tokens WHERE expires_at < clock_timestamp() - interval '1 hour'");
    });
    expect((await request("/me", undefined, credential)).status).toBe(200);
    await withSystemTx(pool, tx => tx.query("UPDATE cloud_v2_workspaces SET state='stopping' WHERE id=$1", [workspace.id]));
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE kind='api'")).rowCount).toBe(0);
    expect((await request("/me", undefined, credential)).status).toBe(401);
  });

  it.each(["state", "archive", "generation", "access"])("checks token %s independently of trigger cleanup", async change => {
    const { credential } = await workspaceCredential();
    await pool.query("ALTER TABLE cloud_v2_workspaces DISABLE TRIGGER cloud_api_token_lifetime");
    try {
      if (change === "state") await pool.query("UPDATE cloud_v2_workspaces SET state='stopped' WHERE id=$1", [workspace.id]);
      if (change === "archive") await pool.query("UPDATE cloud_v2_workspaces SET archived_at=clock_timestamp() WHERE id=$1", [workspace.id]);
      if (change === "generation") await pool.query("UPDATE cloud_v2_workspaces SET stop_generation=stop_generation+1 WHERE id=$1", [workspace.id]);
      if (change === "access") await pool.query("UPDATE cloud_v2_workspaces SET api_access=false WHERE id=$1", [workspace.id]);
      expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE kind='api'")).rowCount).toBe(1);
      expect((await request("/me", undefined, credential)).status).toBe(401);
    } finally { await pool.query("ALTER TABLE cloud_v2_workspaces ENABLE TRIGGER cloud_api_token_lifetime"); }
  });

  it.each(["", "workspace-api-v10", "workspace-api-v1"])("negotiates stable API config on HTTP hello and refresh: %s", async features => {
    const worker = await store.rotateWorkerToken(workspace.id), bootId = randomUUID();
    const { router, apiConfiguration } = workerRouter();
    const headers = { authorization: `Bearer ${worker}`, "x-zeros-worker-boot": bootId,
      "x-zeros-worker-features": features, "content-type": "application/json" };
    const hello = await router.request("/v2/cloud/worker/hello", { method: "POST", headers,
      body: JSON.stringify({ bootId, protocol: 2, runtimeSha256: "a".repeat(64) }) });
    expect(hello.status).toBe(200);
    const first = (await hello.json()).config;
    const next = await router.request("/v2/cloud/worker/config", { headers });
    expect(next.status).toBe(200);
    const refreshed = (await next.json()).config;
    if (features === "workspace-api-v1") {
      expect(first.api?.url).toBe("https://api.example.test/api/v0");
      expect(typeof first.api?.token).toBe("string");
      expect(first.api.token === refreshed.api?.token).toBe(true);
      expect((await request("/me", undefined, first.api.token)).status).toBe(200);
      expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE kind='api'")).rowCount).toBe(1);
      await pool.query("UPDATE cloud_v2_tokens SET api_envelope='{}'::jsonb WHERE kind='api'");
      const before = (await pool.query("SELECT id FROM cloud_v2_tokens WHERE kind='api'")).rows;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const degraded = await router.request("/v2/cloud/worker/config", { headers });
      expect(degraded.status).toBe(200);
      expect((await degraded.json()).config).not.toHaveProperty("api");
      expect(warning.mock.calls).toEqual([["[cloud-api] api_token_unavailable"]]);
      expect((await pool.query("SELECT id FROM cloud_v2_tokens WHERE kind='api'")).rows).toEqual(before);
      expect((await request("/me", undefined, first.api.token)).status).toBe(200);
    } else {
      expect(first).not.toHaveProperty("api"); expect(refreshed).not.toHaveProperty("api");
      expect(apiConfiguration).not.toHaveBeenCalled();
      expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE kind='api'")).rowCount).toBe(0);
    }
  });

  it("keeps opted-out workspaces credential-free even on a capable worker", async () => {
    await pool.query("UPDATE cloud_v2_workspaces SET api_access=false WHERE id=$1", [workspace.id]);
    const worker = await store.rotateWorkerToken(workspace.id), bootId = randomUUID();
    const { router } = workerRouter();
    const response = await router.request("/v2/cloud/worker/hello", { method: "POST",
      headers: { authorization: `Bearer ${worker}`, "content-type": "application/json", "x-zeros-worker-features": "workspace-api-v1" },
      body: JSON.stringify({ bootId, protocol: 2, runtimeSha256: "a".repeat(64) }) });
    expect(response.status).toBe(200); expect((await response.json()).config).not.toHaveProperty("api");
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE kind='api'")).rowCount).toBe(0);
  });

  it("redelivers the run token without waiting for a workspace mutation lock", async () => {
    const { credential, worker, bootId } = await workspaceCredential();
    const { router } = workerRouter();
    const held = await pool.connect();
    await held.query("BEGIN");
    try {
      await held.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
      const response = await router.request("/v2/cloud/worker/config", { headers: { authorization: `Bearer ${worker}`,
        "x-zeros-worker-boot": bootId, "x-zeros-worker-features": "workspace-api-v1" } });
      expect(response.status).toBe(200);
      expect((await response.json()).config.api?.token === credential).toBe(true);
    } finally { await held.query("ROLLBACK"); held.release(); }
  });

  it("serializes only the first token mint across control-plane replicas", async () => {
    const worker = await store.rotateWorkerToken(workspace.id);
    await store.acceptWorkerHello(worker, randomUUID());
    const issued = await Promise.all([tokens.token(workspace.id), new CloudWorkspaceApiTokens(pool, keys).token(workspace.id)]);
    expect(issued.every(value => typeof value === "string" && value === issued[0])).toBe(true);
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [workspace.id])).rowCount).toBe(1);
  });

  it.each(["archive", "delete"])("invalidates the VM-run token immediately after %s", async action => {
    const { credential } = await workspaceCredential();
    const response = await management().request(`/v1/cloud-v2/workspaces/${workspace.id}${action === "archive" ? "/archive" : ""}`,
      { method: action === "archive" ? "POST" : "DELETE" });
    expect(response.status).toBe(202);
    expect((await request("/me", undefined, credential)).status).toBe(401);
    expect((await pool.query("SELECT 1 FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [workspace.id])).rowCount).toBe(0);
  });

  it("makes passive reads without row locks or waking a stopped workspace", async () => {
    await store.transition(workspace.id, ["creating"], "stopped");
    const held = await pool.connect();
    await held.query("BEGIN");
    try {
      await held.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
      await held.query("SELECT 1 FROM cloud_api_keys WHERE id=$1 FOR UPDATE", [keyId]);
      const response = await request(`/workspaces/${workspace.id}/status`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "stopped", status: "sleeping" });
      expect((await store.get(workspace.id, owner)).state).toBe("stopped");
    } finally { await held.query("ROLLBACK"); held.release(); }
  }, 5000);

  it("lists only source-readable build identities without taking GitHub mutation locks", async () => {
    let readable = true;
    const github = createCloudGithubServices(pool, null, keys, store, vi.fn(async input => {
      const url = new URL(String(input));
      if (url.pathname === "/user") return Response.json({ id: 12, login: "contributor" });
      if (!readable) return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.pathname === "/repositories/42/branches") return Response.json([]);
      if (url.pathname === "/repositories/42") return Response.json({ id: 42, name: "renamed", owner: { login: "example" },
        default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
      throw new Error("Unexpected synthetic GitHub request");
    }));
    const scope = { organizationId: org, userId: owner };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope),
      { id: "12", login: "contributor" }, { method: "pat", accessToken: "synthetic-pat", expiresAt: null });
    routes.githubConnections = github.connections;
    const computers = new CloudV2Computers(pool, pool, github.resolveRepository, github.resolveRecentRepository);
    routes.computers = computers;
    routes.authorizeBuildRepository = async (organization, user, build, repository) => {
      const target = await computers.resolveBuildRepository(organization, user, build, repository);
      await github.source.targets(organization, user, [target]);
      return target;
    };
    const held = await pool.connect();
    await held.query("BEGIN");
    try {
      await held.query("SELECT pg_advisory_xact_lock(hashtextextended(format('[\"%s\",\"%s\"]',$1::uuid::text,$2::uuid::text),0))", [org, owner]);
      await held.query("LOCK TABLE cloud_github_source_verifications IN SHARE MODE");
      const response = await request("/repositories");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: [{ repository: "example/renamed", defaultBranch: "main" }], offset: 0, hasMore: false });
      readable = false;
      expect(await (await request("/repositories")).json()).toEqual({ data: [], offset: 0, hasMore: false });
      expect((await pool.query("SELECT 1 FROM cloud_github_source_verifications")).rowCount).toBe(0);
    } finally { await held.query("ROLLBACK"); held.release(); }
  });

  it.each(["expired", "rejected"])("refreshes an %s GitHub user credential when listing repositories before create", async reason => {
    let refreshed = 0;
    const github = createCloudGithubServices(pool, {
      appId: 99, apiBaseUrl: "https://api.github.test", webBaseUrl: "https://github.test", appSlug: "zeros-test",
      clientId: "test-client", clientSecret: "synthetic-client-secret", oauthCallbackUrl: "https://api.example.test/v1/github/oauth/callback",
    } as GithubBackendConfig, keys, store, vi.fn(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/login/oauth/access_token") {
        refreshed++;
        return Response.json({ access_token: "synthetic-renewed-token", refresh_token: "synthetic-next-refresh",
          expires_in: 28800, refresh_token_expires_in: 15897600 });
      }
      if (url.pathname === "/user") {
        if (reason === "rejected" && new Headers(init?.headers).get("authorization")?.includes("synthetic-expired-token"))
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        return Response.json({ id: 12, login: "contributor" });
      }
      if (url.pathname === "/repositories/42/branches") return Response.json([]);
      if (url.pathname === "/repositories/42") return Response.json({ id: 42, name: "project", owner: { login: "example" },
        default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
      throw new Error("Unexpected synthetic GitHub request");
    }));
    const scope = { organizationId: org, userId: owner };
    await github.connections.store.save(scope, await github.connections.store.fingerprint(scope), { id: "12", login: "contributor" },
      { method: "github-app", accessToken: "synthetic-expired-token", refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + (reason === "expired" ? -1000 : 3_600_000), refreshExpiresAt: Date.now() + 86_400_000 });
    routes.githubConnections = github.connections;
    await store.transition(workspace.id, ["creating"], "stopped");
    const held = await pool.connect();
    await held.query("BEGIN");
    try {
      await held.query("SELECT 1 FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [workspace.id]);
      await held.query("LOCK TABLE cloud_github_source_verifications IN SHARE MODE");
      const response = await request("/repositories"), document = await response.json();
      expect({ status: response.status, code: document.error?.code }).toEqual({ status: 200, code: undefined });
      expect(document.data).toEqual([{ repository: "example/project", defaultBranch: "main" }]);
      expect((await request("/repositories")).status).toBe(200);
      expect(refreshed).toBe(1);
      expect((await store.get(workspace.id, owner)).state).toBe("stopped");
      expect((await pool.query("SELECT 1 FROM cloud_github_source_verifications")).rowCount).toBe(0);
      expect(routes.authorizeBuildRepository).not.toHaveBeenCalled();
    } finally { await held.query("ROLLBACK"); held.release(); }
  });

  it("refuses a session id already used in another owned workspace without enqueueing or waking", async () => {
    const second = await createWorkspace(), sessionId = randomUUID();
    await store.transition(second.id, ["creating"], "stopped");
    expect((await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "First", sessionId })).status).toBe(201);
    const response = await request("/sessions", { workspaceId: second.id, agent: "codex", message: "Other", sessionId });
    expect(response.status).toBe(409);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [second.id])).rowCount).toBe(0);
    expect((await store.get(second.id, owner)).state).toBe("stopped");
    expect((await request(`/sessions/${sessionId}`)).status).toBe(200);
  });

  it.each(["session", "message"])("requires unarchive before API %s sends, including receipt replays", async operation => {
    const sessionId = randomUUID(), messageId = randomUUID();
    const first = { workspaceId: workspace.id, agent: "codex", message: "First", sessionId, messageId };
    expect((await request("/sessions", first)).status).toBe(201);
    await store.transition(workspace.id, ["creating"], "stopped");
    await store.requestLifecycle(workspace.id, owner, "archive");
    vi.mocked(routes.authorizeSource!).mockClear();
    const path = operation === "session" ? "/sessions" : `/sessions/${sessionId}/messages`;
    const body = operation === "session" ? first : { message: "First", messageId };
    for (const input of [body, { ...body, messageId: randomUUID() }]) {
      const response = await request(path, input);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("workspace_archived");
    }
    const archived = await store.get(workspace.id, owner);
    expect(archived.state).toBe("stopped"); expect(archived.archivedAt).not.toBeNull();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(1);
    expect(routes.authorizeSource).not.toHaveBeenCalled();
    expect((await request(`/workspaces/${workspace.id}/unarchive`, {})).status).toBe(200);
    expect((await request(path, { ...body, messageId: randomUUID() })).status).toBe(201);
  });

  it.each(["session", "message"])("fences an archive during API %s authorization before enqueue", async operation => {
    const sessionId = randomUUID();
    await store.writeHistory(workspace.id, { chats: [{ id: sessionId, agentId: "codex" } as never] });
    await store.transition(workspace.id, ["creating"], "stopped");
    const read = store.promptContext.bind(store);
    const authorize = vi.spyOn(store, "promptContext").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      await store.requestLifecycle(workspace.id, owner, "archive");
      return result;
    });
    const response = operation === "session"
      ? await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "New" })
      : await request(`/sessions/${sessionId}/messages`, { message: "New" });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("workspace_archived");
    expect(authorize).toHaveBeenCalled();
    const archived = await store.get(workspace.id, owner);
    expect(archived.state).toBe("stopped"); expect(archived.archivedAt).not.toBeNull();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
  });

  it.each(["", "session-name-v10", "agent-interactions-v1", "session-name-v1", "agent-interactions-v1,session-name-v1"])("delivers a first session name only to an opted-in worker: %s", async features => {
    const { worker, bootId } = await workspaceCredential();
    const input = { workspaceId: workspace.id, agent: "codex", message: "First", name: "  Named task  ",
      sessionId: randomUUID(), messageId: randomUUID() };
    const created = await request("/sessions", input);
    expect(created.status).toBe(201);
    const { session } = await created.json();
    expect(session.name).toBe("Named task");
    const replay = await request("/sessions", { ...input, name: "Replay cannot rename" });
    expect(replay.status).toBe(201); expect((await replay.json()).session.name).toBe("Named task");
    const saved = (await pool.query("SELECT session_name,payload FROM cloud_v2_prompt_outbox WHERE user_message_id=$1", [input.messageId])).rows[0];
    expect(saved.session_name).toBe("Named task");
    expect(saved.payload).not.toHaveProperty("name"); expect(saved.payload).not.toHaveProperty("sessionName");
    const { router } = workerRouter(true);
    const headers = { authorization: `Bearer ${worker}`, "x-zeros-worker-boot": bootId,
      "x-zeros-worker-features": features, "content-type": "application/json" };
    const pull = () => router.request("/v2/cloud/worker/prompts/pull", { method: "POST", headers, body: JSON.stringify({ waitMs: 0, held: [] }) });
    const response = await pull(); expect(response.status).toBe(200);
    const delivery = (await response.json()).prompts[0];
    const supported = features.split(",").includes("session-name-v1");
    if (supported) expect(delivery.sessionName).toBe("Named task");
    else expect(delivery).not.toHaveProperty("sessionName");
    expect(delivery.payload).not.toHaveProperty("sessionName");
    expect((await (await pull()).json()).prompts[0]).toEqual(delivery);
    const title = delivery.sessionName ?? "";
    const mirrored = await router.request("/v2/cloud/worker/history", { method: "POST", headers,
      body: JSON.stringify({ t: "history", bootId, sequence: 1, chats: [{ id: session.id,
        folder: "/home/user/example/project", agentId: "codex", agentName: "Codex", title, model: null, effort: "",
        createdAt: Date.now(), updatedAt: Date.now() }] }) });
    expect(mirrored.status).toBe(200);
    expect(await (await request(`/sessions/${session.id}`)).json()).toMatchObject({ name: supported ? "Named task" : "" });
    expect((await request("/sessions", { ...input, name: "Replay after mirror" })).status).toBe(201);
    expect(await (await request(`/sessions/${session.id}`)).json()).toMatchObject({ name: title });
  });

  it("rejects empty, oversized and control-bearing session names before creating work", async () => {
    for (const name of ["", "   ", "x".repeat(121), "line\nbreak", "nul\u0000byte", "delete\u007fchar", "control\u0085char", "Task\n", "\tTask"]) {
      expect((await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "First", name })).status).toBe(400);
      expect((await request("/workspaces", { repository: "example/project", agent: "codex", message: "First", sessionName: name })).status).toBe(400);
    }
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces")).rowCount).toBe(1);
  });

  it("never seeds a new name for an existing chat", async () => {
    const sessionId = randomUUID();
    await store.writeHistory(workspace.id, { chats: [{ id: sessionId, agentId: "codex", title: "Worker title" } as never] });
    const messageId = randomUUID();
    const response = await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "Next", sessionId, messageId, name: "New label" });
    expect(response.status).toBe(201); expect((await response.json()).session.name).toBe("Worker title");
    expect((await pool.query("SELECT session_name FROM cloud_v2_prompt_outbox WHERE user_message_id=$1", [messageId])).rows[0].session_name).toBeNull();
  });

  it("commits an idempotent create and its discoverable first session together", async () => {
    const body = { repository: "example/project", agent: "codex", message: "First prompt", sessionName: "  First task  " };
    const headers = { "Idempotency-Key": randomUUID() };
    const first = await request("/workspaces", body, key, headers); expect(first.status).toBe(201);
    const document = await first.json();
    const again = await request("/workspaces", body, key, headers);
    expect(again.status).toBe(201); expect(await again.json()).toEqual(document);
    expect(document.session).toMatchObject({ name: "First task", agent: "codex", workspaceId: document.workspace.id });
    expect((await pool.query("SELECT session_name FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [document.workspace.id])).rows[0].session_name).toBe("First task");
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces")).rowCount).toBe(2);
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [document.workspace.id])).rowCount).toBe(1);
    expect((await request("/workspaces", { ...body, message: "Changed" }, key, headers)).status).toBe(409);
  });

  describe("durable sender identity", () => {
    const receiptRows = async (workspaceIds: string[]) => (await pool.query(
      "SELECT to_jsonb(p) AS row FROM cloud_v2_prompt_outbox p WHERE workspace_id=ANY($1::uuid[]) ORDER BY created_at,user_message_id", [workspaceIds])).rows.map(value => value.row);
    it.each([
      { kind: "api_key", transport: "HTTP" }, { kind: "workspace_token", transport: "HTTP" },
      { kind: "api_key", transport: "MCP" }, { kind: "workspace_token", transport: "MCP" },
    ])("records authenticated $kind senders on every $transport prompt entry point", async ({ kind, transport }) => {
      const bearer = kind === "api_key" ? key : (await workspaceCredential()).credential;
      const credential = await credentials.resolve(`Bearer ${bearer}`);
      const source = randomUUID();
      await store.writeHistory(workspace.id, { chats: [{ id: source, agentId: "codex" }] });
      const headers = { "X-Zeros-Session-Id": source, "X-Zeros-User-Id": member, "X-Zeros-Context-Id": randomUUID() };
      async function invoke(name: string, args: Record<string, unknown>, path: string) {
        const response = transport === "MCP"
          ? await mcp("tools/call", { name, arguments: args }, bearer, headers)
          : await request(path, args, bearer, headers);
        expect(response.status).toBe(transport === "MCP" ? 200 : 201);
        const body = await response.json();
        return transport === "MCP" ? body.result.structuredContent : body;
      }
      const created = await invoke("create_workspace", { repository: "example/project", agent: "codex", message: "Initial" }, "/workspaces");
      const chat = await invoke("create_session", { workspaceId: workspace.id, agent: "codex", message: "Session" }, "/sessions");
      const messageId = randomUUID();
      const args = { message: "Follow up", messageId, ...(transport === "MCP" ? { sessionId: chat.session.id } : {}) };
      await invoke("send_message", args, `/sessions/${chat.session.id}/messages`);
      const rows = await receiptRows([workspace.id, created.workspace.id]);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({ creator_user_id: owner, sender_provider_session_id: null,
          sender_credential_kind: kind, sender_credential_id: credential.credentialId, sender_context_id: null, created_by_session_id: source });
        for (const field of ["senderUserId", "senderProviderSessionId", "senderCredentialId", "senderContextId"])
          expect(row.payload).not.toHaveProperty(field);
      }
    });

    it.each(["api_key", "workspace_token"])("records real CLI creates and sends as its %s owner", async kind => {
      const { env, command } = await cloudCli();
      env.ZEROS_API_KEY = kind === "api_key" ? key : (await workspaceCredential()).credential;
      const credential = await credentials.resolve(`Bearer ${env.ZEROS_API_KEY}`);
      const created = await command("workspace", "create", "--repository", "example/project", "--agent", "codex", "--message", "Initial");
      const chat = await command("session", "create", "--agent", "codex", "--message", "Session");
      await command("message", "send", "--session", chat.session.id, "--message", "Follow up");
      const rows = await receiptRows([workspace.id, created.workspace.id]);
      expect(rows).toHaveLength(3);
      for (const row of rows) expect(row).toMatchObject({ creator_user_id: owner, sender_provider_session_id: null,
        sender_credential_kind: kind, sender_credential_id: credential.credentialId, sender_context_id: null });
    });

    it("preserves the first credential on same-person replay and refuses caller-supplied sender fields", async () => {
      const body = { workspaceId: workspace.id, agent: "codex", message: "First", sessionId: randomUUID(), messageId: randomUUID() };
      const first = await request("/sessions", body); expect(first.status).toBe(201);
      const another = await credentials.create(org, owner, "Another key");
      const replay = await request("/sessions", body, another.key); expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(await first.json());
      const rows = await receiptRows([workspace.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ creator_user_id: owner, sender_credential_id: keyId, sender_credential_kind: "api_key" });
      for (const field of ["senderUserId", "senderProviderSessionId", "senderCredentialId", "senderContextId"])
        expect((await request("/sessions", { ...body, [field]: member })).status).toBe(400);
    });
  });

  describe("request attribution", () => {
    const callingChat = (id = randomUUID()) => ({ id, title: "Caller", agentId: "codex" });

    it.each(["api_key", "workspace_token"])("accepts only the %s caller's permitted session headers and ignores all others", async kind => {
      const otherWorkspace = await createWorkspace(), foreignUser = await createWorkspace(org, member), foreignOrg = await createWorkspace(otherOrg);
      const own = callingChat(), elsewhere = callingChat(), otherUser = callingChat(), otherOrganization = callingChat();
      const terminal = callingChat(), deleted = callingChat();
      await store.writeHistory(workspace.id, { chats: [own, { ...terminal, kind: "terminal" }, deleted], chatDeletions: [deleted.id] });
      await store.writeHistory(otherWorkspace.id, { chats: [elsewhere] });
      await store.writeHistory(foreignUser.id, { chats: [otherUser] });
      await store.writeHistory(foreignOrg.id, { chats: [otherOrganization] });
      const credential = kind === "api_key" ? key : (await workspaceCredential()).credential;
      const cases: Array<[string | undefined, string | null]> = [
        [own.id, own.id], [elsewhere.id, kind === "api_key" ? elsewhere.id : null],
        [otherUser.id, null], [otherOrganization.id, null], [terminal.id, null], [deleted.id, null],
        [randomUUID(), null], ["cloud:invalid", null], ["x".repeat(257), null], [undefined, null],
      ];
      for (const [header, attribution] of cases) {
        const headers = header === undefined ? {} : { "X-Zeros-Session-Id": header };
        const response = await request("/sessions", { workspaceId: otherWorkspace.id, agent: "codex", message: "Delegated" }, credential, headers);
        expect(response.status, header).toBe(201);
        const result = await response.json();
        expect(result.session.createdBySessionId, header).toBe(attribution);
        expect(result.message.createdBySessionId, header).toBe(attribution);
        expect((await pool.query("SELECT created_by_session_id FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2",
          [otherWorkspace.id, result.message.id])).rows[0].created_by_session_id).toBe(attribution);
        expect((await (await request(`/sessions/${result.session.id}`)).json()).createdBySessionId).toBe(attribution);
      }
      expect((await request("/sessions", { workspaceId: otherWorkspace.id, agent: "codex", message: "Spoofed", createdBySessionId: own.id })).status).toBe(400);
    });

    it.each(["api_key", "workspace_token"])("keeps %s attribution through create and send replays, worker mirrors and MCP reads", async kind => {
      const source = callingChat(), alternate = callingChat();
      await store.writeHistory(workspace.id, { chats: [source, alternate] });
      const credential = kind === "api_key" ? key : (await workspaceCredential()).credential;
      const headers = { "X-Zeros-Session-Id": source.id, "Idempotency-Key": randomUUID() };
      const input = { repository: "example/project", agent: "codex", message: "First" };
      const first = await request("/workspaces", input, credential, headers);
      expect(first.status).toBe(201);
      const created = await first.json(), id = created.workspace.id, sessionId = created.session.id;
      expect(created.workspace.createdBySessionId).toBe(source.id);
      expect(created.session.createdBySessionId).toBe(source.id);
      expect(await (await request("/workspaces", input, credential, { ...headers, "X-Zeros-Session-Id": alternate.id })).json()).toEqual(created);
      expect((await (await request(`/workspaces/${id}`)).json()).createdBySessionId).toBe(source.id);
      expect((await (await request("/workspaces")).json()).data.find((row: { id: string }) => row.id === id).createdBySessionId).toBe(source.id);
      const send = { message: "Follow up", messageId: randomUUID() }, path = `/sessions/${sessionId}/messages`;
      const expected = { message: { id: send.messageId, createdBySessionId: source.id } };
      const sent = await request(path, send, credential, headers);
      expect(sent.status).toBe(201); expect(await sent.json()).toEqual(expected);
      const replay = await request(path, send, credential, { "X-Zeros-Session-Id": alternate.id });
      expect(replay.status).toBe(200); expect(await replay.json()).toEqual(expected);
      const queue = (await pool.query("SELECT created_by_session_id,payload FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [id])).rows;
      expect(queue).toHaveLength(2);
      expect(queue.every(row => row.created_by_session_id === source.id)).toBe(true);
      expect(queue.every(row => !Object.hasOwn(row.payload, "createdBySessionId"))).toBe(true);
      await store.writeHistory(id, { chats: [{ id: sessionId, agentId: "codex", title: "Mirrored", createdBySessionId: alternate.id } as never],
        messages: { chatId: sessionId, rows: [{ msgId: send.messageId, kind: "text", payload: JSON.stringify({ role: "user", text: send.message }), createdAt: 123 }] } });
      expect((await (await request(`/sessions/${sessionId}`)).json()).createdBySessionId).toBe(source.id);
      expect((await (await request(`/workspaces/${id}/sessions`)).json()).data[0].createdBySessionId).toBe(source.id);
      expect((await (await request(`/sessions/${sessionId}/messages/${send.messageId}`)).json()).createdBySessionId).toBe(source.id);
      expect((await (await request(`/sessions/${sessionId}/messages`)).json()).data[0].createdBySessionId).toBe(source.id);
      expect((await tool("get_session", { sessionId })).structuredContent.createdBySessionId).toBe(source.id);
      expect((await tool("get_message", { sessionId, messageId: send.messageId })).structuredContent.createdBySessionId).toBe(source.id);
      await store.writeHistory(workspace.id, { chatDeletions: [source.id] });
      expect((await (await request(`/workspaces/${id}`)).json()).createdBySessionId).toBe(source.id);
    });

    it("uses the same attribution boundary for MCP creates and sends and preserves CLI JSON", async () => {
      const source = callingChat();
      await store.writeHistory(workspace.id, { chats: [source] });
      const headers = { "X-Zeros-Session-Id": source.id };
      const created = await (await mcp("tools/call", { name: "create_workspace", arguments: { repository: "example/project" } }, key, headers)).json();
      expect(created.result.structuredContent.workspace.createdBySessionId).toBe(source.id);
      const result = await (await mcp("tools/call", { name: "create_session", arguments: { workspaceId: workspace.id, agent: "codex", message: "MCP" } }, key, headers)).json();
      const sessionId = result.result.structuredContent.session.id;
      expect(result.result.structuredContent.session.createdBySessionId).toBe(source.id);
      expect(result.result.structuredContent.message.createdBySessionId).toBe(source.id);
      const sent = await (await mcp("tools/call", { name: "send_message", arguments: { sessionId, message: "MCP next" } }, key, headers)).json();
      expect(sent.result.structuredContent.message.createdBySessionId).toBe(source.id);
      const { env, command } = await cloudCli();
      env.ZEROS_SESSION_ID = source.id;
      const cli = await command("session", "create", "--agent", "codex", "--message", "CLI");
      expect(cli.session.createdBySessionId).toBe(source.id);
      expect(cli.message.createdBySessionId).toBe(source.id);
    });
  });

  describe("create-time workspace environment", () => {
    const environments = () => new CloudEnvironments(pool, keys, async () => ({ repositoryId: "42",
      assertCurrent: async () => {}, assertReadable: async () => {} }));
    const create = (env: unknown, headers: Record<string, string> = {}) => request("/workspaces", { repository: "example/project", env }, key, headers);

    it("rejects invalid names, reserved runtime authority, non-string values and byte/count overflows before creating", async () => {
      const invalid = [null, [], { VALUE: 1 }, { VALUE: null }, { VALUE: "nul\0byte" }, { "": "value" }, { "BAD-NAME": "value" },
        { "NAME\n": "value" }, { ["X".repeat(129)]: "value" }, JSON.parse('{"__proto__":"value"}'),
        Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`VALUE_${i}`, "value"])),
        { VALUE: "a".repeat(8193) }, { VALUE: "🔑".repeat(2048) + "x" },
        Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`VALUE_${i}`, "a".repeat(i === 8 ? 1 : 8192)])),
        ...["PATH", "HOME", "NODE_OPTIONS", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
          "ZEROS_API_URL", "ZEROS_API_TOKEN", "ZEROS_WORKSPACE_ID", "ZEROS_SESSION_ID", "zeros_api_key", "constructor"].map(name => ({ [name]: "value" })),
      ];
      for (const [index, env] of invalid.entries()) {
        const response = await create(env);
        expect(response.status, `environment case ${index}`).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
      expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces")).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(0);
      expect((await tool("create_workspace", { repository: "example/project", env: { PATH: "bad" } })).structuredContent.error.code).toBe("invalid_request");
      expect((await tool("create_workspace", { repository: "example/project", env: JSON.parse('{"__proto__":"value"}') })).structuredContent.error.code).toBe("invalid_request");
      const definitions = await (await mcp("tools/list")).json();
      expect(definitions.result.tools.find((tool: { name: string }) => tool.name === "create_workspace").inputSchema.properties.env)
        .toMatchObject({ type: "object", maxProperties: 50, additionalProperties: { type: "string" } });
    });

    it("accepts exact byte and entry limits, empty values, and the user-settable API key name", async () => {
      for (const env of [Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`VALUE_${i}`, ""])),
        Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`VALUE_${i}`, "a".repeat(8192)])),
        { UNICODE: "🔑".repeat(2048), ZEROS_API_KEY: "synthetic-api-key" }, {}]) {
        const response = await create(env);
        expect(response.status).toBe(201);
        const { workspace: created } = await response.json();
        expect((await environments().resolve(await store.get(created.id, owner)))?.variables ?? {}).toEqual(env);
      }
    });

    it("pins encrypted overrides over Cloud defaults, delivers through environment config, and erases them on deletion", async () => {
      const saved = environments(), secret = "synthetic-workspace-secret";
      const defaults = await saved.patch(org, owner, "42", "example/project", { expectedRevision: 0,
        variables: { SHARED: "synthetic-default", ONLY_DEFAULT: "retained" }, files: [{ path: ".env.local", content: "APP_FILE=retained" }] });
      routes.asyncCreate = () => true;
      const response = await create({ SHARED: secret, ONLY_WORKSPACE: "workspace-value" });
      expect(response.status).toBe(201);
      const created = (await response.json()).workspace, row = await store.get(created.id, owner);
      // N-1 source binding inserts its default pin unconditionally. An explicit
      // environment finishes that binding before publishing its private pin.
      expect(row.sourcePending).toBeUndefined();
      expect(routes.authorizeBuildRepository).toHaveBeenCalled();
      const material = await saved.resolve(row);
      expect(material).toMatchObject({ repositoryId: "42", variables: { SHARED: secret, ONLY_DEFAULT: "retained", ONLY_WORKSPACE: "workspace-value" },
        files: [{ path: ".env.local", content: "APP_FILE=retained" }] });
      expect(material!.versionId).not.toBe(defaults.versionId);
      await saved.patch(org, owner, "42", "example/project", { expectedRevision: 1, variables: { SHARED: "later-default" } });
      expect(await saved.resolve(row)).toEqual(material);
      const worker = await store.rotateWorkerToken(row.id), bootId = randomUUID(), { router } = workerRouter(false, undefined, saved);
      const hello = (features: string) => router.request("/v2/cloud/worker/hello", { method: "POST", headers: {
        authorization: `Bearer ${worker}`, "content-type": "application/json", "x-zeros-worker-boot": bootId, "x-zeros-worker-features": features },
      body: JSON.stringify({ bootId, protocol: 2, runtimeSha256: "a".repeat(64) }) });
      const configured = await hello("workspace-environment-v1");
      expect(configured.status).toBe(200);
      expect((await configured.json()).config.environment).toEqual(material);
      expect((await hello("")).status).toBe(409);
      for (const read of [await request(`/workspaces/${row.id}`), await request(`/workspaces/${row.id}/status`), await request("/workspaces"),
        await management().request(`/v1/cloud-v2/workspaces/${row.id}`)]) {
        expect(read.status).toBe(200);
        const text = await read.text();
        expect(text.includes(secret) || text.includes("ONLY_WORKSPACE")).toBe(false);
      }
      expect(JSON.stringify((await tool("get_workspace", { workspaceId: row.id })).structuredContent).includes(secret)).toBe(false);
      const stored = await pool.query("SELECT envelope FROM cloud_environment_versions");
      expect(JSON.stringify(stored.rows).includes(secret)).toBe(false);
      expect((await saved.get(org, owner, "42", "example/project")).variables.map(value => value.name)).not.toContain("ONLY_WORKSPACE");
      for (const table of ["cloud_environment_versions", "cloud_workspace_environment_pins"])
        expect((await withUserTx(pool, owner, tx => tx.query(`SELECT 1 FROM ${table}`))).rowCount).toBe(0);
      expect((await management().request(`/v1/cloud-v2/workspaces/${row.id}`, { method: "DELETE" })).status).toBe(202);
      await store.transition(row.id, ["deleting"], "deleted");
      expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [row.id])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_environment_versions WHERE id=$1", [material!.versionId])).rowCount).toBe(0);
      expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(1);
    });

    it("keeps one immutable private environment across idempotent replay and rejects changed values through HTTP and MCP", async () => {
      const env = { B: "synthetic-two", A: "synthetic-one" }, headers = { "Idempotency-Key": randomUUID() };
      const first = await create(env, headers);
      expect(first.status).toBe(201);
      const document = await first.json();
      expect(await (await create({ A: env.A, B: env.B }, headers)).json()).toEqual(document);
      expect((await create({ ...env, A: "changed" }, headers)).status).toBe(409);
      const result = await tool("create_workspace", { repository: "example/project", env, idempotencyKey: headers["Idempotency-Key"] });
      expect(result.structuredContent).toEqual(document);
      expect((await tool("create_workspace", { repository: "example/project", env: { A: "changed" }, idempotencyKey: headers["Idempotency-Key"] })).structuredContent.error.code).toBe("idempotency_conflict");
      expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins")).rowCount).toBe(1);
      expect(JSON.stringify((await pool.query("SELECT response FROM cloud_v2_create_requests")).rows).includes(env.A)).toBe(false);
    });

    it("joins repeatable CLI --env with encrypted creation, read secrecy and idempotency", async () => {
      const saved = environments();
      await saved.patch(org, owner, "42", "example/project", { expectedRevision: 0,
        variables: { SHARED: "saved-default", ONLY_DEFAULT: "retained" } });
      const { command } = await cloudCli(), createKey = randomUUID();
      const args = ["workspace", "create", "--repository", "example/project", "--idempotency-key", createKey];
      const overrides = ["SHARED=synthetic-cli=override", "ONLY_WORKSPACE=synthetic-cli-private", "EMPTY="];
      const flags = (values: string[]) => values.flatMap(value => ["--env", value]);
      const created = await command(...args, ...flags(overrides));
      const material = await saved.resolve(await store.get(created.workspace.id, owner));
      expect(material?.variables).toEqual({ SHARED: "synthetic-cli=override", ONLY_DEFAULT: "retained",
        ONLY_WORKSPACE: "synthetic-cli-private", EMPTY: "" });
      expect(await command(...args, ...flags([...overrides].reverse()))).toEqual(created);
      const reads = JSON.stringify([created, await command("workspace", "get", created.workspace.id), await command("workspace", "list")]);
      for (const hidden of ["synthetic-cli=override", "synthetic-cli-private", "ONLY_WORKSPACE"])
        expect(reads).not.toContain(hidden);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins WHERE workspace_id=$1", [created.workspace.id])).rowCount).toBe(1);
    });

    it("retains unreadable defaults and rolls back a merged environment that exceeds the existing worker limits", async () => {
      const saved = environments();
      await saved.patch(org, owner, "42", "example/project", { expectedRevision: 0,
        variables: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`DEFAULT_${i}`, "value"])) });
      expect((await create({ EXTRA: "value" })).status).toBe(400);
      await pool.query("UPDATE cloud_environment_versions SET envelope='{}'::jsonb");
      const unreadable = await create({ DEFAULT_0: "value" });
      expect(unreadable.status).toBe(503);
      expect((await unreadable.json()).error.code).toBe("cloud_environment_unreadable");
      expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces")).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM cloud_environment_versions")).rowCount).toBe(1);
      expect((await pool.query("SELECT 1 FROM cloud_workspace_environment_pins")).rowCount).toBe(0);
    });
  });

  it("replays a message by id and text across concurrent sends and rejects a changed text", async () => {
    await store.transition(workspace.id, ["creating"], "stopped");
    const first = await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "First" });
    expect(first.status).toBe(201);
    const { session } = await first.json();
    const body = { message: "Next", messageId: randomUUID() }, path = `/sessions/${session.id}/messages`;
    const sends = await Promise.all([request(path, body), request(path, body)]);
    expect(sends.map(response => response.status).sort()).toEqual([200, 201]);
    expect((await request(path, { ...body, message: "Changed" })).status).toBe(409);
    expect((await store.get(workspace.id, owner)).state).toBe("starting");
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(2);
    expect(await (await request(`/sessions/${session.id}/status`)).json()).toMatchObject({ status: "working" });
    expect((await request(`/sessions/${session.id}/cancel`, {})).status).toBe(200);
    expect(await (await request(`/sessions/${session.id}/status`)).json()).toMatchObject({ status: "idle" });
  });

  it("reads ordered mirrored messages and after cursors without waking", async () => {
    const chatId = randomUUID();
    await store.writeHistory(workspace.id, { chats: [{ id: chatId, agentId: "claude", title: "Saved" } as never],
      messages: { chatId, rows: [
        { msgId: "m1", kind: "text", payload: JSON.stringify({ role: "user", text: "hello" }), createdAt: 100 },
        { msgId: "m2", kind: "tool", payload: "legacy text", createdAt: 101 },
        { msgId: "m3", kind: "text", payload: JSON.stringify({ role: "assistant", text: "done" }), createdAt: 102 },
      ] } });
    await store.transition(workspace.id, ["creating"], "stopped");
    const first = await (await request(`/sessions/${chatId}/messages?limit=1`)).json();
    expect(first).toMatchObject({ data: [{ id: "m1", index: 1, content: { role: "user" } }], offset: 0, hasMore: true });
    const after = await (await request(`/sessions/${chatId}/messages?after=m1&limit=1`)).json();
    expect(after).toMatchObject({ data: [{ id: "m2", index: 2, content: "legacy text" }], hasMore: true });
    expect(await (await request(`/sessions/${chatId}/messages/m3`)).json()).toMatchObject({ id: "m3", index: 3 });
    expect((await request(`/sessions/${chatId}/messages?after=unknown`)).status).toBe(404);
    expect((await store.get(workspace.id, owner)).state).toBe("stopped");
  });

  it("bounds a message page by bytes while retaining a usable continuation", async () => {
    const chatId = randomUUID(), payload = "x".repeat(900_000);
    await store.writeHistory(workspace.id, { chats: [{ id: chatId, agentId: "codex" } as never],
      messages: { chatId, rows: Array.from({ length: 10 }, (_, index) => ({ msgId: `large-${index}`, kind: "text", payload, createdAt: index })) } });
    const response = await request(`/sessions/${chatId}/messages?limit=100`), body = await response.json();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(body)) < 8 * 1024 * 1024).toBe(true);
    expect(body.hasMore).toBe(true);
    const next = await (await request(`/sessions/${chatId}/messages?after=${body.data.at(-1).id}&limit=100`)).json();
    expect(body.data.length + next.data.length).toBe(10); expect(next.hasMore).toBe(false);
    expect(next.data[0].index).toBe(body.data.length + 1);
  });

  it("enforces per-credential request and creation limits", async () => {
    for (let index = 0; index < 240; index++) expect((await request("/me")).status).toBe(200);
    const limited = await request("/me"); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await request("/me", undefined, key, { "x-zeros-session-id": "cloud:invalid" })).status).toBe(429);
    const another = await credentials.create(org, owner, "Independent");
    const body = { repository: "example/project" }, headers = { "Idempotency-Key": randomUUID() };
    for (let index = 0; index < 60; index++) expect((await request("/workspaces", body, another.key, headers)).status).toBe(201);
    expect((await request("/workspaces", body, another.key, headers)).status).toBe(429);
    const token = (await workspaceCredential()).credential;
    const tokenHeaders = { "Idempotency-Key": randomUUID() };
    for (let index = 0; index < 10; index++) expect((await request("/workspaces", body, token, tokenHeaders)).status).toBe(201);
    expect((await request("/workspaces", body, token, tokenHeaders)).status).toBe(429);
  }, 20_000);

  it("admits API messages without GitHub and rechecks the credential after the workspace read", async () => {
    vi.mocked(routes.authorizeSource!).mockRejectedValue(new HttpError(403, "github_cloud_access_denied", "Source access denied"));
    expect((await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "Admitted" })).status).toBe(201);
    expect(routes.authorizeSource).not.toHaveBeenCalled();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(1);
    const read = store.promptContext.bind(store);
    const authorize = vi.spyOn(store, "promptContext").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      await credentials.revoke(org, owner, keyId);
      return result;
    });
    expect((await request("/sessions", { workspaceId: workspace.id, agent: "codex", message: "Revoked" })).status).toBe(401);
    expect(authorize).toHaveBeenCalled();
    expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(1);
  });

  it.each(["192.0.2.77", "invalid"])("bounds random credential lookups before authentication using X-Real-IP: %s", async address => {
    const lookup = vi.spyOn(credentials, "resolve");
    const headers = { "x-real-ip": address };
    for (let index = 0; index < 1200; index++) {
      const response = await request("/me", undefined, `zk_${randomBytes(32).toString("base64url")}`, headers);
      expect(response.status).toBe(401);
    }
    const before = lookup.mock.calls.length;
    const blocked = await request("/me", undefined, key, { "x-real-ip": address === "invalid" ? "another-invalid" : address,
      "x-forwarded-for": "192.0.2.78" });
    expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(lookup).toHaveBeenCalledTimes(before);
    expect((await request("/me", undefined, key, { "x-real-ip": clientAddress })).status).toBe(200);
  }, 20_000);

  it("does not charge valid requests sharing one egress address against the pre-auth budget", async () => {
    for (let credentialIndex = 0; credentialIndex < 7; credentialIndex++) {
      const valid = await credentials.create(org, owner, `Shared egress ${credentialIndex}`);
      for (let requestIndex = 0; requestIndex < 180; requestIndex++)
        expect((await request("/me", undefined, valid.key)).status).toBe(200);
    }
    expect((await request("/me", undefined, "malformed")).status).toBe(401);
  }, 20_000);

  it("shares the durable creator budget with a newly created workspace's token", async () => {
    for (let index = 0; index < 8; index++) await createWorkspace();
    const parent = (await workspaceCredential()).credential;
    const body = { repository: "example/project" }, headers = { "Idempotency-Key": randomUUID() };
    const created = await request("/workspaces", body, parent, headers);
    expect(created.status).toBe(201);
    const child = (await created.json()).workspace;
    const worker = await store.rotateWorkerToken(child.id);
    await store.acceptWorkerHello(worker, randomUUID());
    const childToken = (await tokens.token(child.id))!;
    const refused = await request("/workspaces", body, childToken);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await refused.json()).error.code).toBe("workspace_create_limit");
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces WHERE org_id=$1 AND creator_user_id=$2", [org, owner])).rowCount).toBe(10);
    await pool.query("UPDATE cloud_v2_workspaces SET state='deleted' WHERE org_id=$1 AND id<>$2 AND id<>$3", [org, workspace.id, child.id]);
    expect((await request("/workspaces", body, childToken)).status).toBe(429);
    expect((await request("/workspaces", body, parent, headers)).status).toBe(201);
    expect((await request("/workspaces", body)).status).toBe(201);
    await pool.query("UPDATE cloud_v2_workspaces SET created_at=clock_timestamp()-interval '2 hours' WHERE org_id=$1", [org]);
    expect((await request("/workspaces", body, childToken)).status).toBe(201);
  });

  it("serializes different workspace tokens at the last shared creation slot", async () => {
    const second = await createWorkspace();
    for (let index = 0; index < 7; index++) await createWorkspace();
    const firstToken = (await workspaceCredential()).credential;
    const worker = await store.rotateWorkerToken(second.id);
    await store.acceptWorkerHello(worker, randomUUID());
    const secondToken = (await tokens.token(second.id))!;
    const responses = await Promise.all([firstToken, secondToken].map(token => request("/workspaces", { repository: "example/project" }, token)));
    expect(responses.map(response => response.status).sort()).toEqual([201, 429]);
    expect((await pool.query("SELECT 1 FROM cloud_v2_workspaces WHERE org_id=$1 AND creator_user_id=$2", [org, owner])).rowCount).toBe(10);
  });

  it("keeps a pending create pending through wake and unarchive without source admission", async () => {
    routes.asyncCreate = () => true;
    const created = await request("/workspaces", { repository: "example/project" });
    expect(created.status).toBe(201);
    const id = (await created.json()).workspace.id;
    expect((await store.get(id, owner)).sourcePending).toBe(true);
    vi.mocked(routes.authorizeSource!).mockRejectedValue(new HttpError(409, "cloud_source_pending", "This workspace is still being prepared"));
    for (const action of ["wake", "unarchive"])
      expect((await request(`/workspaces/${id}/${action}`, {})).status).toBe(200);
    expect(routes.authorizeSource).not.toHaveBeenCalled();
    expect((await store.get(id, owner)).state).toBe("creating");
  });

  it("lists key metadata by owner or admin and audits creation and revocation without material", async () => {
    const created = await credentials.create(org, member, "Member key");
    const path = `/v1/organizations/${org}/api-keys`;
    const own = await (await management(member).request(path)).json();
    expect(own.apiKeys.map((row: { id: string }) => row.id)).toEqual([created.apiKey.id]);
    const all = await (await management().request(path)).json();
    expect(all.apiKeys).toHaveLength(2); expect(JSON.stringify(all).includes(key)).toBe(false);
    expect((await management(member).request(`${path}/${keyId}`, { method: "DELETE" })).status).toBe(404);
    expect((await management().request(`${path}/${created.apiKey.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await request("/me", undefined, created.key)).status).toBe(401);
    const audit = await pool.query("SELECT action,subject FROM audit_log WHERE action LIKE 'cloud_api_key.%'");
    expect(audit.rows.map(row => row.action)).toContain("cloud_api_key.revoked");
    expect(JSON.stringify(audit.rows).includes(key)).toBe(false);
  });

  it("serializes concurrent key creation at the quota and exposes key material only on POST", async () => {
    const router = management(), path = `/v1/organizations/${org}/api-keys`;
    const responses = await Promise.all(Array.from({ length: 21 }, (_, index) => router.request(path, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Key ${index}` }) })));
    expect(responses.filter(response => response.status === 201)).toHaveLength(19);
    expect(responses.filter(response => response.status === 409)).toHaveLength(2);
    const first = await responses.find(response => response.status === 201)!.json();
    expect(typeof first.key).toBe("string"); expect(first.apiKey.prefix === first.key.slice(0, 7)).toBe(true);
    const listing = await (await router.request(path)).json();
    expect(listing.apiKeys).toHaveLength(20);
    expect(listing.apiKeys.every((entry: object) => !("key" in entry) && !("tokenHash" in entry))).toBe(true);
    expect(JSON.stringify(listing).includes(first.key)).toBe(false);
  });

  it("batches last-used timestamps outside requests and keeps a revoked key revoked after a flush", async () => {
    expect((await request("/me")).status).toBe(200);
    expect((await pool.query("SELECT last_used_at FROM cloud_api_keys WHERE id=$1", [keyId])).rows[0].last_used_at).toBeNull();
    await credentials.flushUsed();
    expect((await pool.query("SELECT last_used_at FROM cloud_api_keys WHERE id=$1", [keyId])).rows[0].last_used_at).toBeInstanceOf(Date);
    await credentials.revoke(org, owner, keyId); await credentials.flushUsed();
    expect((await request("/me")).status).toBe(401);
  });

  it("copies the organization-specific preference only onto subsequently created workspaces", async () => {
    const path = `/v1/cloud-v2/organizations/${org}/api-access`, router = management();
    expect(await (await router.request(path)).json()).toEqual({ workspaceApiAccess: true });
    const changed = await router.request(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceApiAccess: false }) });
    expect(changed.status).toBe(200);
    const later = await createWorkspace(), different = await createWorkspace(otherOrg);
    const opted = await pool.query("SELECT id,api_access FROM cloud_v2_workspaces ORDER BY id");
    const values = Object.fromEntries(opted.rows.map(row => [row.id, row.api_access]));
    expect(values).toEqual({ [workspace.id]: true, [later.id]: false, [different.id]: true });
    expect(await (await management(member).request(path)).json()).toEqual({ workspaceApiAccess: true });
  });

  it("persists restart through a worker nonresponse and starts only after the provider stop completes", async () => {
    const token = await workspaceCredential();
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture' WHERE id=$1", [workspace.id]);
    const response = await management().request(`/v1/cloud-v2/workspaces/${workspace.id}/restart`, { method: "POST" });
    expect(response.status).toBe(202);
    expect((await response.json()).workspace.state).toBe("stopping");
    expect((await request("/me", undefined, token.credential)).status).toBe(401);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), stopping = new Promise<void>(resolve => { entered = resolve; });
    const stop = vi.fn(async () => { entered(); await held; });
    const stopWorker = vi.fn(async () => false);
    const lifecycle = new CloudV2Lifecycle({ store, compute: { stop } as unknown as CloudV2Compute,
      stopWorker, sealPortToken: () => ({}), publicKeys: [], runtime: { sha256: "a".repeat(64), url: async () => "https://example.test/runtime" },
      bootEnv: () => ({}), sandboxName: () => "fixture" });
    const step = lifecycle.tick();
    try {
      await stopping;
      expect((await store.get(workspace.id, owner)).state).toBe("stopping");
    } finally { release(); await step; }
    expect(stop).toHaveBeenCalledOnce(); expect(stopWorker).toHaveBeenCalledOnce();
    expect((await store.get(workspace.id, owner)).state).toBe("starting");
    expect((await pool.query("SELECT restart_stop_generation FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].restart_stop_generation).toBeNull();
  });

  it("does not reuse a restart intent left behind by an N-1 stop completion on a later idle stop", async () => {
    await store.transition(workspace.id, ["creating"], "running", { boatSandboxId: "bx_fixture" });
    expect((await management().request(`/v1/cloud-v2/workspaces/${workspace.id}/restart`, { method: "POST" })).status).toBe(202);
    // The old replica never reads the new intent column, including on wake.
    await pool.query("UPDATE cloud_v2_workspaces SET state='stopped',worker_token_hash=NULL,worker_boot_id=NULL WHERE id=$1", [workspace.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET state='starting' WHERE id=$1", [workspace.id]);
    await pool.query("UPDATE cloud_v2_workspaces SET state='running',active_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [workspace.id]);
    await store.stopIdle(workspace.id, new Date());
    const stopGeneration = (await pool.query("SELECT stop_generation::text AS value FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].value;
    const completed = await store.transition(workspace.id, ["stopping"], "stopped", { stopGeneration, revoke: true });
    expect(completed?.state).toBe("stopped");
    expect((await pool.query("SELECT restart_stop_generation FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].restart_stop_generation).toBeNull();
  });

  it("never starts after a failed provider stop and clears the intent on terminal failure", async () => {
    await store.transition(workspace.id, ["creating"], "running", { boatSandboxId: "bx_fixture" });
    expect((await management().request(`/v1/cloud-v2/workspaces/${workspace.id}/restart`, { method: "POST" })).status).toBe(202);
    const stop = vi.fn(async () => { throw new Error("synthetic stop failure"); });
    const lifecycle = new CloudV2Lifecycle({ store, compute: { stop } as unknown as CloudV2Compute,
      sealPortToken: () => ({}), publicKeys: [], runtime: { sha256: "a".repeat(64), url: async () => "https://example.test/runtime" },
      bootEnv: () => ({}), sandboxName: () => "fixture" });
    await lifecycle.tick();
    expect((await store.get(workspace.id, owner)).state).toBe("stopping");
    await pool.query("UPDATE cloud_v2_workspaces SET attempts=100,next_attempt_at=NULL WHERE id=$1", [workspace.id]);
    await lifecycle.tick();
    expect((await store.get(workspace.id, owner)).state).toBe("failed");
    expect((await pool.query("SELECT restart_stop_generation FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].restart_stop_generation).toBeNull();
  });

  it.each(["stop", "archive", "failed", "deleting"] as const)("a later %s cancels the pending restart", async action => {
    await store.transition(workspace.id, ["creating"], "running", { boatSandboxId: "bx_fixture" });
    expect((await management().request(`/v1/cloud-v2/workspaces/${workspace.id}/restart`, { method: "POST" })).status).toBe(202);
    const stopGeneration = (await pool.query("SELECT stop_generation::text AS value FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].value;
    if (action === "stop" || action === "archive") await store.requestLifecycle(workspace.id, owner, action);
    else await store.transition(workspace.id, ["stopping"], action, { stopGeneration });
    const result = await store.transition(workspace.id, ["stopping"], "stopped", { stopGeneration, revoke: true });
    if (action === "stop" || action === "archive") expect(result?.state).toBe("stopped");
    else expect(result).toBeNull();
    expect((await pool.query("SELECT restart_stop_generation FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].restart_stop_generation).toBeNull();
  });

  describe("remote MCP", () => {
    it("connects with the MCP SDK and exposes exactly the v0 operations", async () => {
      const client = new Client({ name: "cloud-api-contract", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL("https://api.example.test/api/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${key}`, "x-real-ip": clientAddress } },
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.map(entry => entry.name).sort()).toEqual([
          "whoami", "list_models", "list_repositories", "list_workspaces", "create_workspace", "get_workspace", "get_workspace_status",
          "rename_workspace", "archive_workspace", "unarchive_workspace", "sleep_workspace", "wake_workspace", "list_workspace_sessions",
          "create_session", "get_session", "get_session_status", "cancel_session", "send_message", "list_messages", "get_message",
          "rename_session", "archive_session", "unarchive_session",
        ].sort());
        expect(listed.tools.every(entry => entry.inputSchema.additionalProperties === false)).toBe(true);
        const result = await client.callTool({ name: "whoami", arguments: {} });
        expect(result.structuredContent).toEqual(await (await request("/me")).json());
        expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(result.structuredContent);
        expect(transport.sessionId).toBeUndefined();
      } finally { await client.close(); }
    });

    it("shares workspace and session operations, idempotency and mirror objects with HTTP", async () => {
      const input = { repository: "example/project", agent: "codex", message: "First", sessionName: "Named", idempotencyKey: randomUUID() };
      const created = (await tool("create_workspace", input)).structuredContent;
      expect((await tool("create_workspace", input)).structuredContent).toEqual(created);
      const workspaceId = created.workspace.id, sessionId = created.session.id;
      expect((await tool("get_workspace", { workspaceId })).structuredContent).toEqual(await (await request(`/workspaces/${workspaceId}`)).json());
      expect((await tool("get_workspace_status", { workspaceId })).structuredContent.status).toBe("initializing");
      expect((await tool("list_workspaces", { limit: 100 })).structuredContent.data).toHaveLength(2);
      expect((await tool("list_workspace_sessions", { workspaceId, includeArchived: true })).structuredContent.data[0].name).toBe("Named");
      expect((await tool("get_session", { sessionId })).structuredContent).toEqual(await (await request(`/sessions/${sessionId}`)).json());
      expect((await tool("get_session_status", { sessionId })).structuredContent.status).toBe("working");
      const send = { sessionId, messageId: randomUUID(), message: "Next" };
      const sent = await tool("send_message", send);
      expect(sent.structuredContent).toEqual({ message: { id: send.messageId, createdBySessionId: null } });
      expect((await tool("send_message", send)).structuredContent).toEqual(sent.structuredContent);
      expect(await tool("send_message", { ...send, message: "Changed" })).toMatchObject({ isError: true, structuredContent: { error: { code: "prompt_conflict" } } });
      expect((await tool("cancel_session", { sessionId })).structuredContent.status).toBe("idle");
      const second = await tool("create_session", { workspaceId, agent: "claude", message: "Second", name: "Another" });
      expect(second.structuredContent.session.name).toBe("Another");
      expect((await tool("rename_workspace", { workspaceId, name: "Renamed" })).structuredContent.title).toBe("Renamed");
      await store.writeHistory(workspaceId, { messages: { chatId: sessionId, rows: [
        { msgId: "mcp-message", kind: "text", payload: JSON.stringify({ role: "assistant", text: "Done" }), createdAt: 123 },
      ] } });
      expect((await tool("list_messages", { sessionId })).structuredContent).toEqual(await (await request(`/sessions/${sessionId}/messages`)).json());
      expect((await tool("get_message", { sessionId, messageId: "mcp-message" })).structuredContent).toEqual(await (await request(`/sessions/${sessionId}/messages/mcp-message`)).json());
      await store.transition(workspaceId, ["creating"], "stopped");
      expect((await tool("archive_workspace", { workspaceId })).structuredContent.archived).toBe(true);
      expect((await tool("create_session", { workspaceId, agent: "codex", message: "Archived" })).structuredContent.error.code).toBe("workspace_archived");
      expect((await tool("unarchive_workspace", { workspaceId })).structuredContent.state).toBe("starting");
      expect((await tool("sleep_workspace", { workspaceId })).structuredContent.state).toBe("stopping");
      await store.transition(workspaceId, ["stopping"], "stopped");
      expect((await tool("wake_workspace", { workspaceId })).structuredContent.state).toBe("starting");
      expect((await tool("list_models")).structuredContent).toEqual(await (await request("/models")).json());
      await pool.query("UPDATE cloud_v2_computers SET active_build_id=NULL WHERE org_id=$1", [org]);
      expect((await tool("list_repositories")).structuredContent).toEqual({ data: [], offset: 0, hasMore: false });
    });

    it("keeps cross-organization and cross-creator objects private without waking on reads", async () => {
      await store.transition(workspace.id, ["creating"], "stopped");
      expect((await tool("get_workspace", { workspaceId: workspace.id })).structuredContent.state).toBe("stopped");
      expect((await store.get(workspace.id, owner)).state).toBe("stopped");
      for (const target of [await createWorkspace(otherOrg), await createWorkspace(org, member)]) {
        const sessionId = randomUUID();
        await store.writeHistory(target.id, { chats: [{ id: sessionId, agentId: "codex" } as never] });
        for (const [name, args] of [
          ["get_workspace", { workspaceId: target.id }], ["list_workspace_sessions", { workspaceId: target.id }],
          ["wake_workspace", { workspaceId: target.id }], ["get_session", { sessionId }],
          ["send_message", { sessionId, message: "Denied" }], ["list_messages", { sessionId }],
        ] as const) expect(await tool(name, args)).toMatchObject({ isError: true, structuredContent: { error: { code: "not_found" } } });
      }
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(0);
    });

    it("re-resolves credentials on every MCP request after revocation, stop and membership loss", async () => {
      const token = (await workspaceCredential()).credential;
      expect((await mcp("tools/list", {}, token)).status).toBe(200);
      await store.requestLifecycle(workspace.id, owner, "stop");
      expect((await mcp("tools/list", {}, token)).status).toBe(401);
      expect((await mcp("tools/list")).status).toBe(200);
      await credentials.revoke(org, owner, keyId);
      expect((await mcp("tools/list")).status).toBe(401);
      const next = await credentials.create(org, owner, "Next");
      await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, owner]);
      expect((await mcp("tools/list", {}, next.key)).status).toBe(401);
    });

    it("shares request and workspace-creation budgets with HTTP", async () => {
      for (let index = 0; index < 239; index++) expect((await request("/me")).status).toBe(200);
      expect((await mcp("tools/list")).status).toBe(200);
      const refused = await mcp("tools/list");
      expect(refused.status).toBe(429); expect(refused.headers.get("retry-after")).toBeTruthy();
      const fresh = await credentials.create(org, owner, "Creation budget"), idempotencyKey = randomUUID();
      for (let index = 0; index < 59; index++) expect((await request("/workspaces", { repository: "example/project" }, fresh.key,
        { "idempotency-key": idempotencyKey })).status).toBe(201);
      expect(await tool("create_workspace", { repository: "example/project", idempotencyKey }, fresh.key)).not.toHaveProperty("isError", true);
      const response = await mcp("tools/call", { name: "create_workspace", arguments: { repository: "example/project", idempotencyKey } }, fresh.key);
      expect(response.status).toBe(200); expect(response.headers.get("retry-after")).toBeTruthy();
      expect((await response.json()).result).toMatchObject({ isError: true, structuredContent: { error: { code: "rate_limited" } } });
    });

    it("shares failed-credential address limits before the HTTP and MCP lookup", async () => {
      const lookup = vi.spyOn(credentials, "resolve");
      for (let index = 0; index < 1199; index++) expect((await request("/me", undefined, "malformed")).status).toBe(401);
      expect((await mcp("tools/list", {}, "malformed")).status).toBe(401);
      const before = lookup.mock.calls.length;
      const blocked = await mcp("tools/list", {}, `zk_${randomBytes(32).toString("base64url")}`);
      expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(lookup).toHaveBeenCalledTimes(before);
    });

    it("bounds transport input, rejects foreign origins and batches, and keeps failures private", async () => {
      expect((await mcp("tools/list", {}, "malformed")).status).toBe(401);
      expect((await mcp("tools/list", {}, key, { origin: "https://foreign.example.test" })).status).toBe(403);
      expect((await mcp("tools/list", { padding: "x".repeat(8 * 1024 * 1024) })).status).toBe(413);
      const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream", "x-real-ip": clientAddress };
      const batch = await app.request("/api/mcp", { method: "POST", headers, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]) });
      expect(batch.status).toBe(400);
      expect((await app.request("/api/mcp", { headers })).status).toBe(405);
      expect((await mcp("tools/call", { name: "create_session", arguments: { workspaceId: workspace.id, agent: "codex" } })).status).toBe(200);
      const unknown = await tool("create_workspace", { repository: "example/project", unknown: true });
      expect(unknown.isError).toBe(true);
      vi.mocked(routes.authorizeBuildRepository!).mockRejectedValueOnce(new Error("synthetic private provider detail"));
      const error = await tool("create_workspace", { repository: "example/project" });
      expect(error).toMatchObject({ isError: true, structuredContent: { error: { code: "internal", message: "Internal error" } } });
      expect(JSON.stringify(error).includes("synthetic private provider detail")).toBe(false);
      expect((await pool.query("SELECT 1 FROM cloud_v2_prompt_outbox")).rowCount).toBe(0);
    });
  });

  it("starts stopped workspaces directly and refuses unavailable or foreign restarts", async () => {
    const router = management(), path = `/v1/cloud-v2/workspaces/${workspace.id}/restart`;
    expect((await router.request(path, { method: "POST" })).status).toBe(409);
    await store.transition(workspace.id, ["creating"], "stopped");
    expect((await management(member).request(path, { method: "POST" })).status).toBe(404);
    expect((await router.request(path, { method: "POST" })).status).toBe(202);
    expect((await store.get(workspace.id, owner)).state).toBe("starting");
    await store.transition(workspace.id, ["starting"], "deleting");
    expect((await router.request(path, { method: "POST" })).status).toBe(409);
  });
});

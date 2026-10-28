import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { McpStore } from "./store.js";
import { McpOAuth } from "./oauth.js";
import { createMcpPublicRoutes } from "./routes.js";
import { openMcpMaterial, sealMcpMaterial } from "./envelope.js";
import { CloudV2Store } from "../cloud/store.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const config = { name: "service", transport: "http" as const, url: "https://mcp.example.test/mcp", auth: "oauth" as const };
function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), waiting: new Promise<void>(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}

d("durable organization MCP OAuth", () => {
  let pool: pg.Pool, store: McpStore, oauth: McpOAuth, org: string, admin: string, member: string;
  let onToken: (body: URLSearchParams) => Promise<Response>;
  let onResource: (request: Request) => Promise<Response>, resourceMetadataUrl: string | undefined;
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const fetcher = vi.fn<FetchLike>(async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.hostname === "mcp.example.test" && ["/mcp", "/messages"].includes(url.pathname)) return onResource(request);
    if (resourceMetadataUrl && url.hostname === "mcp.example.test" && url.pathname.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
    if (url.href === resourceMetadataUrl) return Response.json({ resource: config.url, authorization_servers: ["https://auth.example.test"] });
    if (url.hostname === "mcp.example.test" && url.pathname.includes("oauth-protected-resource")) return Response.json({
      resource: config.url, authorization_servers: ["https://auth.example.test"], scopes_supported: ["tools"] });
    if (url.hostname === "auth.example.test" && url.pathname.includes(".well-known/")) return Response.json({
      issuer: "https://auth.example.test", authorization_endpoint: "https://auth.example.test/authorize",
      token_endpoint: "https://auth.example.test/token", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ["none"],
    });
    if (url.href === "https://auth.example.test/token") return onToken(new URLSearchParams(await request.text()));
    throw new Error("Unexpected fixture OAuth endpoint");
  });
  const write = (id: string, overrides: object = {}) => store.put(org, admin, id, {
    kind: "mcp", owner: "organization", repository: null, expectedRevision: null, config, ...overrides,
  });
  async function connect(id?: string) {
    const draft = { config, ...(id ? { extensionId: id, expectedRevision: 1 } : {}) };
    const attempt = await oauth.start(org, admin, draft);
    const url = new URL(attempt.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("https://api.example.test/.well-known/mcp-client.json");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    return { ...attempt, state: url.searchParams.get("state")! };
  }
  async function signedIn(expiresIn = 3600, refresh = true) {
    onToken = async () => Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: expiresIn,
      ...(refresh ? { refresh_token: "fixture-refresh" } : {}) });
    const id = randomUUID(); await write(id);
    const attempt = await connect(id); await oauth.callback(attempt.state, "fixture-code");
    return id;
  }
  function rotateServerKey() {
    store = new McpStore(pool, { currentKeyVersion: 2, keys: { ...keys.keys, 2: randomBytes(32).toString("base64url") } }, async () => ["org/repo"]);
    oauth = new McpOAuth(store, "https://api.example.test", fetcher);
  }
  async function authorizeDraft(organizationId: string, userId: string, raw: object, attemptId: string) {
    const draft = await store.draft(organizationId, userId, { ...raw, oauthAttemptId: attemptId });
    return oauth.draftAuthorization(organizationId, userId, attemptId, draft.binding);
  }
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 6, options: "-c lock_timeout=500" }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    [org, admin, member] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [admin, member]) await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal) VALUES($1,$2,'Fixture',$3,false)", [org, `org-${org}`, admin]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')", [org, admin, member]);
    store = new McpStore(pool, keys, async () => ["org/repo"]);
    oauth = new McpOAuth(store, "https://api.example.test", fetcher);
    fetcher.mockClear();
    resourceMetadataUrl = undefined;
    onResource = async () => new Response(null, { status: 401 });
    onToken = async body => {
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("resource")).toBe(config.url);
      return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
    };
  });

  it.each(["http", "sse-get", "sse-post"] as const)("uses resource-advertised metadata for %s and retains discovery through callback and refresh", async transport => {
    resourceMetadataUrl = "https://mcp.example.test/tenant/oauth-resource";
    let challenges = 0, streamClosed = false;
    onResource = async request => {
      if (transport === "sse-post" && request.method === "GET") return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // Injected fetch must model cancellation of a real response socket.
          request.signal.addEventListener("abort", () => { streamClosed = true; controller.error(new Error("Fixture stream closed")); }, { once: true });
          controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: /messages\n\n"));
        },
        cancel() { streamClosed = true; },
      }), { headers: { "Content-Type": "text/event-stream" } });
      expect(request.method).toBe(transport === "sse-get" ? "GET" : "POST");
      if (transport === "sse-post") expect(new URL(request.url).pathname).toBe("/messages");
      challenges++;
      return new Response(null, { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="tools:read"` } });
    };
    const serverConfig = { ...config, transport: transport === "http" ? "http" as const : "sse" as const };
    const id = randomUUID(); await write(id, { config: serverConfig });
    const attempt = await oauth.start(org, admin, { config: serverConfig, extensionId: id, expectedRevision: 1 });
    const authorization = new URL(attempt.authorizationUrl);
    expect(authorization.origin).toBe("https://auth.example.test");
    expect(authorization.searchParams.get("scope")).toBe("tools:read");
    expect(fetcher.mock.calls.some(([input, init]) => new Request(input, init).url === resourceMetadataUrl)).toBe(true);
    await oauth.callback(authorization.searchParams.get("state")!, "fixture-code");
    onToken = async body => {
      expect(body.get("grant_type")).toBe("refresh_token");
      return Response.json({ access_token: "fixture-renewed", token_type: "Bearer", expires_in: 3600 });
    };
    expect((await oauth.authorization(org, admin, id, true)).headers.Authorization).toBe("Bearer fixture-renewed");
    expect(challenges).toBe(1);
    if (transport === "sse-post") expect(streamClosed).toBe(true);
  });

  it("cancels resource discovery before fallback or registration can start", async () => {
    const controller = new AbortController(), held = gate();
    onResource = request => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("Fixture discovery cancelled")), { once: true });
      held.enter();
    });
    const starting = oauth.start(org, admin, { config }, controller.signal).then(() => true, () => false);
    await held.entered; controller.abort();
    expect(await starting).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT status,envelope FROM organization_mcp_oauth_attempts")).rows).toEqual([{ status: "failed", envelope: {} }]);
  });

  it("rejects a private advertised metadata URL before fetching it", async () => {
    onResource = async () => new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://127.0.0.1/private"' } });
    await expect(oauth.start(org, admin, { config })).rejects.toMatchObject({ code: "mcp_oauth_failed" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("terminates an unauthenticated HTTP session created while reading its challenge", async () => {
    let terminated = false;
    onResource = async request => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      if (request.method === "DELETE") {
        expect(request.headers.get("mcp-session-id")).toBe("fixture-session");
        terminated = true; return new Response(null, { status: 204 });
      }
      const body = await request.json() as { id?: number; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      expect(body.method).toBe("initialize");
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } },
        { headers: { "mcp-session-id": "fixture-session" } });
    };
    expect((await oauth.start(org, admin, { config })).authorizationUrl).toContain("https://auth.example.test/authorize");
    expect(terminated).toBe(true);
  });

  it.each(["", "fixture-code"])("makes a denied public callback terminal without exchanging code %j or exposing provider details", async code => {
    const attempt = await connect(), app = createMcpPublicRoutes(oauth);
    const token = vi.fn(onToken); onToken = token;
    const params = new URLSearchParams({ state: attempt.state, code, error: "access_denied", error_description: "private-provider-detail" });
    const response = await app.request(`/mcp/oauth/callback?${params}`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-provider-detail");
    expect(await oauth.status(org, admin, attempt.attemptId)).toEqual({ status: "failed" });
    expect((await pool.query("SELECT status,envelope FROM organization_mcp_oauth_attempts WHERE id=$1", [attempt.attemptId])).rows)
      .toEqual([{ status: "failed", envelope: {} }]);
    const replay = await app.request(`/mcp/oauth/callback?${new URLSearchParams({ state: attempt.state, code: "fixture-code" })}`);
    expect(replay.status).toBe(400);
    expect(token).not.toHaveBeenCalled();
    expect((await pool.query("SELECT * FROM organization_mcp_oauth")).rowCount).toBe(0);
  });

  it("does not let a late denial replace a claimed exchange or a connected attempt", async () => {
    const id = randomUUID(); await write(id); const attempt = await connect(id), held = gate(), app = createMcpPublicRoutes(oauth);
    onToken = async () => { held.enter(); await held.waiting; return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 3600 }); };
    const callback = oauth.callback(attempt.state, "fixture-code");
    await held.entered;
    const denied = () => app.request(`/mcp/oauth/callback?${new URLSearchParams({ state: attempt.state, error: "access_denied" })}`);
    try {
      expect((await denied()).status).toBe(400);
      expect(await oauth.status(org, admin, attempt.attemptId)).toEqual({ status: "pending" });
    } finally { held.release(); }
    await callback;
    expect((await denied()).status).toBe(400);
    expect(await oauth.status(org, admin, attempt.attemptId)).toEqual({ status: "connected" });
    expect((await oauth.authorization(org, admin, id)).headers.Authorization).toBe("Bearer fixture-access");
  });

  it.each(["unknown", "expired", "cancelled"])("does not mutate a live attempt for a %s denied state", async state => {
    const attempt = await connect(), app = createMcpPublicRoutes(oauth), token = vi.fn(onToken); onToken = token;
    if (state === "expired") await pool.query("UPDATE organization_mcp_oauth_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attempt.attemptId]);
    if (state === "cancelled") await oauth.cancel(org, admin, attempt.attemptId);
    const before = (await pool.query("SELECT * FROM organization_mcp_oauth_attempts")).rows;
    const params = new URLSearchParams({ state: state === "unknown" ? randomBytes(32).toString("base64url") : attempt.state, error: "access_denied" });
    expect((await app.request(`/mcp/oauth/callback?${params}`)).status).toBe(400);
    expect((await pool.query("SELECT * FROM organization_mcp_oauth_attempts")).rows).toEqual(before);
    expect(token).not.toHaveBeenCalled();
  });

  it("attaches an unsaved real SDK flow atomically and keeps shared-server sign-in personal across edits", async () => {
    const attempt = await connect();
    expect((await pool.query("SELECT * FROM organization_extensions")).rowCount).toBe(0);
    await oauth.callback(attempt.state, "fixture-code");
    expect(await oauth.status(org, admin, attempt.attemptId)).toEqual({ status: "connected" });
    const draft = await store.draft(org, admin, { config, oauthAttemptId: attempt.attemptId });
    expect((await oauth.draftAuthorization(org, admin, attempt.attemptId, draft.binding)).headers.Authorization).toBe("Bearer fixture-access");
    await expect(oauth.draftAuthorization(org, member, attempt.attemptId, draft.binding)).rejects.toMatchObject({ code: "mcp_auth_required" });
    await expect(oauth.draftAuthorization(org, admin, attempt.attemptId, "wrong-binding")).rejects.toMatchObject({ code: "mcp_auth_required" });
    const id = randomUUID(), saved = await write(id, { oauthAttemptId: attempt.attemptId });
    expect(saved.oauth.status).toBe("connected");
    expect((await store.list(org, member))[0]?.oauth.status).toBe("needs-auth");
    await expect(oauth.authorization(org, member, id)).rejects.toMatchObject({ code: "mcp_auth_required" });
    expect((await oauth.authorization(org, admin, id)).headers).toEqual({ Authorization: "Bearer fixture-access" });
    const edited = await write(id, { expectedRevision: 1, config: { ...config, name: "renamed" } });
    expect(edited.oauth.status).toBe("connected");
    const persisted = await pool.query("SELECT * FROM organization_mcp_oauth");
    expect(JSON.stringify(persisted.rows)).not.toContain("fixture-access");
    expect(JSON.stringify(await store.list(org, admin))).not.toContain("fixture-refresh");
    await expect(write(randomUUID(), { config: { ...config, name: "other" }, oauthAttemptId: attempt.attemptId })).rejects.toMatchObject({ code: "mcp_oauth_failed" });
  });

  it("gives independent identical sign-ins fresh opaque markers and retains each through probe and save", async () => {
    const attempts = [await connect(), await connect()];
    for (const attempt of attempts) await oauth.callback(attempt.state, "fixture-code");
    const bindings: string[] = [];
    for (const [index, attempt] of attempts.entries()) {
      const binding = (await pool.query<{ binding: string }>("SELECT binding FROM organization_mcp_oauth_attempts WHERE id=$1", [attempt.attemptId])).rows[0]!.binding;
      expect(binding).toMatch(/^[a-f0-9]{64}$/);
      bindings.push(binding);
      const draft = await store.draft(org, admin, { config, oauthAttemptId: attempt.attemptId });
      expect(draft.binding).toBe(binding);
      expect((await oauth.draftAuthorization(org, admin, attempt.attemptId, draft.binding)).headers.Authorization).toBe("Bearer fixture-access");
      const id = randomUUID();
      expect((await write(id, { config: { ...config, name: `independent-${index}` }, oauthAttemptId: attempt.attemptId })).oauth.status).toBe("connected");
      expect((await store.get(org, admin, id)).oauth_binding).toBe(binding);
    }
    expect(new Set(bindings).size).toBe(2);
  });

  it.each(["current", "legacy", "hmac"])("preserves personal grants and unchanged member admission for a %s binding across server-key rotation", async format => {
    const id = await signedIn();
    const memberAttempt = await oauth.start(org, member, { config, extensionId: id, expectedRevision: 1 });
    await oauth.callback(new URL(memberAttempt.authorizationUrl).searchParams.get("state")!, "fixture-code");
    if (format !== "current") {
      const binding = (format === "legacy" ? "ab" : "cd").repeat(32);
      await pool.query("UPDATE organization_extensions SET oauth_binding=$2 WHERE id=$1", [id, binding]);
      await pool.query("UPDATE organization_mcp_oauth SET binding=$2 WHERE extension_id=$1", [id, binding]);
    }
    const previous = await store.get(org, admin, id);
    rotateServerKey();
    expect((await store.draft(org, member, { config, extensionId: id, expectedRevision: 1 })).binding).toBe(previous.oauth_binding);
    const reconnect = await oauth.start(org, member, { config, extensionId: id, expectedRevision: 1 });
    await oauth.callback(new URL(reconnect.authorizationUrl).searchParams.get("state")!, "fixture-code");
    expect((await write(id, { expectedRevision: 1, config: { ...config, name: "renamed", disabled_tools: ["hidden"] } })).oauth.status).toBe("connected");
    expect((await store.get(org, admin, id)).oauth_binding).toBe(previous.oauth_binding);
    expect((await store.list(org, member))[0]?.oauth.status).toBe("connected");
    expect((await oauth.authorizationForRepository(org, member, "org/repo", id)).headers.Authorization).toBe("Bearer fixture-access");
    onToken = async body => {
      expect(body.get("grant_type")).toBe("refresh_token");
      return Response.json({ access_token: "fixture-renewed", refresh_token: "fixture-renewed-refresh", token_type: "Bearer", expires_in: 3600 });
    };
    expect((await oauth.authorizationForRepository(org, admin, "org/repo", id, true, { repositoryId: "42" })).headers.Authorization).toBe("Bearer fixture-renewed");
    expect((await pool.query("SELECT binding,envelope->>'keyVersion' AS key_version FROM organization_mcp_oauth WHERE extension_id=$1", [id])).rows)
      .toEqual(expect.arrayContaining([{ binding: previous.oauth_binding, key_version: "2" }]));
  });

  it("binds scoped OAuth release and refresh notifications to the original repository after transfer", async () => {
    const catalog = [{ repository: "org/repo", repositoryId: "42" }];
    store = new McpStore(pool, keys, async () => catalog);
    oauth = new McpOAuth(store, "https://api.example.test", fetcher);
    const id = randomUUID();
    await write(id, { repository: "org/repo" });
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=true WHERE id=$1", [org]);
    const workspaces = new CloudV2Store(pool);
    const original = await workspaces.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin,
      name: "original", repository: "org/repo", sourceRepositoryId: "42", branch: "work", baseBranch: "main", computerBuildId: null });
    const replacement = await workspaces.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: admin,
      name: "replacement", repository: "org/repo", sourceRepositoryId: "99", branch: "work", baseBranch: "main", computerBuildId: null });
    const attempt = await connect(id);
    await oauth.callback(attempt.state, "fixture-code");
    expect(await workspaces.loginRevision(original.id)).toBe("1");
    expect(await workspaces.loginRevision(replacement.id)).toBe("0");
    catalog.splice(0, catalog.length, { repository: "org/repo", repositoryId: "99" },
      { repository: "current/project", repositoryId: "42" });
    await expect(oauth.authorizationForRepository(org, admin, "org/repo", id, false, { repositoryId: "99" }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(oauth.authorizationForRepository(org, admin, "org/repo", id)).rejects.toMatchObject({ code: "not_found" });
    expect((await oauth.authorizationForRepository(org, admin, "current/project", id, false, { repositoryId: "42" })).headers.Authorization)
      .toBe("Bearer fixture-access");
    const renamed = await write(id, { repository: "current/project", expectedRevision: 1 });
    expect(renamed.oauth.status).toBe("connected");
    expect((await oauth.authorizationForRepository(org, admin, "current/project", id)).headers.Authorization).toBe("Bearer fixture-access");
    expect(await workspaces.loginRevision(original.id)).toBe("2");
    expect(await workspaces.loginRevision(replacement.id)).toBe("0");
  });

  it.each(["pending", "connected", "legacy"])("retains a %s unsaved attempt's identity through rotation, probe and atomic save", async phase => {
    const attempt = await connect();
    if (phase !== "pending") await oauth.callback(attempt.state, "fixture-code");
    if (phase === "legacy") await pool.query("UPDATE organization_mcp_oauth_attempts SET binding=$2 WHERE id=$1", [attempt.attemptId, "cd".repeat(32)]);
    const previous = (await pool.query<{ binding: string }>("SELECT binding FROM organization_mcp_oauth_attempts WHERE id=$1", [attempt.attemptId])).rows[0]!.binding;
    rotateServerKey();
    if (phase === "pending") await oauth.callback(attempt.state, "fixture-code");
    expect((await store.draft(org, admin, { config })).binding).not.toBe(previous);
    const draft = await store.draft(org, admin, { config, oauthAttemptId: attempt.attemptId });
    expect(draft.binding).toBe(previous);
    expect((await oauth.draftAuthorization(org, admin, attempt.attemptId, draft.binding)).headers.Authorization).toBe("Bearer fixture-access");
    const id = randomUUID();
    expect((await write(id, { oauthAttemptId: attempt.attemptId })).oauth.status).toBe("connected");
    expect((await store.get(org, admin, id)).oauth_binding).toBe(previous);
    expect((await oauth.authorization(org, admin, id)).headers.Authorization).toBe("Bearer fixture-access");
    expect((await pool.query("SELECT status,envelope FROM organization_mcp_oauth_attempts WHERE id=$1", [attempt.attemptId])).rows).toEqual([{ status: "used", envelope: {} }]);
  });

  it("retains a re-encrypted historical attempt marker after retiring its original envelope key", async () => {
    const attempt = await connect(), historical = "ef".repeat(32);
    await pool.query("UPDATE organization_mcp_oauth_attempts SET binding=$2 WHERE id=$1", [attempt.attemptId, historical]);
    rotateServerKey();
    await oauth.callback(attempt.state, "fixture-code");
    expect((await pool.query("SELECT envelope->>'keyVersion' AS key_version FROM organization_mcp_oauth_attempts WHERE id=$1", [attempt.attemptId])).rows)
      .toEqual([{ key_version: "2" }]);
    store = new McpStore(pool, { currentKeyVersion: 2, keys: { 2: store.keys.keys[2]! } }, async () => ["org/repo"]);
    oauth = new McpOAuth(store, "https://api.example.test", fetcher);
    const draft = await store.draft(org, admin, { config, oauthAttemptId: attempt.attemptId });
    expect(draft.binding).toBe(historical);
    expect((await oauth.draftAuthorization(org, admin, attempt.attemptId, draft.binding)).headers.Authorization).toBe("Bearer fixture-access");
    const id = randomUUID();
    expect((await write(id, { oauthAttemptId: attempt.attemptId })).oauth.status).toBe("connected");
    expect((await store.get(org, admin, id)).oauth_binding).toBe(historical);
  });

  it.each(["owner", "repository"])("invalidates all personal grants on %s changes despite retaining the unchanged identity marker", async scope => {
    const id = await signedIn(), previous = await store.get(org, admin, id);
    const memberAttempt = await oauth.start(org, member, { config, extensionId: id, expectedRevision: 1 });
    await oauth.callback(new URL(memberAttempt.authorizationUrl).searchParams.get("state")!, "fixture-code");
    const saved = await write(id, { expectedRevision: 1, ...(scope === "owner" ? { owner: "user" } : { repository: "org/repo" }) });
    expect((await store.get(org, admin, id)).oauth_binding).toBe(previous.oauth_binding);
    expect(saved.oauth.status).toBe("needs-auth");
    expect((await pool.query("SELECT * FROM organization_mcp_oauth WHERE extension_id=$1", [id])).rowCount).toBe(0);
    await expect(oauth.authorizationForRepository(org, admin, "org/repo", id)).rejects.toMatchObject({ code: "mcp_auth_required" });
  });

  it.each([false, true])("atomically reconciles a fresh same-identity attempt with server-key rotation %s without replacing another member's retained binding", async rotated => {
    const id = await signedIn(), previous = await store.get(org, admin, id);
    const memberAttempt = await oauth.start(org, member, { config, extensionId: id, expectedRevision: 1 });
    await oauth.callback(new URL(memberAttempt.authorizationUrl).searchParams.get("state")!, "fixture-code");
    if (rotated) rotateServerKey();
    const fresh = await connect(); await oauth.callback(fresh.state, "fixture-code");
    const freshBinding = (await pool.query<{ binding: string }>("SELECT binding FROM organization_mcp_oauth_attempts WHERE id=$1", [fresh.attemptId])).rows[0]!.binding;
    expect(freshBinding).not.toBe(previous.oauth_binding);
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM organization_mcp_oauth_attempts WHERE id=$1 FOR UPDATE", [fresh.attemptId]);
      expect((await authorizeDraft(org, admin, { config, extensionId: id, expectedRevision: 1 }, fresh.attemptId)).headers.Authorization).toBe("Bearer fixture-access");
    } finally { await locker.query("ROLLBACK"); locker.release(); }
    expect((await pool.query("SELECT binding FROM organization_mcp_oauth_attempts WHERE id=$1", [fresh.attemptId])).rows).toEqual([{ binding: freshBinding }]);
    const envelope = (await pool.query("SELECT envelope FROM organization_mcp_oauth_attempts WHERE id=$1", [fresh.attemptId])).rows[0]!.envelope;
    const associated = { organizationId: org, ownerUserId: admin, id: fresh.attemptId, revision: 1, purpose: "attempt" as const };
    const material = openMcpMaterial(envelope, associated, store.keys) as { material: { tokens: { token_type: string } } };
    material.material.tokens.token_type = "unsupported-fixture-type";
    const refusedEnvelope = sealMcpMaterial(material, associated, store.keys);
    await pool.query("UPDATE organization_mcp_oauth_attempts SET envelope=$2 WHERE id=$1", [fresh.attemptId, refusedEnvelope]);
    const grants = (await pool.query("SELECT * FROM organization_mcp_oauth WHERE extension_id=$1 ORDER BY owner_user_id", [id])).rows;
    await expect(write(id, { expectedRevision: 1, oauthAttemptId: fresh.attemptId })).rejects.toMatchObject({ code: "mcp_oauth_failed" });
    expect(await store.get(org, admin, id)).toEqual(previous);
    expect((await pool.query("SELECT * FROM organization_mcp_oauth WHERE extension_id=$1 ORDER BY owner_user_id", [id])).rows).toEqual(grants);
    expect((await pool.query("SELECT status,binding,envelope FROM organization_mcp_oauth_attempts WHERE id=$1", [fresh.attemptId])).rows)
      .toEqual([{ status: "connected", binding: freshBinding, envelope: refusedEnvelope }]);
    await pool.query("UPDATE organization_mcp_oauth_attempts SET envelope=$2 WHERE id=$1", [fresh.attemptId, envelope]);
    expect((await write(id, { expectedRevision: 1, oauthAttemptId: fresh.attemptId })).oauth.status).toBe("connected");
    expect((await store.get(org, admin, id)).oauth_binding).toBe(previous.oauth_binding);
    expect((await store.list(org, member))[0]?.oauth.status).toBe("connected");
    expect((await oauth.authorization(org, member, id)).headers.Authorization).toBe("Bearer fixture-access");
    expect((await pool.query("SELECT status,binding FROM organization_mcp_oauth_attempts WHERE id=$1", [fresh.attemptId])).rows)
      .toEqual([{ status: "used", binding: previous.oauth_binding }]);
  });

  it.each(["actor", "organization", "extension", "revision", "expired", "cancelled", "used"].flatMap(boundary => [false, true].map(rotated => [boundary, rotated] as const)))(
  "refuses a wrong or retired %s attempt with server-key rotation %s", async (boundary, rotated) => {
    let targetId = randomUUID(), expectedRevision: number | null = null;
    if (boundary === "extension" || boundary === "revision") {
      await write(targetId); expectedRevision = 1;
    }
    const attempt = await connect(expectedRevision ? targetId : undefined);
    await oauth.callback(attempt.state, "fixture-code");
    if (boundary === "expired") await pool.query("UPDATE organization_mcp_oauth_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attempt.attemptId]);
    if (boundary === "cancelled") await oauth.cancel(org, admin, attempt.attemptId);
    if (boundary === "used") await write(randomUUID(), { oauthAttemptId: attempt.attemptId });
    if (boundary === "extension") { targetId = randomUUID(); await write(targetId, { config: { ...config, name: "target" } }); }
    if (boundary === "revision") { await write(targetId, { expectedRevision: 1, config: { ...config, name: "target" } }); expectedRevision = 2; }
    let targetOrg = org;
    if (boundary === "organization") {
      targetOrg = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal) VALUES($1,$2,'Fixture',$3,false)", [targetOrg, `org-${targetOrg}`, admin]);
      await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [targetOrg, admin]);
    }
    const actor = boundary === "actor" ? member : admin;
    if (rotated) rotateServerKey();
    const targetConfig = { ...config, name: "target" };
    const draft = { config: targetConfig, ...(expectedRevision ? { extensionId: targetId, expectedRevision } : {}) };
    await expect(authorizeDraft(targetOrg, actor, draft, attempt.attemptId)).rejects.toMatchObject({ code: "mcp_auth_required" });
    const before = (await pool.query("SELECT id,revision,oauth_binding FROM organization_extensions ORDER BY id")).rows;
    await expect(store.put(targetOrg, actor, targetId, { kind: "mcp", owner: "user", repository: null, expectedRevision, config: targetConfig, oauthAttemptId: attempt.attemptId }))
      .rejects.toMatchObject({ code: "mcp_oauth_failed" });
    expect((await pool.query("SELECT id,revision,oauth_binding FROM organization_extensions ORDER BY id")).rows).toEqual(before);
  });

  it("never lets an actor-owned connected attempt authorize a changed shared definition", async () => {
    const id = randomUUID(); await write(id);
    const changed = { ...config, oauth_scopes: ["tools:write"] };
    const attempt = await oauth.start(org, member, { config: changed });
    await oauth.callback(new URL(attempt.authorizationUrl).searchParams.get("state")!, "fixture-code");
    rotateServerKey();
    await expect(store.draft(org, member, { config: changed, extensionId: id, expectedRevision: 1, oauthAttemptId: attempt.attemptId })).rejects.toMatchObject({ status: 403 });
    await expect(store.put(org, member, id, { kind: "mcp", owner: "organization", repository: null, expectedRevision: 1, config: changed, oauthAttemptId: attempt.attemptId })).rejects.toMatchObject({ status: 403 });
    await expect(authorizeDraft(org, member, { config }, attempt.attemptId)).rejects.toMatchObject({ code: "mcp_auth_required" });
    await expect(store.put(org, member, randomUUID(), { kind: "mcp", owner: "user", repository: null, expectedRevision: null, config, oauthAttemptId: attempt.attemptId }))
      .rejects.toMatchObject({ code: "mcp_oauth_failed" });
    expect((await store.get(org, admin, id)).revision).toBe(1);
    expect(await oauth.status(org, member, attempt.attemptId)).toEqual({ status: "connected" });
  });

  it("marks an expired access-only grant as needing connection", async () => {
    const id = await signedIn(0, false);
    expect((await store.list(org, admin))[0]?.oauth.status).toBe("needs-auth");
    await expect(oauth.authorization(org, admin, id)).rejects.toMatchObject({ code: "mcp_auth_required" });
  });

  it("binds uppercase request UUIDs to the canonical saved OAuth identity", async () => {
    const id = randomUUID(); await write(id);
    const attempt = await oauth.start(org.toUpperCase(), admin, { config, extensionId: id.toUpperCase(), expectedRevision: 1 });
    await oauth.callback(new URL(attempt.authorizationUrl).searchParams.get("state")!, "fixture-code");
    expect((await oauth.authorizationForRepository(org.toUpperCase(), admin, "org/repo", id.toUpperCase())).headers.Authorization).toBe("Bearer fixture-access");
    expect((await authorizeDraft(org.toUpperCase(), admin.toUpperCase(), { config, extensionId: id.toUpperCase(), expectedRevision: 1 }, attempt.attemptId.toUpperCase()))
      .headers.Authorization).toBe("Bearer fixture-access");
  });

  it.each(["cancel", "edit", "remove", "membership", "expire"])("fences %s while the provider exchanges a code", async change => {
    const id = randomUUID(); await write(id); const attempt = await connect(id), held = gate();
    onToken = async () => { held.enter(); await held.waiting; return Response.json({ access_token: "late-fixture", token_type: "Bearer", expires_in: 3600 }); };
    const callback = oauth.callback(attempt.state, "fixture-code").then(() => true, () => false);
    await held.entered;
    try {
      if (change === "cancel") await oauth.cancel(org, admin, attempt.attemptId);
      if (change === "edit") await write(id, { expectedRevision: 1, config: { ...config, name: "edited" } });
      if (change === "remove") await store.remove(org, admin, id, 1);
      if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, admin]);
      if (change === "expire") await pool.query("UPDATE organization_mcp_oauth_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [attempt.attemptId]);
    } finally { held.release(); }
    expect(await callback).toBe(false);
    expect((await pool.query("SELECT * FROM organization_mcp_oauth")).rowCount).toBe(0);
  });

  it("uses one refresh across callers, refuses a competing replica, and performs cached reads without mutation locks", async () => {
    const id = await signedIn(0), held = gate(), refresh = vi.fn(async (body: URLSearchParams) => {
      expect(body.get("grant_type")).toBe("refresh_token"); held.enter(); await held.waiting;
      return Response.json({ access_token: "rotated-fixture", refresh_token: "new-fixture", token_type: "Bearer", expires_in: 3600 });
    });
    onToken = refresh;
    const first = oauth.authorization(org, admin, id);
    await held.entered;
    const second = oauth.authorization(org, admin, id);
    const otherReplica = new McpOAuth(store, "https://api.example.test", fetcher);
    try { await expect(otherReplica.authorization(org, admin, id)).rejects.toMatchObject({ code: "mcp_auth_busy" }); }
    finally { held.release(); }
    expect(await first).toEqual(await second); expect(refresh).toHaveBeenCalledOnce();
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN"); await locker.query("SELECT 1 FROM organization_mcp_oauth WHERE extension_id=$1 FOR UPDATE", [id]);
      await expect(oauth.authorization(org, admin, id)).resolves.toMatchObject({ headers: { Authorization: "Bearer rotated-fixture" } });
    } finally { await locker.query("ROLLBACK"); locker.release(); }
  });

  it.each(["membership", "edit", "ambiguous"])("never delivers or replays a refresh after %s", async change => {
    const id = await signedIn(0), held = gate(), refresh = vi.fn(async () => {
      held.enter(); await held.waiting;
      if (change === "ambiguous") throw new Error("fixture network outcome unknown");
      return Response.json({ access_token: "must-not-deliver", refresh_token: "new-fixture", token_type: "Bearer", expires_in: 3600 });
    });
    onToken = refresh;
    const authorization = oauth.authorization(org, admin, id).then(() => true, () => false);
    await held.entered;
    try {
      if (change === "membership") await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, admin]);
      if (change === "edit") await write(id, { expectedRevision: 1, config: { ...config, url: "https://other.example.test/mcp" } });
    } finally { held.release(); }
    expect(await authorization).toBe(false);
    await expect(oauth.authorization(org, admin, id)).rejects.toBeDefined();
    expect(refresh).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT * FROM organization_mcp_oauth")).rowCount).toBe(0);
  });

  it("rechecks exact repository selection after a personal override arrives during refresh", async () => {
    const id = await signedIn(0), held = gate();
    onToken = async () => { held.enter(); await held.waiting; return Response.json({ access_token: "old-selection", token_type: "Bearer", expires_in: 3600 }); };
    const authorization = oauth.authorizationForRepository(org, admin, "org/repo", id).then(() => true, () => false);
    await held.entered;
    try {
      await store.put(org, admin, randomUUID(), { kind: "mcp", owner: "user", repository: "org/repo", expectedRevision: null,
        config: { ...config, auth: "none" } });
    } finally { held.release(); }
    expect(await authorization).toBe(false);
  });
});

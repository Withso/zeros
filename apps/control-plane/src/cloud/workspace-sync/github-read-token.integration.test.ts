import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, GithubBackendConfig } from "../../config.js";
import { HttpError } from "../../authz.js";
import { createCloudV2 } from "../composition.js";
import { createCloudV2Routes } from "../routes.js";
import { localCommandsFixture } from "../local-commands/test-fixture.js";

const github = {
  appId: 5, clientId: "fixture-client", apiBaseUrl: "https://api.github.com", variantKey: "github.com",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
} as GithubBackendConfig;
const optIn = { "x-zeros-sync": "1", "x-zeros-sync-wanted": "1" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(pool: pg.Pool) {
  const f = await localCommandsFixture(pool), signing = generateKeyPairSync("ed25519");
  const keys = { currentKeyVersion: 1, keys: { 1: Buffer.alloc(32, 7).toString("base64url") } };
  const issued: Array<{ repository_ids: number[]; permissions: Record<string, string> }> = [], revoked: string[] = [];
  let denyB = false;
  const expiry = Date.now() + 3_600_000;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com") throw new Error("Unexpected provider");
    const personB = new Headers(init?.headers).get("authorization") === "Bearer fixture-person-b";
    if (personB && denyB) return Response.json({ message: "private-provider-diagnostic" }, { status: 403 });
    if (url.pathname === "/user") return Response.json({ id: personB ? 13 : 12, login: personB ? "member-b" : "member-a" });
    if (url.pathname === "/repositories/42") return Response.json({ id: 42, name: "project", owner: { login: "example" },
      default_branch: "main", private: true, archived: false, permissions: { pull: true, push: true } });
    if (url.pathname.endsWith("/branches")) return Response.json([]);
    if (url.pathname === "/user/installations") return Response.json({ installations: [
      { id: 7, app_id: 5, account: { login: "example" }, suspended_at: null },
    ] });
    if (url.pathname === "/repos/example/project") return Response.json({ id: 42, full_name: "example/project" });
    if (url.pathname.endsWith("/permission")) {
      const memberB = url.pathname.includes("/member-b/");
      return Response.json({ permission: memberB && denyB ? "none" : "write", user: { id: memberB ? 13 : 12, login: memberB ? "member-b" : "member-a" } });
    }
    if (url.pathname.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body)); issued.push(body);
      return Response.json({ token: `fixture-installation-${issued.length}`, permissions: body.permissions,
        expires_at: new Date(expiry).toISOString() }, { status: 201 });
    }
    if (url.pathname === "/installation/token") {
      revoked.push(new Headers(init?.headers).get("authorization")!);
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected GitHub fixture request");
  });
  vi.stubGlobal("fetch", fetcher);
  const config = { github, deploymentChannel: "development", inviteLinkBase: "https://app.example.test/invite",
    cloudAgentCredentials: { settingsSecretKeyV1: keys.keys[1] },
    cloudV2: { boat: { apiKey: "synthetic-boat-credential" }, apiUrl: "https://api.example.test", realtimeUrl: "https://rt.example.test", promptOutbox: true,
      workerSigningKey: signing.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } },
  } as Config;
  const cp = createCloudV2(config, pool, { relay: false, lifecycle: false })!;
  const connections = cp.routes.githubConnections!;
  for (const [user, id, label] of [[f.owner, "12", "a"], [f.other, "13", "b"]] as const) {
    const scope = { organizationId: f.organizationId, userId: user.id };
    await connections.store.save(scope, await connections.store.fingerprint(scope), { id, login: `member-${label}` },
      { method: "github-app", accessToken: `fixture-person-${label}`, refreshToken: `fixture-refresh-${label}`,
        expiresAt: expiry, refreshExpiresAt: Date.now() + 86_400_000 });
  }
  await pool.query("INSERT INTO cloud_v2_github_sources(workspace_id,source_repository,repository_id) VALUES($1,'example/project',42)", [f.workspaceId]);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("user", c.req.header("x-test-actor") === f.other.id ? f.other : f.owner); await next(); });
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: { code: error.code } }, error.status);
    throw error;
  });
  app.route("/", createCloudV2Routes(cp.routes));
  const call = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => app.request(path, {
    method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const path = `/v1/cloud-v2/workspaces/${f.workspaceId}`, tokenPath = `${path}/github-read-token`;
  const connected = async (user = f.owner) => {
    const mac = await f.register(randomUUID(), user), headers = { ...mac.headers, ...optIn };
    expect((await call(`${path}/macs/${mac.device.deviceId}/connect`, "POST", {}, headers)).status).toBe(200);
    expect((await call(`${path}/macs/${mac.device.deviceId}/sync`, "PUT", { wanted: true }, headers)).status).toBe(200);
    return { ...mac, headers };
  };
  const active = () => pool.query("UPDATE cloud_v2_workspaces SET execution_mode='active' WHERE id=$1", [f.workspaceId]);
  const issue = (headers: Record<string, string>, body: unknown = {}) => call(tokenPath, "POST", body, headers);
  const close = async () => {
    cp.runtimeUpdates.close(); await cp.api.credentials.close(); await cp.loginChanges.stop();
    await cp.promptChanges?.stop(); await cp.localCommandSignals.close(); await f.signals.close(); await cp.stopLiveRecovery();
  };
  await cp.loginChanges.start();
  return { ...f, cp, call, path, tokenPath, connected, active, issue, close, fetcher, issued, revoked, expiry, denyB: () => { denyB = true; } };
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("passive GitHub read tokens through the production router and PostgreSQL", () => {
  let pool: pg.Pool, f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, statement_timeout: 5000 }); });
  beforeEach(async () => { f = await fixture(pool); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const clocks = () => pool.query("SELECT state,updated_at,active_at,stop_generation,access_epoch,login_revision,worker_token_hash FROM cloud_v2_workspaces WHERE id=$1", [f.workspaceId]).then(result => result.rows[0]);

  it.each([false, true])("mints only contents-read while stopped without VM, activity or lease effects (active=%s)", async active => {
    if (active) await f.active();
    const mac = await f.connected(), before = await clocks();
    const response = await f.issue(mac.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ token: "fixture-installation-2", expiresAt: new Date(f.expiry).toISOString(), repository: "example/project" });
    expect(f.issued).toEqual([
      { repository_ids: [42], permissions: { metadata: "read" } },
      { repository_ids: [42], permissions: { metadata: "read", contents: "read" } },
    ]);
    expect(await clocks()).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM cloud_v2_execution_contexts WHERE workspace_id=$1", [f.workspaceId])).rows[0].n).toBe(0);
  });

  it("uses B's own repository authority and never falls back to the Creator", async () => {
    await f.active();
    const a = await f.connected(), b = await f.connected(f.other);
    f.fetcher.mockClear();
    expect((await f.issue(b.headers)).status).toBe(200);
    const personal = f.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/user");
    expect(personal.length).toBeGreaterThan(0);
    expect(personal.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer fixture-person-b")).toBe(true);
    f.denyB();
    const denied = await f.issue(b.headers);
    expect(denied.status).toBe(403); expect((await denied.json()).error.code).toBe("github_access_required");
    expect((await f.issue(a.headers)).status).toBe(200);
  });

  it.each(["x-zeros-sync", "x-zeros-sync-wanted"])("requires the exact %s opt-in", async header => {
    const mac = await f.connected(), calls = f.fetcher.mock.calls.length;
    for (const value of [undefined, "true", "0"]) {
      const headers: Record<string, string> = { ...mac.headers }; delete headers[header];
      if (value !== undefined) headers[header] = value;
      expect((await f.issue(headers)).status).toBe(400);
    }
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("requires the current exact connected Mac and persisted sync opt-in", async () => {
    const mac = await f.connected(), other = await f.register();
    expect((await f.issue({ ...other.headers, ...optIn })).status).toBe(403);
    for (const header of ["x-zeros-device-registration", "x-zeros-device-instance"])
      expect((await f.issue({ ...mac.headers, [header]: randomUUID() })).status).toBe(409);
    expect((await f.issue({ ...mac.headers, "x-test-actor": f.other.id })).status).toBe(404);
    await f.call(`${f.path}/macs/${mac.device.deviceId}/sync`, "PUT", { wanted: false }, mac.headers);
    const response = await f.issue(mac.headers);
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe("sync_not_wanted");
  });

  it("bounds the strict empty body and never takes caller-selected repository scope", async () => {
    const mac = await f.connected(), calls = f.fetcher.mock.calls.length;
    expect((await f.issue(mac.headers, { repository: "other/project" })).status).toBe(400);
    expect((await f.issue(mac.headers, { padding: "x".repeat(4096) })).status).toBe(413);
    expect((await f.issue({ ...optIn }, {})).status).toBe(400);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it.each(["session", "session_expiry", "instance"] as const)("rechecks %s after the final device-verification await", async change => {
    await f.active();
    const mac = await f.connected(), devices = f.cp.routes.localDevices!.devices;
    const original = devices.verify.bind(devices), entered = deferred(), release = deferred();
    let reads = 0;
    vi.spyOn(devices, "verify").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++reads === 2) { entered.resolve(); await release.promise; }
      return result;
    });
    const pending = f.issue(mac.headers);
    await Promise.race([entered.promise, pending.then(() => { throw new Error("Final device check was not held"); })]);
    try {
      const changed = change === "session"
        ? await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId])
        : change === "session_expiry"
          ? await pool.query("UPDATE auth_sessions SET provider_session_expires_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId])
        : await pool.query("UPDATE local_command_devices SET instance_id=$3 WHERE user_id=$1 AND device_id=$2", [f.owner.id, mac.device.deviceId, randomUUID()]);
      expect(changed.rowCount).toBe(1);
    } finally { release.resolve(); }
    const response = await pending;
    expect(response.status).toBe(change === "instance" ? 409 : 401);
    expect((await response.json()).error.code).toBe(change === "instance" ? "device_registration_changed" : "session_revoked");
    expect(f.revoked).toContain("Bearer fixture-installation-2");
  });

  it.each(["session", "account", "membership", "rejoin", "registration", "instance", "disconnect", "wanted", "github", "source", "delete", "remote_permission"] as const)(
    "revokes the candidate after %s changes while GitHub is minting it", async change => {
      await f.active();
      const mac = await f.connected(change === "remote_permission" ? f.other : f.owner);
      const entered = deferred(), release = deferred(), original = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (input, init) => {
        const response = await original(input, init);
        if (new URL(String(input)).pathname.endsWith("/access_tokens") && f.issued.length === 2) {
          entered.resolve(); await release.promise;
        }
        return response;
      });
      const pending = f.issue(mac.headers);
      await Promise.race([entered.promise, pending.then(() => { throw new Error("GitHub mint was not held"); })]);
      try {
        if (change === "session") await pool.query("UPDATE auth_sessions SET status='revoked',revoked_at=clock_timestamp() WHERE provider_session_id=$1", [f.owner.authentication.sessionId]);
        else if (change === "account") await pool.query("UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1", [f.owner.id]);
        else if (change === "membership" || change === "rejoin") {
          expect((await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.owner.id])).rowCount).toBe(1);
          if (change === "rejoin") {
            await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [f.organizationId, f.owner.id]);
            expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/connect`, "POST", {}, mac.headers)).status).toBe(200);
            expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/sync`, "PUT", { wanted: true }, mac.headers)).status).toBe(200);
          }
        } else if (change === "registration" || change === "instance") {
          expect((await pool.query(`UPDATE local_command_devices SET ${change === "registration" ? "registration_id" : "instance_id"}=$3 WHERE user_id=$1 AND device_id=$2`,
            [f.owner.id, mac.device.deviceId, randomUUID()])).rowCount).toBe(1);
        } else if (change === "disconnect") expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/disconnect`, "POST", {}, mac.headers)).status).toBe(200);
        else if (change === "wanted") expect((await f.call(`${f.path}/macs/${mac.device.deviceId}/sync`, "PUT", { wanted: false }, mac.headers)).status).toBe(200);
        else if (change === "github") await pool.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.owner.id]);
        else if (change === "source") await pool.query("UPDATE cloud_v2_github_sources SET repository_id=99 WHERE workspace_id=$1", [f.workspaceId]);
        else if (change === "remote_permission") f.denyB();
        else await f.cp.store.transition(f.workspaceId, ["stopped"], "deleting");
      } finally { release.resolve(); }
      const response = await pending, body = await response.json();
      const code = { session: "session_revoked", account: "session_revoked", membership: "not_found", rejoin: "github_authorization_changed",
        registration: "device_registration_changed", instance: "device_registration_changed", disconnect: "mac_not_connected", wanted: "sync_not_wanted",
        github: "github_authorization_changed", source: "github_authorization_changed", delete: "not_found", remote_permission: "github_access_required" }[change];
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.error.code).toBe(code);
      expect(body).not.toHaveProperty("token");
      expect(f.revoked).toContain("Bearer fixture-installation-2");
    });

  it("reads without acquiring a workspace mutation lock", async () => {
    await f.active();
    const mac = await f.connected(), tx = await pool.connect();
    await tx.query("BEGIN"); await tx.query("SELECT id FROM cloud_v2_workspaces WHERE id=$1 FOR UPDATE", [f.workspaceId]);
    try { expect((await f.issue(mac.headers)).status).toBe(200); }
    finally { await tx.query("ROLLBACK"); tx.release(); }
  });

  it("keeps upstream diagnostics and token material out of failures and logs", async () => {
    const mac = await f.connected(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.fetcher.mockRejectedValue(new Error("fixture-person-a private-provider-diagnostic"));
    const response = await f.issue(mac.headers);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json(); expect(body.error.code).toBe("github_unavailable");
    const output = JSON.stringify([body, error.mock.calls, log.mock.calls, warn.mock.calls]);
    expect(output).not.toMatch(/fixture-person|fixture-installation|private-provider-diagnostic/);
  });
});

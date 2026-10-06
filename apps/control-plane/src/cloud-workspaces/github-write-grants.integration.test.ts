import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUser } from "../auth.js";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudWorkspaceCollaborationService } from "./actors.js";
import { DatabaseCloudWorkspaceActorSessionService } from "./actor-sessions.js";
import { cloudWorkspaceDeviceProofMessage } from "./replicas.js";
import { DatabaseCloudGithubWriteGrants } from "./github-write-grants.js";
import { createCloudGithubWriteRoutes, CLOUD_GITHUB_WRITE_PATH } from "./github-write-routes.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("cloud GitHub single-operation writes", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, actorSessionId: string;
  let service: DatabaseCloudGithubWriteGrants;
  const engine = () => ({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId, generation: 1, engineInstanceId: fixture.engineInstanceId, heartbeatToken: fixture.heartbeatToken, actorSessionId });
  const params = { title: "Test PR", body: "Body", draft: true };
  const digest = createHash("sha256").update(JSON.stringify(["gh.prCreate", params])).digest("hex");
  const input = () => ({ action: "prepareWrite" as const, organizationId: fixture.organizationId, workspaceId: fixture.workspaceId, operation: "gh.prCreate" as const, paramsSha256: digest });
  const verified = async () => ({ installationId: 123, repositoryId: "456" });
  const prepare = () => service.prepare(input(), fixture.userId, verified, "synthetic-user-token");
  const redeem = (grant: string) => service.redeem(engine(), { grant, operation: input().operation, paramsSha256: input().paramsSha256, params, branch: "test", baseBranch: "main" });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    vi.clearAllMocks();
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await runMigrations(pool); fixture = await seedReadyCloudWorkspace(pool);
    await new DatabaseCloudWorkspaceCollaborationService(pool).setSharing({ workspaceId: fixture.workspaceId, organizationId: fixture.organizationId,
      actorUserId: fixture.userId, sharingMode: "organization", expectedRevision: 1 });
    const user = await ensureUser(pool, { provider: "workos", providerSubject: `workos|${fixture.userId}`, email: `durable-${fixture.userId}@example.test`, displayName: "Owner",
      session: { id: `session_${randomUUID()}`, clientKind: "desktop", authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    await pool.query("INSERT INTO auth_sessions(provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES($1,$2,$3,'desktop',now()+interval '1 hour')",
      [user.authentication.sessionId, user.identity.subject, user.id]);
    await pool.query("UPDATE cloud_workspace_engine_instances SET actor_protocol_version=2 WHERE id=$1", [fixture.engineInstanceId]);
    const pair = generateKeyPairSync("ed25519"), publicKey = Buffer.from(pair.publicKey.export({ format: "jwk" }).x!, "base64url");
    const device = (await pool.query<{ id: string }>("INSERT INTO devices(user_id,label,platform,public_key,key_fingerprint) VALUES($1,'Test device','macos',$2,$3) RETURNING id",
      [user.id, publicKey, createHash("sha256").update(publicKey).digest()])).rows[0]!;
    const fields = { deviceId: device.id, keyVersion: 1, timestampMs: Date.now(), nonce: randomBytes(24).toString("base64url") };
    const proof = { ...fields, signature: sign(null, cloudWorkspaceDeviceProofMessage({ ...fields, accountUserId: user.id, action: "engine.connect",
      payload: { organizationId: fixture.organizationId, workspaceId: fixture.workspaceId } }), pair.privateKey).toString("base64url") };
    const sessions = new DatabaseCloudWorkspaceActorSessionService({ pool, enginePort: 39393, bridgeUrl: "wss://api.example.test/v1/cloud-workspaces/bridge", workosEnabled: false });
    const issued = await sessions.issue({ ...engine(), actorUserId: user.id, authenticatedUser: user, proof });
    actorSessionId = (await sessions.consume({ ...engine(), token: issued.grantToken })).actorSessionId;
    await pool.query("UPDATE repositories SET forge_repository_id='456',identity_state='verified' WHERE id=(SELECT repository_id FROM cloud_workspaces WHERE id=$1)", [fixture.workspaceId]);
    await pool.query("INSERT INTO github_authorizations(owner_user_id,app_variant,github_login) VALUES($1,'github.com','test-member') ON CONFLICT(owner_user_id,app_variant) DO NOTHING", [fixture.userId]);
    const installation = (await pool.query(`INSERT INTO github_installations(github_installation_id,app_variant,owner_user_id,account_login,account_type,target_type)
      SELECT 123,'github.com',$1,repository_owner,'Organization','Organization' FROM cloud_workspaces WHERE id=$2 RETURNING id`, [fixture.userId, fixture.workspaceId])).rows[0];
    await pool.query("INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id) VALUES($1,$2,$3)", [fixture.organizationId, fixture.userId, installation.id]);
    service = new DatabaseCloudGithubWriteGrants(pool, false);
  });
  it.each(["before", "during"])("V9b rejects managed preparation when disconnected %s permission verification", async when => {
    const disconnect = () => pool.query("DELETE FROM cloud_github_connections WHERE org_id=$1 AND owner_user_id=$2", [fixture.organizationId, fixture.userId]);
    if (when === "before") await disconnect();
    const verify = vi.fn(async () => { if (when === "during") await disconnect(); return verified(); });
    await expect(service.prepare(input(), fixture.userId, verify, "synthetic-user-token")).rejects.toMatchObject({ status: 403 });
    expect(verify).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
  });
  it("V9b rejects an installation other than the selected connection", async () => {
    await expect(service.prepare(input(), fixture.userId, async () => ({ installationId: 999, repositoryId: "456" }), "synthetic-user-token")).rejects.toMatchObject({ status: 403 });
  });
  it("V9b fences managed redemption and proxy use across disconnect/reconnect", async () => {
    const pending = await prepare(), issued = await prepare(), proxy = await redeem(issued.grant);
    const connection = (await pool.query("DELETE FROM cloud_github_connections WHERE org_id=$1 AND owner_user_id=$2 RETURNING *", [fixture.organizationId, fixture.userId])).rows[0];
    await expect(redeem(pending.grant)).rejects.toMatchObject({ status: 403 });
    await expect(service.authorizeProxy(proxy.token)).rejects.toMatchObject({ status: 403 });
    await pool.query("INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id,connected_at,verified_at) VALUES($1,$2,$3,$4,$5)",
      [connection.org_id, connection.owner_user_id, connection.installation_id, connection.connected_at, connection.verified_at]);
    await expect(redeem(pending.grant)).rejects.toMatchObject({ status: 403 });
    await expect(service.authorizeProxy(proxy.token)).rejects.toMatchObject({ status: 403 });
    expect((await service.authorizeProxy((await redeem((await prepare()).grant)).token)).operation).toBe("gh.prCreate");
  });
  it("V9b rejects a connection replaced while GitHub verification is pending", async () => {
    await expect(service.prepare(input(), fixture.userId, async () => {
      const connection = (await pool.query("DELETE FROM cloud_github_connections WHERE org_id=$1 AND owner_user_id=$2 RETURNING *", [fixture.organizationId, fixture.userId])).rows[0];
      await pool.query("INSERT INTO cloud_github_connections(org_id,owner_user_id,installation_id,connected_at,verified_at) VALUES($1,$2,$3,$4,$5)",
        [connection.org_id, connection.owner_user_id, connection.installation_id, connection.connected_at, connection.verified_at]);
      return verified();
    }, "synthetic-user-token")).rejects.toMatchObject({ status: 403 });
  });
  it("V9b rejects changed installation identity at redemption and proxy authorization", async () => {
    const pending = await prepare(), proxy = await redeem((await prepare()).grant);
    await pool.query("UPDATE github_installations SET github_installation_id=124 WHERE owner_user_id=$1", [fixture.userId]);
    await expect(redeem(pending.grant)).rejects.toMatchObject({ status: 403 });
    await expect(service.authorizeProxy(proxy.token)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["git.fetch", "git.pull"] as const)("authorizes managed %s with an operation-bound connected-account grant", async operation => {
    const params = { workspaceId: "local-main", ...(operation === "git.pull" ? { strategy: "rebase", autoStash: true } : {}) };
    const paramsSha256 = createHash("sha256").update(JSON.stringify([operation, params])).digest("hex");
    const prepared = await service.prepare({ ...input(), operation, paramsSha256 }, fixture.userId, verified, "synthetic-user-token");
    const redemption = { grant: prepared.grant, operation, params, paramsSha256, branch: "test", baseBranch: "main" };
    await expect(service.redeem(engine(), { ...redemption, operation: "git.push" })).rejects.toBeDefined();
    const changedParams = { ...params, remote: "other" };
    await expect(service.redeem(engine(), { ...redemption, params: changedParams,
      paramsSha256: createHash("sha256").update(JSON.stringify([operation, changedParams])).digest("hex") })).rejects.toBeDefined();
    const proxy = await service.redeem(engine(), redemption);
    expect(await service.authorizeProxy(proxy.token)).toMatchObject({ operation: "git.fetch", expectedBody: null, userToken: "synthetic-user-token" });
    await service.release(engine(), prepared.grant);
    await expect(service.authorizeProxy(proxy.token)).rejects.toBeDefined();
  });
  it("native push exchanges only a connected user grant, never installation credentials", async () => {
    const native = { requestId: randomUUID(), generation: 1, engineInstanceId: fixture.engineInstanceId,
      source: { kind: "terminal" as const, actorSessionId }, branch: "topic" };
    const params = { nativeRequestId: native.requestId };
    const paramsSha256 = createHash("sha256").update(JSON.stringify(["git.push", params])).digest("hex");
    const prepared = await service.prepare({ ...input(), operation: "git.push", paramsSha256, native }, fixture.userId, verified, "synthetic-connected-user");
    const credential = await service.redeem(engine(), { grant: prepared.grant, operation: "git.push", params, paramsSha256, branch: "topic", baseBranch: "topic" });
    expect((await service.authorizeProxy(credential.token)).userToken).toBe("synthetic-connected-user");
    expect(credential.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60000);
    expect(JSON.stringify(credential)).not.toContain("synthetic-connected-user");
    await service.release(engine(), prepared.grant);
    await expect(service.authorizeProxy(credential.token)).rejects.toThrow();
  });
  it("keeps the user token on the backend and exchanges a grant only once", async () => {
    const { grant } = await prepare();
    const row = (await pool.query("SELECT * FROM cloud_github_write_grants")).rows[0];
    expect(row.token_sealed.toString()).not.toContain("synthetic-user-token");
    const credential = await redeem(grant);
    expect(credential.token).toMatch(/^zgp_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(credential)).not.toContain("synthetic-user-token");
    await expect(redeem(grant)).rejects.toMatchObject({ status: 403 });
    await service.release(engine(), grant);
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
  });
  it("returns only the current actor's author and rejects retired actor sessions", async () => {
    expect(await service.gitAuthor(engine())).toEqual({ author: null });
    await pool.query("UPDATE github_authorizations SET github_user_id=1234,git_author_name='Test Member' WHERE owner_user_id=$1", [fixture.userId]);
    const app = createCloudGithubWriteRoutes(service);
    const { heartbeatToken, actorSessionId: session, ...scope } = engine();
    const response = await app.request(CLOUD_GITHUB_WRITE_PATH, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request: { kind: "author", actorSessionId: session } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ author: { name: "Test Member", email: "1234+test-member@users.noreply.github.com" } });
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
    await pool.query("DELETE FROM github_authorizations WHERE owner_user_id=$1", [fixture.userId]);
    expect(await service.gitAuthor(engine())).toEqual({ author: null });
    await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1", [session]);
    await expect(service.gitAuthor(engine())).rejects.toBeDefined();
  });
  it("rejects an immutable repository mismatch before minting", async () => {
    await expect(service.prepare(input(), fixture.userId, async () => ({ installationId: 123, repositoryId: "999" }), "synthetic-user-token")).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks the GitHub account after the network permission probe", async () => {
    await expect(service.prepare(input(), fixture.userId, async () => {
      await pool.query("DELETE FROM github_authorizations WHERE owner_user_id=$1", [fixture.userId]); return verified();
    }, "synthetic-user-token")).rejects.toMatchObject({ status: 403 });
  });
  it.each(["session", "github", "engine"])("withdraws a prepared grant after %s authority changes", async cause => {
    const { grant } = await prepare();
    if (cause === "session") await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1", [actorSessionId]);
    else if (cause === "github") await pool.query("DELETE FROM github_authorizations WHERE owner_user_id=$1", [fixture.userId]);
    else await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [fixture.engineInstanceId]);
    await expect(redeem(grant)).rejects.toBeDefined();
  });
  it("deletes abandoned token ciphertext without revoking the user's GitHub account", async () => {
    const { grant } = await prepare();
    await pool.query("UPDATE cloud_github_write_grants SET admission_expires_at=now()-interval '1 minute',lease_expires_at=now()-interval '1 minute'");
    await expect(redeem(grant)).rejects.toMatchObject({ status: 403 });
    await service.cleanup();
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
  });
  it("fences proxy use by operation replay, user disconnect, actor session and engine retirement", async () => {
    const { grant } = await prepare(), proxy = await redeem(grant);
    const allowed = await service.authorizeProxy(proxy.token, "api");
    expect(allowed.userToken).toBe("synthetic-user-token");
    expect(allowed.expectedBody).toEqual({ ...params, head: "test", base: "main" });
    await expect(service.authorizeProxy(proxy.token, "api")).rejects.toMatchObject({ status: 403 });
    await service.allowDraftFallback(proxy.token);
    expect((await service.authorizeProxy(proxy.token, "api")).expectedBody?.draft).toBe(false);
    await service.allowDraftFallback(proxy.token);
    await expect(service.authorizeProxy(proxy.token, "api")).rejects.toMatchObject({ status: 403 });
    await pool.query("UPDATE cloud_workspace_actor_sessions SET revoked_at=now() WHERE id=$1", [actorSessionId]);
    await expect(service.authorizeProxy(proxy.token)).rejects.toBeDefined();
  });
  it.each(["github", "engine", "expiry"])("withdraws an issued proxy after %s changes", async cause => {
    const { token } = await redeem((await prepare()).grant);
    if (cause === "github") await pool.query("DELETE FROM github_authorizations WHERE owner_user_id=$1", [fixture.userId]);
    if (cause === "engine") await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [fixture.engineInstanceId]);
    if (cause === "expiry") await pool.query("UPDATE cloud_github_write_grants SET lease_expires_at=now()-interval '1 second'");
    await expect(service.authorizeProxy(token)).rejects.toBeDefined();
  });
  it("allows proxy release after engine retirement and never returns upstream error details", async () => {
    const { grant } = await prepare(); await redeem(grant);
    await pool.query("UPDATE cloud_workspace_engine_instances SET revoked_at=now(),state='revoked' WHERE id=$1", [fixture.engineInstanceId]);
    await service.release(engine(), grant);
    expect((await pool.query("SELECT 1 FROM cloud_github_write_grants")).rowCount).toBe(0);
    const app = createCloudGithubWriteRoutes(service), { heartbeatToken, actorSessionId: actor, ...scope } = engine();
    const response = await app.request(CLOUD_GITHUB_WRITE_PATH, { method: "POST", headers: { authorization: `Bearer ${heartbeatToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...scope, request: { kind: "redeem", actorSessionId: actor, grant, operation: input().operation, paramsSha256: input().paramsSha256, params, branch: "test", baseBranch: "main" } }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "github_write_authority_rejected" });
  });
});

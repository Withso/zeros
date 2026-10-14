import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { DatabaseZerosDevAuthRepository } from "./zeros-dev-auth-repository.js";
import type { AuthTokenClaims } from "./auth-token-contract.js";
import { createAuthMiddleware } from "./auth.js";
import type { Config } from "./config.js";
import { createCloudWorkspaceRoutes } from "./cloud-workspaces/routes.js";

const database = process.env.TEST_DATABASE_URL;
const d = database ? describe : describe.skip;
d("zeros-dev existing account, audit and shared rate limits", () => {
  let pool: pg.Pool;
  let repository: DatabaseZerosDevAuthRepository;
  const server = createServer();
  let privateKey: CryptoKey;
  let auth: Extract<Config["auth"], { provider: "workos" }>;
  const pin = { subject: "user_zeros_dev_fixture", accountId: randomUUID(), email: "zeros-dev@example.test", organizationId: randomUUID() };
  const request = () => ({ password: "synthetic-password", requestId: randomUUID(), device: { id: randomUUID(), intent: "register" as const, platform: "linux" as const } });
  const claims = (): AuthTokenClaims => ({ providerSubject: pin.subject, sessionId: `session_${randomUUID()}`, tokenId: "token_fixture",
    clientId: "client_web_fixture", clientKind: "web", email: pin.email, emailVerified: true, displayName: null,
    avatarUrl: null, authTime: 1, issuedAt: 1, expiresAt: Math.floor(Date.now()/1000) + 3600 });
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database, max: 4 }); repository = new DatabaseZerosDevAuthRepository(pool);
    const keys = await generateKeyPair("RS256"); privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    server.on("request", (_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] })); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listen failed");
    auth = { provider: "workos", issuer: "https://api.workos.com/user_management/client_web_fixture", audience: "https://api-alpha.zeros.build",
      webClientId: "client_web_fixture", desktopClientId: "client_desktop_fixture", jwksUrl: `http://127.0.0.1:${address.port}/jwks` };
  });
  afterAll(async () => { await pool.end(); await new Promise<void>(resolve => server.close(() => resolve())); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    await pool.query("INSERT INTO users (id,email) VALUES ($1,$2)", [pin.accountId, pin.email]);
    await pool.query("INSERT INTO user_identities (user_id,provider,provider_sub,email_at_link,email_verified_at) VALUES ($1,'workos',$2,$3,now())", [pin.accountId,pin.subject,pin.email]);
    await pool.query("INSERT INTO organizations (id,slug,name,created_by) VALUES ($1,'zd-fixture','Test fixture',$2)", [pin.organizationId,pin.accountId]);
    await pool.query("INSERT INTO organization_members (org_id,user_id,role) VALUES ($1,$2,'member')", [pin.organizationId,pin.accountId]);
  });

  it("commits only an existing non-staff account and retains normal membership", async () => {
    const input = request(), token = claims();
    await repository.begin(pin,input,"source-fixture");
    await repository.commit(pin,input,token);
    expect((await pool.query("SELECT action,subject FROM audit_log ORDER BY created_at")).rows).toEqual([
      { action: "zeros_dev.auth_attempt", subject: { requestId: input.requestId, source: "source-fixture", deviceId: input.device.id, deviceIntent: "register" } },
      { action: "zeros_dev.auth_session_issued", subject: { requestId: input.requestId, deviceId: input.device.id, deviceIntent: "register", sessionId: token.sessionId, clientKind: "web", authenticationMethod: "Password" } },
    ]);
    expect((await pool.query("SELECT staff_role FROM users WHERE id=$1", [pin.accountId])).rows[0]).toEqual({staff_role:null});
    expect((await pool.query("SELECT role FROM organization_members WHERE user_id=$1", [pin.accountId])).rows[0]).toEqual({role:"member"});
  });

  it("records a web session truthfully so ordinary bearer authentication can reuse it", async () => {
    const input = request(), token = { ...claims(), clientKind: "web" as const, clientId: "client_web_fixture" };
    await repository.begin(pin, input, "source-fixture");
    await repository.commit(pin, input, token);
    expect((await pool.query("SELECT client_kind,status FROM auth_sessions")).rows).toEqual([{ client_kind: "web", status: "active" }]);
    expect((await pool.query("SELECT subject->>'clientKind' AS kind FROM audit_log WHERE action='zeros_dev.auth_session_issued'")).rows).toEqual([{ kind: "web" }]);
  });

  it("admits the signed web session through the unchanged device and runtime routes and honors its tombstone", async () => {
    const input = request(), token = claims();
    await repository.begin(pin, input, "source"); await repository.commit(pin, input, token);
    const bearer = await new SignJWT({ sid: token.sessionId, jti: token.tokenId, client_id: auth.webClientId,
      "https://zeros.build/email": pin.email, "https://zeros.build/email_verified": true })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" }).setSubject(pin.subject).setIssuedAt().setExpirationTime("5m")
      .setIssuer(auth.issuer).setAudience(auth.audience).sign(privateKey);
    const app = new Hono();
    app.onError((error, c) => c.json({ error: "fixture-route-error" }, "status" in error ? error.status as 401 : 500));
    app.use("/v1/*", createAuthMiddleware({ auth } as Config, pool));
    const registerDevice = vi.fn(async () => ({ replayed: false, device: { id: input.device.id } }));
    const issueActor = vi.fn(async () => ({ token: "synthetic-runtime-admission" }));
    app.route("/", createCloudWorkspaceRoutes(pool, null, { replicaService: { registerDevice } as never,
      engineClientAdmissionService: { issueActor } as never }));
    const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", "idempotency-key": randomUUID() };
    const deviceRequest = () => app.request("/v1/devices", { method: "POST", headers, body: JSON.stringify({ label: "zd-fixture", platform: "linux", publicKey: "a".repeat(43) }) });
    expect((await deviceRequest()).status).toBe(201);
    expect(registerDevice).toHaveBeenCalledWith(expect.objectContaining({ accountUserId: pin.accountId }));
    const workspaceId = randomUUID();
    expect((await app.request(`/v1/organizations/${pin.organizationId}/cloud-workspaces/${workspaceId}/runtime/admission`, {
      method: "POST", headers, body: JSON.stringify({ actorProtocolVersion: 2 }) })).status).toBe(201);
    expect(issueActor).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: pin.accountId, organizationId: pin.organizationId, workspaceId,
      authenticatedUser: expect.objectContaining({ authentication: expect.objectContaining({ clientKind: "web", sessionId: token.sessionId }) }) }));
    await repository.revoke(pin, token.sessionId);
    expect((await deviceRequest()).status).toBe(401);
    expect(registerDevice).toHaveBeenCalledOnce();
  });

  it("allows refresh only for its own issued web session and audits the same SID", async () => {
    const input = request(), token = claims();
    await repository.begin(pin, input, "source"); await repository.commit(pin, input, token);
    const refresh = request();
    await repository.begin(pin, refresh, "source", { sessionId: token.sessionId, operation: "refresh" });
    await repository.commit(pin, refresh, { ...token, expiresAt: token.expiresAt + 300 }, "refresh");
    expect((await pool.query("SELECT provider_session_id,client_kind FROM auth_sessions")).rows).toEqual([{ provider_session_id: token.sessionId, client_kind: "web" }]);
    expect((await pool.query("SELECT subject->>'sessionId' AS id FROM audit_log WHERE action='zeros_dev.auth_session_refreshed'")).rows).toEqual([{ id: token.sessionId }]);
    const other = claims();
    await pool.query("INSERT INTO auth_sessions(provider,provider_session_id,provider_sub,user_id,client_kind,last_token_expires_at) VALUES('workos',$1,$2,$3,'web',now()+interval '1 hour')", [other.sessionId, pin.subject, pin.accountId]);
    await expect(repository.begin(pin, request(), "source", { sessionId: other.sessionId, operation: "refresh" })).rejects.toThrow("zeros_dev_auth_denied");
    await expect(repository.revoke(pin, other.sessionId, request())).rejects.toThrow("zeros_dev_auth_denied");
  });

  it("allows idempotent logout but cannot refresh a retired session or one whose membership changed", async () => {
    const input = request(), token = claims();
    await repository.begin(pin, input, "source"); await repository.commit(pin, input, token);
    const logout = request();
    await repository.begin(pin, logout, "source", { sessionId: token.sessionId, operation: "revoke" });
    await repository.revoke(pin, token.sessionId, logout);
    await repository.revoke(pin, token.sessionId, request());
    await expect(repository.begin(pin, request(), "source", { sessionId: token.sessionId, operation: "refresh" })).rejects.toThrow("zeros_dev_auth_denied");
    await expect(repository.commit(pin, request(), token, "refresh")).rejects.toThrow("zeros_dev_auth_denied");
    expect((await pool.query("SELECT count(*)::int n FROM workos_command_outbox")).rows[0]?.n).toBe(1);
    await pool.query("DELETE FROM organization_members WHERE user_id=$1", [pin.accountId]);
    await expect(repository.begin(pin, request(), "source", { sessionId: token.sessionId, operation: "revoke" })).rejects.toThrow("zeros_dev_auth_denied");
  });

  it.each(["subject", "accountId", "email", "organizationId"])("does not sign up or link a foreign %s", async key => {
    const other = { ...pin, [key]: key.endsWith("Id") ? randomUUID() : "foreign@example.test" };
    await expect(repository.begin(other,request(),"source")).rejects.toThrow("zeros_dev_auth_denied");
    expect((await pool.query("SELECT count(*)::int n FROM users")).rows[0]?.n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM audit_log")).rows[0]?.n).toBe(0);
  });

  it.each([
    "UPDATE users SET staff_role='developer'",
    "UPDATE users SET auth_status='suspended'",
    "UPDATE users SET deleted_at=now()",
    "UPDATE user_identities SET status='revoked'",
    "UPDATE user_identities SET email_verified_at=NULL",
    "UPDATE organizations SET deleted_at=now()",
    "DELETE FROM organization_members",
  ])("rechecks identity and membership after password issuance: %s", async mutation => {
    const input=request();
    await repository.begin(pin,input,"source");
    await pool.query(mutation);
    await expect(repository.commit(pin,input,claims())).rejects.toThrow("zeros_dev_auth_denied");
    expect((await pool.query("SELECT count(*)::int n FROM auth_sessions")).rows[0]?.n).toBe(0);
  });

  it("rolls the session back when the success audit is rejected", async () => {
    const input=request();
    await repository.begin(pin,input,"source");
    await pool.query("CREATE FUNCTION reject_zeros_dev_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='zeros_dev.auth_session_issued' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$");
    await pool.query("CREATE TRIGGER reject_zeros_dev_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_zeros_dev_audit()");
    await expect(repository.commit(pin,input,claims())).rejects.toThrow();
    expect((await pool.query("SELECT count(*)::int n FROM auth_sessions")).rows[0]?.n).toBe(0);
  });

  it("serializes global and source limits across repository instances", async () => {
    const second=new DatabaseZerosDevAuthRepository(pool);
    const requests=Array.from({length:6},(_,i)=>(i%2?repository:second).begin(pin,request(),"same"));
    const source=await Promise.allSettled(requests);
    expect(source.filter(r=>r.status==="fulfilled")).toHaveLength(5);
    expect(source.filter(r=>r.status==="rejected")).toHaveLength(1);
    for(let i=0;i<15;i++) await second.begin(pin,request(),`different-${i}`);
    await expect(repository.begin(pin,request(),"another")).rejects.toThrow("zeros_dev_auth_rate_limited");
  });

  it("does not repeat an unknown request and retains revocation tombstones/outbox", async () => {
    const input=request(), token=claims();
    await repository.begin(pin,input,"source");
    await expect(repository.begin(pin,input,"source")).rejects.toThrow("zeros_dev_auth_denied");
    await repository.revoke(pin,token.sessionId);
    await repository.revoke(pin,token.sessionId);
    await expect(repository.commit(pin,input,token)).rejects.toThrow("zeros_dev_auth_denied");
    expect((await pool.query("SELECT status FROM auth_sessions")).rows).toEqual([{status:"revoked"}]);
    expect((await pool.query("SELECT operation,payload FROM workos_command_outbox")).rows).toEqual([{operation:"session.revoke",payload:{sessionId:token.sessionId}}]);
  });

  it("keeps unknown grant request IDs fenced after the rate-limit window", async () => {
    const input=request();
    await repository.begin(pin,input,"source");
    await pool.query("UPDATE audit_log SET created_at=now()-interval '2 minutes' WHERE action='zeros_dev.auth_attempt'");
    await expect(repository.begin(pin,input,"different")).rejects.toThrow("zeros_dev_auth_denied");
    expect((await pool.query("SELECT count(*)::int n FROM audit_log")).rows[0]?.n).toBe(1);
  });

  it("records closed failure outcomes without provider diagnostics or secrets", async () => {
    const input=request();
    await repository.begin(pin,input,"source");
    await repository.finish(pin,input,{outcome:"unknown_issuance",cleanup:"unknown"});
    expect((await pool.query("SELECT subject FROM audit_log WHERE action='zeros_dev.auth_attempt_finished'")).rows)
      .toEqual([{subject:{requestId:input.requestId,outcome:"unknown_issuance",cleanup:"unknown"}}]);
  });
});

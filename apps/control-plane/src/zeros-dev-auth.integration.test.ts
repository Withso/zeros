import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "./test-database.js";
import { DatabaseZerosDevAuthRepository } from "./zeros-dev-auth-repository.js";
import type { AuthTokenClaims } from "./auth-token-contract.js";

const database = process.env.TEST_DATABASE_URL;
const d = database ? describe : describe.skip;
d("zeros-dev existing account, audit and shared rate limits", () => {
  let pool: pg.Pool;
  let repository: DatabaseZerosDevAuthRepository;
  const pin = { subject: "user_zeros_dev_fixture", accountId: randomUUID(), email: "zeros-dev@example.test", organizationId: randomUUID() };
  const request = () => ({ password: "synthetic-password", requestId: randomUUID(), device: { id: randomUUID(), intent: "register" as const, platform: "linux" as const } });
  const claims = (): AuthTokenClaims => ({ providerSubject: pin.subject, sessionId: `session_${randomUUID()}`, tokenId: "token_fixture",
    clientId: "client_desktop_fixture", clientKind: "desktop", email: pin.email, emailVerified: true, displayName: null,
    avatarUrl: null, authTime: 1, issuedAt: 1, expiresAt: Math.floor(Date.now()/1000) + 3600 });
  beforeAll(() => { pool = new pg.Pool({ connectionString: database, max: 4 }); repository = new DatabaseZerosDevAuthRepository(pool); });
  afterAll(async () => { await pool.end(); });
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
      { action: "zeros_dev.auth_session_issued", subject: { requestId: input.requestId, deviceId: input.device.id, deviceIntent: "register", sessionId: token.sessionId, clientKind: "desktop", authenticationMethod: "Password" } },
    ]);
    expect((await pool.query("SELECT staff_role FROM users WHERE id=$1", [pin.accountId])).rows[0]).toEqual({staff_role:null});
    expect((await pool.query("SELECT role FROM organization_members WHERE user_id=$1", [pin.accountId])).rows[0]).toEqual({role:"member"});
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

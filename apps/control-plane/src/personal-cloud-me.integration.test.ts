// /v1/me's Personal row: exactly as before with the switch off; with it on, cloud
// is offered and the seat follows the owner's Pro, read live.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureUser, type AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { configureCloudPersonal } from "./db-context.js";
import { createRoutes } from "./routes.js";
import { grantTestPro } from "./test-pro.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("the Personal row in /v1/me", () => {
  let pool: pg.Pool, app: Hono, actor: AuthedUser;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("user", actor); await next(); });
    app.route("/", createRoutes(pool, undefined, { inviteLinkBase: "https://app.example.test/invite" }));
    app.onError((error, c) => error instanceof HttpError ? c.json({ error: { code: error.code } }, error.status) : c.json({ error: "x" }, 500));
  });
  afterAll(() => { configureCloudPersonal(pool, false); return pool.end(); });
  const personal = async () => {
    const me = await (await app.request("/v1/me")).json() as { organizations: { isPersonal: boolean }[] };
    return me.organizations.find(row => row.isPersonal)!;
  };
  async function person() {
    const sub = randomUUID();
    actor = await ensureUser(pool, { provider: "workos", providerSubject: sub, email: `p-${sub}@example.test`, displayName: "Person",
      session: { id: `session_${sub}`, clientKind: "web", authTime: Math.floor(Date.now() / 1000), tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600 } });
    return actor;
  }

  it("is byte-identical to before with the switch off, with or without Pro", async () => {
    const user = await person();
    configureCloudPersonal(pool, false);
    const org = (await pool.query(`SELECT o.id,o.slug,o.name,o.logo,t.id AS team FROM organizations o
      LEFT JOIN teams t ON t.org_id=o.id AND t.is_default AND t.deleted_at IS NULL WHERE o.created_by=$1 AND o.is_personal`, [user.id])).rows[0];
    // The row as main writes it: no seat, cloud false.
    const before = JSON.stringify({ id: org.id, slug: org.slug, name: org.name, logo: org.logo, role: "owner", isPersonal: true, defaultTeamId: org.team,
      workspaceCapabilities: { local: true, cloud: false }, teamCapabilities: { multiple: false, canCreate: false } });
    expect(JSON.stringify(await personal())).toBe(before);
    await grantTestPro(pool, user.id);
    expect(JSON.stringify(await personal())).toBe(before);
  });

  it("offers cloud with the switch on, its seat following the owner's Pro with no write", async () => {
    const user = await person();
    configureCloudPersonal(pool, true);
    expect(await personal()).toMatchObject({ workspaceCapabilities: { local: true, cloud: true }, seat: "free" });
    await pool.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,valid_from,valid_until)
      VALUES($1,'pro','active',true,'operator',now()-interval '1 day',clock_timestamp()+interval '1 second')`, [user.id]);
    expect(await personal()).toMatchObject({ workspaceCapabilities: { cloud: true }, seat: "pro" });
    const revision = (await pool.query("SELECT revision::text FROM account_entitlements WHERE user_id=$1", [user.id])).rows[0].revision;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(await personal()).toMatchObject({ workspaceCapabilities: { cloud: true }, seat: "free" });
    expect((await pool.query("SELECT revision::text FROM account_entitlements WHERE user_id=$1", [user.id])).rows[0].revision).toBe(revision);
  });
});

// cloud_organization_enabled (0262), through the transaction helpers production
// uses: an organization keeps its own column; a Personal organization has cloud
// only with the process's switch on and its owner's Pro live.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureCloudPersonal, SYSTEM_DATABASE_CONTEXT } from "../db-context.js";
import { withSystemTx, withUserTx } from "../db.js";
import { grantTestPro } from "../test-pro.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ENABLED = "SELECT cloud_organization_enabled(o) AS enabled FROM organizations o WHERE o.id=$1";

database("cloud_organization_enabled", () => {
  let pool: pg.Pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(() => { configureCloudPersonal(pool, false); return pool.end(); });

  const person = async (options: { staff?: boolean } = {}) => {
    const id = randomUUID(), personal = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query("INSERT INTO users(id,email,staff_role) VALUES($1,$2,$3)", [id, `${id}@example.test`, options.staff ? "developer" : null]);
      await tx.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Personal',$3,true,false)",
        [personal, `personal-${personal}`, id]);
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [personal, id]);
    });
    // A staff role grants the benefit on its own; make sure it is live.
    if (options.staff) await pool.query("INSERT INTO staff_pro_benefits(user_id) VALUES($1) ON CONFLICT (user_id) DO UPDATE SET revoked_at=NULL", [id]);
    return { id, personal };
  };
  const organization = async (owner: string, allowed: boolean) => {
    const id = randomUUID();
    await withSystemTx(pool, async tx => {
      await tx.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,$4)",
        [id, `org-${id}`, owner, allowed]);
      await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
    });
    return id;
  };
  const enabled = async (on: boolean, org: string, as?: string) => {
    configureCloudPersonal(pool, on);
    const run = (tx: pg.PoolClient) => tx.query<{ enabled: boolean }>(ENABLED, [org]);
    return (await (as ? withUserTx(pool, as, run) : withSystemTx(pool, run))).rows[0]?.enabled;
  };

  it("leaves an organization's answer to its own column, whatever the switch", async () => {
    const { id } = await person();
    await grantTestPro(pool, id);
    const on = await organization(id, true), off = await organization(id, false);
    for (const toggle of [false, true]) {
      expect(await enabled(toggle, on)).toBe(true);
      expect(await enabled(toggle, off)).toBe(false);
      expect(await enabled(toggle, on, id)).toBe(true);
    }
  });

  it("gives a Personal organization cloud only with the switch on and its owner's Pro", async () => {
    const { id, personal } = await person();
    expect(await enabled(true, personal)).toBe(false);
    await grantTestPro(pool, id);
    expect(await enabled(false, personal)).toBe(false);
    expect(await enabled(false, personal, id)).toBe(false);
    expect(await enabled(true, personal)).toBe(true);
    expect(await enabled(true, personal, id)).toBe(true);
    // Nothing was written to the organization: the CHECK still holds it local-only.
    expect((await pool.query("SELECT cloud_workspaces_allowed FROM organizations WHERE id=$1", [personal])).rows[0].cloud_workspaces_allowed).toBe(false);
  });

  it("ends when Pro's window closes, with no write", async () => {
    const { id, personal } = await person();
    await pool.query(`INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source,valid_from,valid_until)
      VALUES($1,'pro','active',true,'operator',now()-interval '1 day',clock_timestamp()+interval '1 second')`, [id]);
    expect(await enabled(true, personal, id)).toBe(true);
    const revision = (await pool.query("SELECT revision::text FROM account_entitlements WHERE user_id=$1", [id])).rows[0].revision;
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(await enabled(true, personal, id)).toBe(false);
    expect(await enabled(true, personal)).toBe(false);
    expect((await pool.query("SELECT revision::text FROM account_entitlements WHERE user_id=$1", [id])).rows[0].revision).toBe(revision);
  });

  it("counts staff Pro", async () => {
    const { id, personal } = await person({ staff: true });
    expect(await enabled(true, personal, id)).toBe(true);
    expect(await enabled(false, personal, id)).toBe(false);
  });

  it("is false for another person's Personal organization in a user transaction", async () => {
    const owner = await person(), other = await person();
    await grantTestPro(pool, owner.id, other.id);
    // The row itself, handed in: the other person cannot read it under RLS either.
    const row = (await pool.query("SELECT o::text AS row FROM organizations o WHERE id=$1", [owner.personal])).rows[0].row;
    configureCloudPersonal(pool, true);
    const answer = await withUserTx(pool, other.id, tx => tx.query("SELECT cloud_organization_enabled($1::organizations) AS enabled", [row]));
    expect(answer.rows[0].enabled).toBe(false);
    expect(await enabled(true, owner.personal, other.id)).toBeUndefined();
  });

  it("leaves the GitHub actor fingerprint byte-identical for an organization and admits Personal only while enabled", async () => {
    const { id, personal } = await person();
    await grantTestPro(pool, id);
    const org = await organization(id, true);
    await pool.query(`INSERT INTO github_authorizations(owner_user_id,app_variant,github_login,github_user_id,git_author_name,last_verified_at)
      VALUES($1,'github.com','octo',$2,'Octo',now())`, [id, Math.floor(Math.random() * 1e9)]);
    const before0262 = readFileSync(new URL("../../migrations/0206_github_authorization_generations.sql", import.meta.url), "utf8")
      .match(/CREATE OR REPLACE FUNCTION cloud_github_actor_fingerprint[\s\S]*?\n\$\$;/)![0];
    const client = await pool.connect();
    try {
      const fingerprint = async (target: string, on: boolean) => (await client.query<{ value: string | null }>(
        `SELECT set_config('app.cloud_personal',$3,true), cloud_github_actor_fingerprint($1,$2) AS value`, [target, id, on ? "1" : "0"])).rows[0]!.value;
      await client.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      const now = { org: await fingerprint(org, false), orgOn: await fingerprint(org, true), personalOn: await fingerprint(personal, true), personalOff: await fingerprint(personal, false) };
      await client.query(before0262);
      const then = { org: await fingerprint(org, false), personal: await fingerprint(personal, true) };
      expect(now.org).toMatch(/^[0-9a-f]{64}$/);
      expect(now.orgOn).toBe(now.org);
      expect(then.org).toBe(now.org);
      expect(then.personal).toBeNull();
      expect(now.personalOn).toMatch(/^[0-9a-f]{64}$/);
      expect(now.personalOff).toBeNull();
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});

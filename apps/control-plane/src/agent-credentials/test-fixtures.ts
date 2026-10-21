import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ensureUser } from "../auth.js";
import type { Tx } from "../db.js";

/** Only the isolated DB owner may grant the fixture's account entitlement. */
export async function withCredentialFixtureOwnerTx<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const authority = await client.query("SELECT current_user=pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.account_entitlements'::regclass");
    if (authority.rows[0]?.owner !== true) throw new Error("Credential fixture requires the database owner");
    await client.query("BEGIN; SELECT set_config('app.system','on',true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Settings authority has no dependency on a running workspace or VM. */
export async function seedCredentialOwner(pool: pg.Pool, options: { ownerUserId?: string } = {}) {
  const userId = options.ownerUserId ?? randomUUID(), organizationId = randomUUID(), teamId = randomUUID();
  const email = `credential-${userId}@example.test`;
  await withCredentialFixtureOwnerTx(pool, async tx => {
    if (!options.ownerUserId) {
      await tx.query("INSERT INTO users(id,email,display_name,staff_role) VALUES($1,$2,'Credential owner','developer')", [userId,email]);
      await tx.query("INSERT INTO user_identities(user_id,provider,provider_sub,email_at_link,email_verified_at) VALUES($1,'workos',$2,$3,now())", [userId,`workos|${userId}`,email]);
      await tx.query("INSERT INTO account_entitlements(user_id,plan,status,cloud_workspaces_allowed,source) VALUES($1,'pro','active',true,'operator')", [userId]);
    }
    await tx.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Credential organization',$3,false,true)", [organizationId,`credential-${organizationId}`,userId]);
    await tx.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [organizationId,userId]);
    await tx.query("INSERT INTO teams(id,org_id,slug,name,is_default,created_by) VALUES($1,$2,'default','Default',true,$3)", [teamId,organizationId,userId]);
    await tx.query("INSERT INTO team_members(team_id,org_id,user_id,role) VALUES($1,$2,$3,'maintainer')", [teamId,organizationId,userId]);
    await tx.query("INSERT INTO organization_entitlements(org_id,plan,status,cloud_workspaces_allowed,seat_limit,source) VALUES($1,'business','active',true,5,'operator')", [organizationId]);
    await tx.query("INSERT INTO organization_seat_assignments(org_id,user_id,assigned_by) VALUES($1,$2,$2)", [organizationId,userId]);
  });
  return { userId, organizationId, teamId };
}

export async function ensureCredentialPilotUser(pool: pg.Pool, input: Parameters<typeof ensureUser>[1]) {
  const user = await ensureUser(pool,input);
  await pool.query("UPDATE users SET staff_role='developer' WHERE id=$1", [user.id]);
  return user;
}

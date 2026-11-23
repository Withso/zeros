// A revoking security event (revoke_cloud_v2_security_access) stops the matching workspaces and ends their tokens, and
// the write that records it commits, whatever the workspace's state and whichever tokens it holds. A workspace leaving
// running, or archived, deletes its API tokens from a BEFORE UPDATE trigger (cloud_api_token_lifetime); the event's
// own token update must never reach a row that trigger deleted (0255).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureUser, type AuthedUser } from "../auth.js";
import { SYSTEM_DATABASE_CONTEXT } from "../db-context.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store, type CloudV2Workspace } from "./store.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("a revoking security event with a live workspace", () => {
  let pool: pg.Pool, store: CloudV2Store, creator: AuthedUser, org: string, workspace: CloudV2Workspace;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); store = new CloudV2Store(pool); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    const id = randomUUID();
    creator = await ensureUser(pool, { provider: "workos", providerSubject: `user_${id.replaceAll("-", "")}`, email: `${id}@example.test`, displayName: "Creator" });
    await grantTestPro(pool, creator.id);
    org = randomUUID();
    await pool.query(`INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed)
      VALUES ($1::uuid, ($1::uuid)::text, 'Org', $2, false, true)`, [org, creator.id]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org, creator.id]);
    workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator.id,
      name: "w", repository: "fixture/repo", branch: "zeros/w", baseBranch: "main", computerBuildId: null });
  });

  /** Every revoking kind, as its writers record it, and an organization-wide one with no person. */
  const events: Record<string, () => { kind: string; user: string | null; org: string | null; workspace: string | null }> = {
    "account.revoked": () => ({ kind: "account.revoked", user: creator.id, org: null, workspace: null }),
    "account.authorization_changed": () => ({ kind: "account.authorization_changed", user: creator.id, org: null, workspace: null }),
    "organization.access_revoked": () => ({ kind: "organization.access_revoked", user: creator.id, org, workspace: null }),
    "organization.access_revoked, organization-wide": () => ({ kind: "organization.access_revoked", user: null, org, workspace: null }),
    "workspace.authorization_changed": () => ({ kind: "workspace.authorization_changed", user: null, org, workspace: workspace.id }),
  };
  const states = ["creating", "starting", "running", "stopping", "stopped", "failed", "archived"] as const;
  const tokenKinds = ["none", "connect", "proxy", "api"] as const;

  it.each(Object.keys(events).flatMap(event => states.map(state => [event, state] as const)))("%s, the workspace %s: commits with any token", async (event, state) => {
    for (const token of tokenKinds) {
      const client = await pool.connect();
      try {
        await client.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
        await client.query(`UPDATE cloud_v2_workspaces SET state=$2, archived_at=CASE WHEN $3 THEN clock_timestamp() END WHERE id=$1`,
          [workspace.id, state === "archived" ? "stopped" : state, state === "archived"]);
        if (token !== "none") await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,user_id,expires_at,api_stop_generation,api_envelope)
          SELECT sha256(gen_random_uuid()::text::bytea),id,$2,$3,clock_timestamp()+interval '1 hour',CASE WHEN $2='api' THEN stop_generation END,
            CASE WHEN $2='api' THEN '{}'::jsonb END FROM cloud_v2_workspaces WHERE id=$1`, [workspace.id, token, token === "api" ? null : creator.id]);
        const before = (await client.query("SELECT access_epoch::text FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].access_epoch;
        const e = events[event]!();
        await client.query(`INSERT INTO security_events(kind,user_id,org_id,workspace_id,payload) VALUES($1,$2,$3,$4,'{}'::jsonb)`,
          [e.kind, e.user, e.org, e.workspace]);
        const after = (await client.query("SELECT state, access_epoch::text FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0];
        const live = ["creating", "starting", "running"].includes(state);
        expect([token, after.state], token).toEqual([token, live ? "stopping" : state === "archived" ? "stopped" : state]);
        expect([token, BigInt(after.access_epoch)], token).toEqual([token, BigInt(before) + 1n]);
        // The API token is gone with the workspace's run; any other is expired.
        const left = (await client.query("SELECT kind, expires_at <= clock_timestamp() AS expired FROM cloud_v2_tokens WHERE workspace_id=$1", [workspace.id])).rows;
        expect([token, left], token).toEqual([token, token === "none" || token === "api" ? [] : [{ kind: token, expired: true }]]);
      } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
    }
  });

  it("leaves another person's workspace as it is", async () => {
    const other = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Other')", [other, `${other}@example.test`]);
    const client = await pool.connect();
    try {
      await client.query(`BEGIN; ${SYSTEM_DATABASE_CONTEXT}`);
      await client.query("UPDATE cloud_v2_workspaces SET state='running' WHERE id=$1", [workspace.id]);
      await client.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,expires_at,api_stop_generation,api_envelope)
        SELECT sha256(gen_random_uuid()::text::bytea),id,'api',clock_timestamp()+interval '1 hour',stop_generation,'{}'::jsonb FROM cloud_v2_workspaces WHERE id=$1`, [workspace.id]);
      await client.query("INSERT INTO security_events(kind,user_id,payload) VALUES('account.revoked',$1,'{}'::jsonb)", [other]);
      expect((await client.query("SELECT state FROM cloud_v2_workspaces WHERE id=$1", [workspace.id])).rows[0].state).toBe("running");
      expect((await client.query("SELECT count(*)::int AS n FROM cloud_v2_tokens WHERE workspace_id=$1 AND kind='api'", [workspace.id])).rows[0].n).toBe(1);
    } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
  });
});

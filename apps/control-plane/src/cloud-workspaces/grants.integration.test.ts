import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import { ensureUser } from "../auth.js";
import { withSystemTx, withUserTx } from "../db.js";
import { runMigrations } from "../migrate.js";
import {
  CloudWorkspaceGrantError,
  consumeCloudWorkspaceGrant,
  issueCloudWorkspaceGrant,
} from "./grants.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const d = databaseUrl ? describe : describe.skip;

d("cloud workspace endpoint grants", () => {
  let pool: pg.Pool;
  let organizationId: string;
  let workspaceId: string;
  let ownerId: string;

  const audience = "https://engine.example.test/workspaces/current";

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
    const subject = randomUUID();
    const owner = await ensureUser(pool, {
      provider: "auth0",
      providerSubject: subject,
      email: `grant-${subject}@example.test`,
      displayName: "Grant Owner",
    });
    ownerId = owner.id;
    const seeded = await withSystemTx(pool, async (tx) => {
      const org = await tx.query<{ id: string }>(
        `INSERT INTO organizations (
           slug, name, created_by, is_personal, cloud_workspaces_allowed
         ) VALUES ($1, 'Grant Org', $2, false, true) RETURNING id`,
        [`grant-${randomUUID()}`, owner.id],
      );
      const orgId = org.rows[0]!.id;
      await tx.query(
        `INSERT INTO organization_members (org_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [orgId, owner.id],
      );
      const team = await tx.query<{ id: string }>(
        `INSERT INTO teams (org_id, slug, name, is_default, created_by)
         VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
        [orgId, owner.id],
      );
      const teamId = team.rows[0]!.id;
      await tx.query(
        `INSERT INTO team_members (team_id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'maintainer')`,
        [teamId, orgId, owner.id],
      );
      const id = randomUUID();
      await tx.query(
        `INSERT INTO cloud_workspaces (
           id, org_id, team_id, created_by, display_name,
           repository_forge, repository_owner, repository_name,
           repository_revision, status, desired_state
         ) VALUES ($1, $2, $3, $4, 'Grant Workspace', 'github.com',
                   'withso', 'zeros', 'main', 'ready', 'running')`,
        [id, orgId, teamId, owner.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_generations (
           workspace_id, generation, org_id, provider, image_ref,
           architecture, cpu_millicores, memory_mib, storage_mib,
           source_commit, created_by
         ) VALUES ($1, 1, $2, 'daytona', 'snap-pinned', 'linux/amd64',
                   2000, 4096, 20480, $3, $4)`,
        [id, orgId, "a".repeat(40), owner.id],
      );
      await tx.query(
        `INSERT INTO cloud_workspace_provider_bindings (
           workspace_id, generation, org_id, provider,
           provider_resource_id, observed_state
         ) VALUES ($1, 1, $2, 'daytona', 'provider-grant-test', 'running')`,
        [id, orgId],
      );
      return { orgId, id };
    });
    organizationId = seeded.orgId;
    workspaceId = seeded.id;
  });

  const issue = () =>
    withSystemTx(pool, (tx) =>
      issueCloudWorkspaceGrant(tx, {
        workspaceId,
        generation: 1,
        organizationId,
        accountUserId: ownerId,
        purpose: "engine-connect",
        audience,
        ttlSeconds: 60,
        issuedBy: ownerId,
      }),
    );

  it("returns a one-time secret while storing only its digest under system RLS", async () => {
    const grant = await issue();
    expect(grant.token).toMatch(/^zws_[A-Za-z0-9_-]{43}$/);
    expect(grant.audience).toBe(audience);
    const stored = await pool.query<{
      digest: string;
      visible_text: string;
    }>(
      `SELECT encode(token_hash, 'hex') AS digest, row_to_json(g)::text AS visible_text
       FROM cloud_workspace_endpoint_grants g WHERE id = $1`,
      [grant.id],
    );
    expect(stored.rows[0]!.digest).toBe(
      createHash("sha256").update(grant.token).digest("hex"),
    );
    expect(stored.rows[0]!.visible_text).not.toContain(grant.token);

    await expect(
      withUserTx(pool, ownerId, (tx) =>
        issueCloudWorkspaceGrant(tx, {
          workspaceId,
          generation: 1,
          organizationId,
          accountUserId: ownerId,
          purpose: "engine-connect",
          audience,
          ttlSeconds: 60,
          issuedBy: ownerId,
        }),
      ),
    ).rejects.toMatchObject<Partial<CloudWorkspaceGrantError>>({
      code: "grant_system_context_required",
    });
    const hidden = await withUserTx(pool, ownerId, (tx) =>
      tx.query(`SELECT id FROM cloud_workspace_endpoint_grants WHERE id = $1`, [
        grant.id,
      ]),
    );
    expect(hidden.rowCount).toBe(0);
  });

  it("binds every claim and permits exactly one concurrent consumption", async () => {
    const grant = await issue();
    const mismatch = await withSystemTx(pool, (tx) =>
      consumeCloudWorkspaceGrant(tx, {
        token: grant.token,
        workspaceId,
        generation: 1,
        organizationId,
        accountUserId: ownerId,
        purpose: "engine-connect",
        audience: "https://other.example.test/",
      }),
    );
    expect(mismatch).toBeNull();

    const consume = () =>
      withSystemTx(pool, (tx) =>
        consumeCloudWorkspaceGrant(tx, {
          token: grant.token,
          workspaceId,
          generation: 1,
          organizationId,
          accountUserId: ownerId,
          purpose: "engine-connect",
          audience,
        }),
      );
    const results = await Promise.all([consume(), consume()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    await expect(consume()).resolves.toBeNull();
  });

  it("revokes an older unconsumed grant and rechecks lifecycle and membership", async () => {
    const first = await issue();
    const second = await issue();
    const rows = await pool.query<{
      id: string;
      revoked: boolean;
    }>(
      `SELECT id, revoked_at IS NOT NULL AS revoked
       FROM cloud_workspace_endpoint_grants WHERE id = ANY($1::uuid[])`,
      [[first.id, second.id]],
    );
    expect(
      Object.fromEntries(rows.rows.map((row) => [row.id, row.revoked])),
    ).toEqual({ [first.id]: true, [second.id]: false });

    await pool.query(
      `UPDATE cloud_workspaces SET status = 'stopped', desired_state = 'stopped'
       WHERE id = $1`,
      [workspaceId],
    );
    await expect(
      withSystemTx(pool, (tx) =>
        consumeCloudWorkspaceGrant(tx, {
          token: second.token,
          workspaceId,
          generation: 1,
          organizationId,
          accountUserId: ownerId,
          purpose: "engine-connect",
          audience,
        }),
      ),
    ).resolves.toBeNull();

    await pool.query(
      `UPDATE cloud_workspaces SET status = 'ready', desired_state = 'running'
       WHERE id = $1`,
      [workspaceId],
    );
    const third = await issue();
    await pool.query(
      `DELETE FROM team_members WHERE org_id = $1 AND user_id = $2`,
      [organizationId, ownerId],
    );
    await expect(
      withSystemTx(pool, (tx) =>
        consumeCloudWorkspaceGrant(tx, {
          token: third.token,
          workspaceId,
          generation: 1,
          organizationId,
          accountUserId: ownerId,
          purpose: "engine-connect",
          audience,
        }),
      ),
    ).resolves.toBeNull();
  });
});

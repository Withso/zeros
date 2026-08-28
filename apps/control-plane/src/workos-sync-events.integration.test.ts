import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureUser } from "./auth.js";
import { runMigrations } from "./migrate.js";
import {
  WorkOSEventsReconciler,
  ingestWorkOSManagementEvent,
} from "./workos-sync-events.js";
import type {
  WorkOSManagementEvent,
  WorkOSManagementProvider,
} from "./workos-provider.js";

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

function managementEvent(
  event: string,
  data: Record<string, unknown>,
  createdAt = new Date().toISOString(),
): WorkOSManagementEvent {
  return {
    id: `event_${randomUUID().replaceAll("-", "")}`,
    event,
    createdAt,
    data,
  };
}

d("WorkOS normalized event synchronization", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool);
  });

  afterAll(async () => pool.end());

  it("projects membership/role changes, rejects stale resurrection, and cuts only organization access", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_owner_${suffix}`,
      email: `owner-${suffix}@example.com`,
      displayName: "Owner",
    });
    const memberSubject = `user_member_${suffix}`;
    const member = await ensureUser(pool, {
      provider: "workos",
      providerSubject: memberSubject,
      email: `member-${suffix}@example.com`,
      displayName: "Member",
    });
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (
         slug, name, created_by, is_personal, cloud_workspaces_allowed
       ) VALUES ($1, 'Synced Organization', $2, false, true)
       RETURNING id`,
      [`synced-${suffix}`, owner.id],
    );
    const orgId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [orgId, owner.id],
    );
    const team = await pool.query<{ id: string }>(
      `INSERT INTO teams (org_id, slug, name, is_default, created_by)
       VALUES ($1, 'default', 'Default', true, $2) RETURNING id`,
      [orgId, owner.id],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'maintainer')`,
      [team.rows[0]!.id, orgId, owner.id],
    );
    const workosOrgId = `org_${suffix}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::text, 'active')`,
      [orgId, workosOrgId],
    );

    const membershipId = `om_${suffix}`;
    const createdAt = new Date(Date.now() + 1_000).toISOString();
    const created = managementEvent(
      "organization_membership.created",
      {
        id: membershipId,
        organizationId: workosOrgId,
        userId: memberSubject,
        status: "active",
        directoryManaged: false,
        role: { slug: "member" },
        updatedAt: createdAt,
      },
      createdAt,
    );
    expect(await ingestWorkOSManagementEvent(pool, created, "webhook")).toEqual({
      status: "applied",
    });
    expect(await ingestWorkOSManagementEvent(pool, created, "events_api")).toEqual({
      status: "duplicate",
    });

    const elevatedAt = new Date(Date.now() + 2_000).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.updated",
          {
            ...created.data,
            role: { slug: "admin" },
            updatedAt: elevatedAt,
          },
          elevatedAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "applied" });
    const membership = await pool.query(
      `SELECT role, workos_membership_id, authorization_revision
       FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(membership.rows[0]).toMatchObject({
      role: "admin",
      workos_membership_id: membershipId,
      authorization_revision: "2",
    });

    // An older active delivery cannot restore a later removed membership.
    const deletedAt = new Date(Date.now() + 3_000).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.deleted",
          { ...created.data, updatedAt: deletedAt },
          deletedAt,
        ),
        "events_api",
      ),
    ).toEqual({ status: "applied" });
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.updated",
          { ...created.data, updatedAt: createdAt },
          createdAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "ignored" });
    const removed = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(removed.rowCount).toBe(0);
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.updated",
          { ...created.data, updatedAt: deletedAt },
          new Date(Date.now() + 4_000).toISOString(),
        ),
        "webhook",
      ),
    ).toEqual({ status: "ignored" });
    const notResurrected = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(notResurrected.rowCount).toBe(0);
    const personal = await pool.query(
      `SELECT 1 FROM organization_members om
       JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = $1 AND o.is_personal`,
      [member.id],
    );
    expect(personal.rowCount).toBe(1);

    const beforeNoOp = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM security_events
       WHERE org_id = $1 AND kind = 'organization.data_changed'`,
      [orgId],
    );
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent("organization.updated", {
          id: workosOrgId,
          name: "Synced Organization",
          externalId: orgId,
          updatedAt: new Date(Date.now() + 5_000).toISOString(),
        }),
        "webhook",
      ),
    ).toEqual({ status: "applied" });
    const afterNoOp = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM security_events
       WHERE org_id = $1 AND kind = 'organization.data_changed'`,
      [orgId],
    );
    expect(afterNoOp.rows[0]?.count).toBe(beforeNoOp.rows[0]?.count);
  });

  it("persists a session tombstone before the client can present that sid", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_session_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: `session-${suffix}@example.com`,
      displayName: "Session User",
    });
    const sessionId = `session_${suffix}`;
    const updatedAt = new Date().toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent("session.revoked", {
          id: sessionId,
          userId: subject,
          status: "revoked",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          updatedAt,
        }),
        "webhook",
      ),
    ).toEqual({ status: "applied" });
    const tombstone = await pool.query(
      `SELECT user_id, status, client_kind, revocation_reason
       FROM auth_sessions WHERE provider_session_id = $1`,
      [sessionId],
    );
    expect(tombstone.rows[0]).toEqual({
      user_id: user.id,
      status: "revoked",
      client_kind: "unknown",
      revocation_reason: "workos_session_revoked",
    });
  });

  it("accepts the documented WorkOS session event shape without list-only fields", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_documented_session_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: `documented-session-${suffix}@example.com`,
      displayName: "Documented Session User",
    });
    const sessionId = `session_documented_${suffix}`;
    const updatedAt = new Date().toISOString();

    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent("session.revoked", {
          id: sessionId,
          userId: subject,
          updatedAt,
        }),
        "webhook",
      ),
    ).toEqual({ status: "applied" });

    const tombstone = await pool.query(
      `SELECT user_id, status, provider_session_expires_at
       FROM auth_sessions WHERE provider_session_id = $1`,
      [sessionId],
    );
    expect(tombstone.rows[0]).toEqual({
      user_id: user.id,
      status: "revoked",
      provider_session_expires_at: null,
    });
  });

  it("advances the ordered Events API cursor only after each event is durable", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_cursor_${suffix}`;
    await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: `cursor-${suffix}@example.com`,
      displayName: "Before",
    });
    const events = [
      managementEvent("user.updated", {
        id: subject,
        email: `cursor-${suffix}@example.com`,
        emailVerified: true,
        name: "After",
        profilePictureUrl: null,
        updatedAt: new Date().toISOString(),
      }),
    ];
    const provider = {
      async listEvents() {
        return { data: events, after: events[0]!.id };
      },
    } as unknown as WorkOSManagementProvider;
    expect(await new WorkOSEventsReconciler(pool, provider).tick()).toBe(1);
    const cursor = await pool.query(
      `SELECT cursor FROM workos_event_cursors WHERE stream = 'environment'`,
    );
    expect(cursor.rows[0]?.cursor).toBe(events[0]!.id);
  });

  it("quarantines a signed event with a changed payload shape and continues reconciliation", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_quarantine_${suffix}`;
    await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: `quarantine-${suffix}@example.com`,
      displayName: "Before quarantine",
    });
    const malformed = managementEvent("session.revoked", {
      id: `session_${suffix}`,
      userId: subject,
      // Deliberately omit updatedAt to model a forward-incompatible payload.
    });
    const valid = managementEvent("user.updated", {
      id: subject,
      email: `quarantine-${suffix}@example.com`,
      emailVerified: true,
      name: "After quarantine",
      profilePictureUrl: null,
      updatedAt: new Date().toISOString(),
    });
    const provider = {
      async listEvents() {
        return { data: [malformed, valid], after: valid.id };
      },
    } as unknown as WorkOSManagementProvider;

    expect(await new WorkOSEventsReconciler(pool, provider).tick()).toBe(2);
    const inbox = await pool.query(
      `SELECT event_id, state, last_error_code, data
       FROM workos_event_inbox
       WHERE event_id = ANY($1::text[]) ORDER BY event_created_at, event_id`,
      [[malformed.id, valid.id]],
    );
    expect(inbox.rows.find((row) => row.event_id === malformed.id)).toEqual({
      event_id: malformed.id,
      state: "quarantined",
      last_error_code: "invalid_payload",
      data: {},
    });
    expect(inbox.rows.find((row) => row.event_id === valid.id)?.state).toBe(
      "applied",
    );
    const cursor = await pool.query(
      `SELECT cursor FROM workos_event_cursors WHERE stream = 'environment'`,
    );
    expect(cursor.rows[0]?.cursor).toBe(valid.id);
  });

  it("quarantines an insecure provider avatar instead of storing it", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_avatar_${suffix}`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email: `avatar-${suffix}@example.com`,
      displayName: "Safe profile",
    });
    const result = await ingestWorkOSManagementEvent(
      pool,
      managementEvent("user.updated", {
        id: subject,
        email: `avatar-${suffix}@example.com`,
        emailVerified: true,
        name: "Unsafe profile",
        profilePictureUrl: "http://images.example.com/avatar.png",
        updatedAt: new Date().toISOString(),
      }),
      "webhook",
    );
    expect(result).toEqual({ status: "quarantined" });
    const stored = await pool.query(
      `SELECT display_name, avatar_url FROM users WHERE id = $1`,
      [user.id],
    );
    expect(stored.rows[0]).toEqual({
      display_name: "Safe profile",
      avatar_url: null,
    });
  });
});

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
import { workOSProviderSubjectHash } from "./workos-provider-locks.js";

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

  it("projects locally-authorized membership changes, rejects unsolicited access and stale resurrection", async () => {
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
    const scimSubject = `user_scim_${suffix}`;
    const scimMember = await ensureUser(pool, {
      provider: "workos",
      providerSubject: scimSubject,
      email: `scim-${suffix}@example.com`,
      displayName: "SCIM Member",
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
    expect(await ingestWorkOSManagementEvent(pool, created, "webhook")).toEqual(
      {
        status: "applied",
      },
    );
    expect(
      await ingestWorkOSManagementEvent(pool, created, "events_api"),
    ).toEqual({
      status: "duplicate",
    });
    const unsolicited = await pool.query(
      `SELECT 1 FROM organization_members WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(unsolicited.rowCount).toBe(0);
    const scimAt = new Date(Date.now() + 1_500).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.created",
          {
            id: `om_scim_${suffix}`,
            organizationId: workosOrgId,
            userId: scimSubject,
            status: "active",
            directoryManaged: true,
            role: { slug: "member" },
            updatedAt: scimAt,
          },
          scimAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "applied" });
    const provisionedScim = await pool.query<{ membership_source: string }>(
      `SELECT membership_source FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [orgId, scimMember.id],
    );
    expect(provisionedScim.rows).toEqual([{ membership_source: "scim" }]);
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [orgId, member.id],
    );
    await pool.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [team.rows[0]!.id, orgId, member.id],
    );

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

    const providerInvitationId = `inv_direct_${suffix}`;
    await pool.query(
      `INSERT INTO invitations (
         org_id, email, role, token_hash, invited_by,
         workos_invitation_id, invitation_source
       ) VALUES ($1, $2, 'member', decode($3, 'hex'), $4, $5, 'workos')`,
      [orgId, member.email, suffix, owner.id, providerInvitationId],
    );
    const providerAcceptedAt = new Date(Date.now() + 4_500).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "invitation.accepted",
          {
            id: providerInvitationId,
            organizationId: workosOrgId,
            email: member.email,
            state: "accepted",
            roleSlug: "member",
            acceptedAt: providerAcceptedAt,
            revokedAt: null,
            updatedAt: providerAcceptedAt,
          },
          providerAcceptedAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "applied" });
    const directAcceptance = await pool.query<{
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT accepted_at, revoked_at FROM invitations
       WHERE workos_invitation_id = $1`,
      [providerInvitationId],
    );
    expect(directAcceptance.rows[0]?.accepted_at).toBeNull();
    expect(directAcceptance.rows[0]?.revoked_at).not.toBeNull();

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

  it("does not let deletion of a replaced pending membership remove the active replacement", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_replacement_owner_${suffix}`,
      email: `replacement-owner-${suffix}@example.com`,
      displayName: "Replacement Owner",
    });
    const memberSubject = `user_replacement_member_${suffix}`;
    const member = await ensureUser(pool, {
      provider: "workos",
      providerSubject: memberSubject,
      email: `replacement-member-${suffix}@example.com`,
      displayName: "Replacement Member",
    });
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, created_by, is_personal)
       VALUES ($1, 'Replacement Organization', $2, false)
       RETURNING id`,
      [`replacement-${suffix}`, owner.id],
    );
    const orgId = organization.rows[0]!.id;
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [orgId, owner.id],
    );
    const workosOrgId = `org_replacement_${suffix}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::text, 'active')`,
      [orgId, workosOrgId],
    );
    const activeMembershipId = `om_active_${suffix}`;
    // Zeros has already authorized the member; the provider event converges
    // that desired state to the exact WorkOS membership object.
    await pool.query(
      `INSERT INTO organization_members (org_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [orgId, member.id],
    );
    const activeAt = new Date(Date.now() + 1_000).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.created",
          {
            id: activeMembershipId,
            organizationId: workosOrgId,
            userId: memberSubject,
            status: "active",
            directoryManaged: false,
            role: { slug: "member" },
            updatedAt: activeAt,
          },
          activeAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "applied" });

    const replacedPendingId = `om_pending_${suffix}`;
    const deletedAt = new Date(Date.now() + 2_000).toISOString();
    expect(
      await ingestWorkOSManagementEvent(
        pool,
        managementEvent(
          "organization_membership.deleted",
          {
            id: replacedPendingId,
            organizationId: workosOrgId,
            userId: memberSubject,
            status: "pending",
            directoryManaged: false,
            role: { slug: "member" },
            updatedAt: deletedAt,
          },
          deletedAt,
        ),
        "webhook",
      ),
    ).toEqual({ status: "applied" });

    const current = await pool.query<{ workos_membership_id: string | null }>(
      `SELECT workos_membership_id FROM organization_members
       WHERE org_id = $1 AND user_id = $2`,
      [orgId, member.id],
    );
    expect(current.rows[0]?.workos_membership_id).toBe(activeMembershipId);
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

  it("keeps delayed events behind durable provider-erasure fences", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_erased_${suffix}`;
    const email = `erased-${suffix}@example.com`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email,
      displayName: "Erased User",
    });
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_erased_org_owner_${suffix}`,
      email: `erased-org-owner-${suffix}@example.com`,
      displayName: "Erased Organization Owner",
    });
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, created_by, is_personal)
       VALUES ($1, 'Erased Organization', $2, false) RETURNING id`,
      [`erased-org-${suffix}`, owner.id],
    );
    const organizationId = organization.rows[0]!.id;
    const workosOrganizationId = `org_erased_${suffix}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::text, 'active')`,
      [organizationId, workosOrganizationId],
    );
    const survivingOrganization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, created_by, is_personal)
       VALUES ($1, 'Surviving Organization', $2, false) RETURNING id`,
      [`surviving-org-${suffix}`, owner.id],
    );
    const survivingWorkosOrganizationId = `org_surviving_${suffix}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::text, 'active')`,
      [survivingOrganization.rows[0]!.id, survivingWorkosOrganizationId],
    );

    const accountRequest = await pool.query<{ id: string }>(
      `INSERT INTO deletion_requests (
         public_code, target_kind, target_id, target_user_id, state,
         purge_started_at, next_attempt_at
       ) VALUES ($1, 'account', $2, $2, 'provider_deleting', now(), now())
       RETURNING id`,
      [`ZD-ERAS-USER`, user.id],
    );
    const organizationRequest = await pool.query<{ id: string }>(
      `INSERT INTO deletion_requests (
         public_code, target_kind, target_id, target_organization_id, state,
         purge_started_at, next_attempt_at
       ) VALUES ($1, 'organization', $2, $2, 'provider_deleting', now(), now())
       RETURNING id`,
      [`ZD-ERAS-ORGN`, organizationId],
    );
    await pool.query(
      `INSERT INTO deletion_request_events (
         deletion_request_id, action, metadata
       ) VALUES
         ($1, 'purge.provider_erasure_fenced', $3::jsonb),
         ($2, 'purge.provider_erasure_fenced', $4::jsonb)`,
      [
        accountRequest.rows[0]!.id,
        organizationRequest.rows[0]!.id,
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [
            workOSProviderSubjectHash({ kind: "user", id: subject }),
          ],
        }),
        JSON.stringify({
          provider: "workos",
          workosSubjectHashes: [
            workOSProviderSubjectHash({
              kind: "organization",
              id: workosOrganizationId,
            }),
          ],
        }),
      ],
    );
    await pool.query(
      `DELETE FROM user_identities
       WHERE provider = 'workos' AND provider_sub = $1`,
      [subject],
    );
    await pool.query(
      `DELETE FROM workos_organization_links WHERE organization_id = $1`,
      [organizationId],
    );

    const userEvent = managementEvent("user.updated", {
      id: subject,
      email,
      emailVerified: true,
      name: "Must Not Return",
      profilePictureUrl: "https://images.example.com/must-not-return.png",
      updatedAt: new Date().toISOString(),
    });
    const organizationEvent = managementEvent("organization.updated", {
      id: workosOrganizationId,
      name: "Must Not Return Organization",
      externalId: organizationId,
      updatedAt: new Date().toISOString(),
    });
    const sessionId = `session_erased_${suffix}`;
    const sessionEvent = managementEvent("session.created", {
      id: sessionId,
      userId: subject,
      status: "active",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const accountMembershipId = `membership_erased_user_${suffix}`;
    const accountMembershipEvent = managementEvent(
      "organization_membership.created",
      {
        id: accountMembershipId,
        organizationId: survivingWorkosOrganizationId,
        userId: subject,
        status: "active",
        directoryManaged: true,
        role: { slug: "member" },
        updatedAt: new Date().toISOString(),
      },
    );
    const organizationMembershipId = `membership_erased_org_${suffix}`;
    const organizationMembershipEvent = managementEvent(
      "organization_membership.created",
      {
        id: organizationMembershipId,
        organizationId: workosOrganizationId,
        userId: owner.identity.subject,
        status: "active",
        directoryManaged: true,
        role: { slug: "member" },
        updatedAt: new Date().toISOString(),
      },
    );
    const invitationEvent = managementEvent("invitation.created", {
      id: `invitation_erased_org_${suffix}`,
      organizationId: workosOrganizationId,
      email: `invitee-${suffix}@example.com`,
      state: "pending",
      roleSlug: "member",
      acceptedAt: null,
      revokedAt: null,
      updatedAt: new Date().toISOString(),
    });
    const fencedEvents = [
      userEvent,
      sessionEvent,
      accountMembershipEvent,
      organizationEvent,
      organizationMembershipEvent,
      invitationEvent,
    ];
    for (const [index, delayedEvent] of fencedEvents.entries()) {
      await expect(
        ingestWorkOSManagementEvent(
          pool,
          delayedEvent,
          index % 2 === 0 ? "webhook" : "events_api",
        ),
      ).resolves.toEqual({ status: "ignored" });
    }

    const inbox = await pool.query(
      `SELECT event_id, object_id, workos_organization_id, workos_user_id,
              data, state, last_error_code
       FROM workos_event_inbox WHERE event_id = ANY($1::text[])
       ORDER BY event_id`,
      [fencedEvents.map((event) => event.id)],
    );
    expect(inbox.rows).toHaveLength(fencedEvents.length);
    for (const row of inbox.rows) {
      expect(row).toMatchObject({
        object_id: null,
        workos_organization_id: null,
        workos_user_id: null,
        data: {},
        state: "ignored",
        last_error_code: "target_erasure_fenced",
      });
    }
    await expect(
      pool.query(`SELECT 1 FROM identity_provider_events WHERE event_id = $1`, [
        userEvent.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(`SELECT 1 FROM auth_sessions WHERE provider_session_id = $1`, [
        sessionId,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query(
        `SELECT 1 FROM workos_membership_projections
         WHERE workos_membership_id = ANY($1::text[])`,
        [[accountMembershipId, organizationMembershipId]],
      ),
    ).resolves.toMatchObject({ rowCount: 0 });

    const unrelatedSubject = `user_unrelated_${suffix}`;
    const unrelatedSessionId = `session_unrelated_${suffix}`;
    const unrelated = managementEvent("session.revoked", {
      id: unrelatedSessionId,
      userId: unrelatedSubject,
      status: "revoked",
      updatedAt: new Date().toISOString(),
    });
    await expect(
      ingestWorkOSManagementEvent(pool, unrelated, "webhook"),
    ).resolves.toEqual({ status: "applied" });
    await expect(
      pool.query(
        `SELECT provider_sub, status FROM auth_sessions
         WHERE provider_session_id = $1`,
        [unrelatedSessionId],
      ),
    ).resolves.toMatchObject({
      rows: [{ provider_sub: unrelatedSubject, status: "revoked" }],
    });
  });

  it("rechecks the erasure fence after waiting for an account purge lock", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const subject = `user_purge_race_${suffix}`;
    const email = `purge-race-${suffix}@example.com`;
    const user = await ensureUser(pool, {
      provider: "workos",
      providerSubject: subject,
      email,
      displayName: "Purge Race User",
    });
    const event = managementEvent("user.updated", {
      id: subject,
      email,
      emailVerified: true,
      name: "Must Not Reappear",
      profilePictureUrl: null,
      updatedAt: new Date().toISOString(),
    });
    const purge = await pool.connect();
    let ingestion: Promise<{ status: string }> | null = null;
    let settled = false;
    try {
      await purge.query(
        `SELECT pg_advisory_lock(
           hashtextextended('workos-provider-user:' || $1::text, 0)
         )`,
        [user.id],
      );
      ingestion = ingestWorkOSManagementEvent(pool, event, "webhook").finally(
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);

      await purge.query("BEGIN");
      const request = await purge.query<{ id: string }>(
        `INSERT INTO deletion_requests (
           public_code, target_kind, target_id, target_user_id, state,
           purge_started_at, next_attempt_at
         ) VALUES ('ZD-RACE-USER', 'account', $1, $1,
                   'provider_deleting', now(), now())
         RETURNING id`,
        [user.id],
      );
      await purge.query(
        `INSERT INTO deletion_request_events (
           deletion_request_id, action, metadata
         ) VALUES ($1, 'purge.provider_erasure_fenced', $2::jsonb)`,
        [
          request.rows[0]!.id,
          JSON.stringify({
            provider: "workos",
            workosSubjectHashes: [
              workOSProviderSubjectHash({ kind: "user", id: subject }),
            ],
          }),
        ],
      );
      await purge.query(
        `DELETE FROM identity_provider_events WHERE provider_sub = $1`,
        [subject],
      );
      await purge.query(
        `DELETE FROM workos_event_inbox WHERE workos_user_id = $1`,
        [subject],
      );
      await purge.query(
        `DELETE FROM user_identities
         WHERE provider = 'workos' AND provider_sub = $1`,
        [subject],
      );
      await purge.query("COMMIT");
    } finally {
      await purge.query("ROLLBACK").catch(() => undefined);
      await purge
        .query(
          `SELECT pg_advisory_unlock(
             hashtextextended('workos-provider-user:' || $1::text, 0)
           )`,
          [user.id],
        )
        .catch(() => undefined);
      purge.release();
    }
    await expect(ingestion).resolves.toEqual({ status: "ignored" });
    await expect(
      pool.query(
        `SELECT object_id, workos_user_id, data, state, last_error_code
         FROM workos_event_inbox WHERE event_id = $1`,
        [event.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          object_id: null,
          workos_user_id: null,
          data: {},
          state: "ignored",
          last_error_code: "target_erasure_fenced",
        },
      ],
    });
    await expect(
      pool.query(`SELECT 1 FROM identity_provider_events WHERE event_id = $1`, [
        event.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("locks the Organization before its WorkOS link so purge cannot deadlock an event", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const owner = await ensureUser(pool, {
      provider: "workos",
      providerSubject: `user_lock_order_${suffix}`,
      email: `lock-order-${suffix}@example.com`,
      displayName: "Lock Order Owner",
    });
    const organization = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, created_by, is_personal)
       VALUES ($1, 'Before Event', $2, false) RETURNING id`,
      [`lock-order-${suffix}`, owner.id],
    );
    const organizationId = organization.rows[0]!.id;
    const workosOrganizationId = `org_${suffix}`;
    await pool.query(
      `INSERT INTO workos_organization_links (
         organization_id, workos_organization_id, external_id, state
       ) VALUES ($1::uuid, $2, $1::text, 'active')`,
      [organizationId, workosOrganizationId],
    );
    const event = managementEvent("organization.updated", {
      id: workosOrganizationId,
      name: "After Event",
      externalId: organizationId,
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });

    const purge = await pool.connect();
    let ingestion: Promise<unknown> | null = null;
    try {
      await purge.query("BEGIN");
      await purge.query("SET LOCAL statement_timeout = '3s'");
      await purge.query(
        `SELECT id FROM organizations WHERE id = $1 FOR UPDATE`,
        [organizationId],
      );
      ingestion = ingestWorkOSManagementEvent(pool, event, "webhook");
      void ingestion.catch(() => undefined);

      let organizationWaitObserved = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE%'`,
        );
        if ((waiting.rowCount ?? 0) > 0) {
          organizationWaitObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(organizationWaitObserved).toBe(true);

      await expect(
        purge.query(
          `SELECT organization_id FROM workos_organization_links
           WHERE organization_id = $1 FOR UPDATE`,
          [organizationId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await purge.query("ROLLBACK");
      await expect(ingestion).resolves.toEqual({ status: "applied" });
    } finally {
      await purge.query("ROLLBACK").catch(() => undefined);
      await ingestion?.catch(() => undefined);
      purge.release();
    }
    await expect(
      pool.query(`SELECT name FROM organizations WHERE id = $1`, [
        organizationId,
      ]),
    ).resolves.toMatchObject({ rows: [{ name: "After Event" }] });
  });

  it("retries an unknown management event without persisting its raw payload while purge evidence is unresolved", async () => {
    const requestId = randomUUID();
    const workosOrganizationId = `org_pending_${randomUUID().replaceAll("-", "")}`;
    const event = managementEvent("organization.created", {
      id: workosOrganizationId,
      name: "Must Not Persist",
      externalId: null,
      updatedAt: new Date().toISOString(),
    });
    await pool.query(
      `INSERT INTO deletion_requests (
         id, public_code, target_kind, target_id, state, requested_at,
         purge_after, purge_started_at, purged_at
       ) VALUES ($1, 'ZD-MGMT-PEND', 'account', $1, 'purged',
                 '2025-01-01T00:00:00Z', '2025-01-31T00:00:00Z',
                 '2025-01-31T00:00:00Z', '2025-01-31T00:01:00Z')`,
      [requestId],
    );

    await expect(
      ingestWorkOSManagementEvent(pool, event, "webhook"),
    ).rejects.toMatchObject({
      status: 503,
      code: "workos_provider_erasure_reconciliation_pending",
    });
    await expect(
      pool.query(`SELECT 1 FROM workos_event_inbox WHERE event_id = $1`, [
        event.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 0 });

    await pool.query(
      `INSERT INTO workos_provider_erasure_reconciliations (
         deletion_request_id, disposition, evidence_source,
         evidence_reference
       ) VALUES ($1, 'no_workos_subject', 'operator_reconciliation',
                 'test:provider-audit-confirmed-local-only')`,
      [requestId],
    );
  });
});

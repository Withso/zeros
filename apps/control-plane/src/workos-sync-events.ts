import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";

import { withSystemTx, type Tx } from "./db.js";
import {
  applyWorkOSIdentityEventInTransaction,
  type WorkOSIdentityEvent,
} from "./workos-events.js";
import type {
  WorkOSManagementEvent,
  WorkOSManagementProvider,
} from "./workos-provider.js";
import {
  resolveWorkOSProviderLockKeys,
  withWorkOSProviderLocks,
  workOSProviderErasureFenceStatus,
  type WorkOSProviderSubject,
} from "./workos-provider-locks.js";
import { HttpError } from "./authz.js";

export const WORKOS_SYNC_EVENT_NAMES = [
  "user.created",
  "user.updated",
  "user.deleted",
  "session.created",
  "session.revoked",
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization_membership.created",
  "organization_membership.updated",
  "organization_membership.deleted",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "invitation.resent",
] as const;

type WorkOSSyncEventName = (typeof WORKOS_SYNC_EVENT_NAMES)[number];
type InboxState = "applied" | "ignored" | "quarantined";

const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const Timestamp = z.string().datetime({ offset: true });
const Uuid = z.string().uuid();
const Role = z.enum(["owner", "admin", "member"]);
const HttpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });

const UserData = z.object({
  id: Identifier,
  email: z.string().trim().toLowerCase().email().max(254),
  emailVerified: z.boolean(),
  name: z.string().max(500).nullable(),
  profilePictureUrl: HttpsUrl.nullable(),
  updatedAt: Timestamp,
});
const SessionData = z.object({
  id: Identifier,
  userId: Identifier,
  // WorkOS session webhooks contain the core session object but omit fields
  // such as status/expiresAt that are present on the list-sessions response.
  status: z.enum(["active", "expired", "revoked"]).optional(),
  expiresAt: Timestamp.optional(),
  updatedAt: Timestamp,
});
const OrganizationData = z.object({
  id: Identifier,
  name: z.string().trim().min(1).max(500),
  externalId: z.string().max(512).nullable(),
  updatedAt: Timestamp,
});
const MembershipData = z.object({
  id: Identifier,
  organizationId: Identifier,
  userId: Identifier,
  status: z.enum(["active", "inactive", "pending"]),
  directoryManaged: z.boolean().default(false),
  role: z.object({ slug: z.string().trim().min(1).max(100) }),
  updatedAt: Timestamp,
});
const InvitationData = z.object({
  id: Identifier,
  organizationId: Identifier.nullable(),
  email: z.string().trim().toLowerCase().email().max(254),
  state: z.enum(["pending", "accepted", "expired", "revoked"]),
  roleSlug: z.string().trim().min(1).max(100).nullable(),
  acceptedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
const EventEnvelope = z.object({
  id: Identifier,
  event: z.enum(WORKOS_SYNC_EVENT_NAMES),
  createdAt: Timestamp,
  data: z.record(z.string(), z.unknown()),
});

type NormalizedEvent = {
  id: string;
  event: WorkOSSyncEventName;
  createdAt: string;
  data: Record<string, unknown>;
  objectId: string | null;
  organizationId: string | null;
  userId: string | null;
};

export function normalizeWorkOSManagementEvent(
  input: WorkOSManagementEvent,
): NormalizedEvent | null {
  const base = EventEnvelope.safeParse(input);
  if (!base.success) return null;
  const value = base.data;
  let parsed:
    | z.infer<typeof UserData>
    | z.infer<typeof SessionData>
    | z.infer<typeof OrganizationData>
    | z.infer<typeof MembershipData>
    | z.infer<typeof InvitationData>;
  if (value.event.startsWith("user.")) {
    const result = UserData.safeParse(value.data);
    if (!result.success) return null;
    parsed = result.data;
  } else if (value.event.startsWith("session.")) {
    const result = SessionData.safeParse(value.data);
    if (!result.success) return null;
    parsed = result.data;
  } else if (value.event.startsWith("organization_membership.")) {
    const result = MembershipData.safeParse(value.data);
    if (!result.success) return null;
    parsed = result.data;
  } else if (value.event.startsWith("organization.")) {
    const result = OrganizationData.safeParse(value.data);
    if (!result.success) return null;
    parsed = result.data;
  } else {
    const result = InvitationData.safeParse(value.data);
    if (!result.success) return null;
    parsed = result.data;
  }

  const membership = "organizationId" in parsed ? parsed.organizationId : null;
  const userId = "userId" in parsed ? parsed.userId : null;
  return {
    id: value.id,
    event: value.event,
    createdAt: value.createdAt,
    data: parsed as unknown as Record<string, unknown>,
    objectId: parsed.id,
    organizationId: value.event.startsWith("organization.")
      ? parsed.id
      : typeof membership === "string"
        ? membership
        : null,
    userId: value.event.startsWith("user.")
      ? parsed.id
      : typeof userId === "string"
        ? userId
        : null,
  };
}

async function finishInbox(
  tx: Tx,
  eventId: string,
  state: InboxState,
  errorCode: string | null = null,
): Promise<{ status: InboxState }> {
  await tx.query(
    `UPDATE workos_event_inbox
     SET state = $2, processed_at = now(), last_error_code = $3,
         attempt_count = attempt_count + 1
     WHERE event_id = $1`,
    [eventId, state, errorCode],
  );
  return { status: state };
}

async function applyUserEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  if (event.event === "user.created") return "ignored";
  const user = UserData.parse(event.data);
  const identityEvent: WorkOSIdentityEvent = {
    eventId: event.id,
    eventType: event.event as "user.updated" | "user.deleted",
    createdAt: event.createdAt,
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      name: user.name,
      profilePictureUrl: user.profilePictureUrl,
    },
  };
  await applyWorkOSIdentityEventInTransaction(tx, identityEvent);
  return "applied";
}

async function applySessionEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  const session = SessionData.parse(event.data);
  const linked = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM user_identities
     WHERE provider = 'workos' AND provider_sub = $1 AND status = 'active'`,
    [session.userId],
  );
  const userId = linked.rows[0]?.user_id ?? null;
  if (event.event === "session.created") {
    await tx.query(
      `INSERT INTO auth_sessions (
         provider_session_id, provider_sub, user_id, client_kind, status,
         provider_session_expires_at, last_provider_event_at
       ) VALUES ($1, $2, $3, 'unknown', 'active', $4, $5)
       ON CONFLICT (provider, provider_session_id) DO UPDATE
       SET provider_sub = EXCLUDED.provider_sub,
           user_id = COALESCE(auth_sessions.user_id, EXCLUDED.user_id),
           provider_session_expires_at = EXCLUDED.provider_session_expires_at,
           last_provider_event_at = EXCLUDED.last_provider_event_at
       WHERE auth_sessions.status = 'active'
         AND COALESCE(auth_sessions.last_provider_event_at, '-infinity'::timestamptz)
             <= EXCLUDED.last_provider_event_at`,
      [
        session.id,
        session.userId,
        userId,
        session.expiresAt ?? null,
        event.createdAt,
      ],
    );
    return "applied";
  }

  await tx.query(
    `INSERT INTO auth_sessions (
       provider_session_id, provider_sub, user_id, client_kind, status,
       provider_session_expires_at, revoked_at, revocation_reason,
       last_provider_event_at
     ) VALUES (
       $1, $2, $3, 'unknown', 'revoked', $4, $5,
       'workos_session_revoked', $5
     )
     ON CONFLICT (provider, provider_session_id) DO UPDATE
     SET status = 'revoked', revoked_at = EXCLUDED.revoked_at,
         revocation_reason = EXCLUDED.revocation_reason,
         last_provider_event_at = EXCLUDED.last_provider_event_at,
         user_id = COALESCE(auth_sessions.user_id, EXCLUDED.user_id)
     WHERE COALESCE(auth_sessions.last_provider_event_at, '-infinity'::timestamptz)
           <= EXCLUDED.last_provider_event_at`,
    [
      session.id,
      session.userId,
      userId,
      session.expiresAt ?? null,
      event.createdAt,
    ],
  );
  await tx.query(
    `DELETE FROM workos_browser_sessions WHERE provider_session_id = $1`,
    [session.id],
  );
  if (userId) {
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, provider_session_id, payload
       ) VALUES (
         'session.revoked', $1, $2,
         jsonb_build_object('reason', 'workos_session_revoked')
       )`,
      [userId, session.id],
    );
  }
  return "applied";
}

async function linkedOrganization(
  tx: Tx,
  providerId: string,
  externalId: string | null,
): Promise<{
  organizationId: string;
  state: string;
  lastProviderEventAt: Date | null;
} | null> {
  const normalizedExternalId =
    externalId && Uuid.safeParse(externalId).success ? externalId : null;
  const discovered = await tx.query<{ organization_id: string }>(
    `SELECT organization_id
     FROM workos_organization_links
     WHERE workos_organization_id = $1
        OR ($2::uuid IS NOT NULL AND external_id = $2::text)
     ORDER BY workos_organization_id = $1 DESC
     LIMIT 1`,
    [providerId, normalizedExternalId],
  );
  const organizationId = discovered.rows[0]?.organization_id;
  if (!organizationId) return null;
  const organization = await tx.query(
    `SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`,
    [organizationId],
  );
  if (!organization.rows[0]) return null;
  const link = await tx.query<{
    organization_id: string;
    state: string;
    last_provider_event_at: Date | null;
  }>(
    `SELECT organization_id, state, last_provider_event_at
     FROM workos_organization_links
     WHERE organization_id = $3
       AND (workos_organization_id = $1
         OR ($2::uuid IS NOT NULL AND external_id = $2::text))
     ORDER BY workos_organization_id = $1 DESC
     LIMIT 1
     FOR UPDATE`,
    [providerId, normalizedExternalId, organizationId],
  );
  return link.rows[0]
    ? {
        organizationId: link.rows[0].organization_id,
        state: link.rows[0].state,
        lastProviderEventAt: link.rows[0].last_provider_event_at,
      }
    : null;
}

async function applyOrganizationEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  const organization = OrganizationData.parse(event.data);
  const link = await linkedOrganization(
    tx,
    organization.id,
    organization.externalId,
  );
  if (!link) return "ignored";
  if (link.state === "deleted" && event.event !== "organization.deleted") {
    return "ignored";
  }
  if (
    link.lastProviderEventAt &&
    link.lastProviderEventAt.getTime() > Date.parse(organization.updatedAt)
  ) {
    return "ignored";
  }
  if (event.event === "organization.deleted") {
    const affected = await tx.query<{ user_id: string }>(
      `SELECT user_id FROM organization_members WHERE org_id = $1`,
      [link.organizationId],
    );
    const deleted = await tx.query<{
      authorization_revision: string | number;
      data_revision: string | number;
    }>(
      `UPDATE organizations
       SET deleted_at = COALESCE(deleted_at, now()),
           lifecycle_status = CASE
             WHEN lifecycle_status = 'purging' THEN lifecycle_status
             ELSE 'provider_deleted'::organization_lifecycle_status
           END,
           authorization_revision = authorization_revision +
             CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END,
           data_revision = data_revision +
             CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END
       WHERE id = $1
       RETURNING authorization_revision, data_revision`,
      [link.organizationId],
    );
    await tx.query(
      `UPDATE workos_organization_links
       SET state = 'deleted', workos_organization_id = $2,
           last_provider_event_at = $3, updated_at = now()
       WHERE organization_id = $1`,
      [link.organizationId, organization.id, organization.updatedAt],
    );
    await tx.query(
      `UPDATE cloud_workspace_endpoint_grants
       SET revoked_at = COALESCE(revoked_at, now())
       WHERE org_id = $1 AND revoked_at IS NULL`,
      [link.organizationId],
    );
    await tx.query(
      `UPDATE invitations SET revoked_at = COALESCE(revoked_at, now())
       WHERE org_id = $1 AND accepted_at IS NULL`,
      [link.organizationId],
    );
    const revisions = deleted.rows[0];
    for (const member of affected.rows) {
      await tx.query(
        `INSERT INTO security_events (
           kind, user_id, org_id, authorization_revision,
           data_revision, payload
         ) VALUES (
           'organization.access_revoked', $1, $2, $3, $4,
           jsonb_build_object('reason', 'workos_organization_deleted')
         )`,
        [
          member.user_id,
          link.organizationId,
          Number(revisions?.authorization_revision ?? 1),
          Number(revisions?.data_revision ?? 1),
        ],
      );
    }
    return "applied";
  }

  const current = await tx.query<{
    name: string;
    data_revision: string | number;
  }>(
    `SELECT name, data_revision FROM organizations
     WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [link.organizationId],
  );
  const changed =
    current.rows[0] !== undefined && current.rows[0].name !== organization.name;
  const updated = changed
    ? await tx.query<{ data_revision: string | number }>(
        `UPDATE organizations
         SET name = $2, data_revision = data_revision + 1
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING data_revision`,
        [link.organizationId, organization.name],
      )
    : current;
  await tx.query(
    `UPDATE workos_organization_links
     SET workos_organization_id = $2, state = 'active',
         last_provider_event_at = $3, last_error_code = NULL,
         updated_at = now()
     WHERE organization_id = $1`,
    [link.organizationId, organization.id, organization.updatedAt],
  );
  if (changed && updated.rows[0]) {
    await tx.query(
      `INSERT INTO security_events (
         kind, org_id, data_revision, payload
       ) VALUES (
         'organization.data_changed', $1, $2,
         jsonb_build_object('reason', 'workos_organization_updated')
       )`,
      [link.organizationId, Number(updated.rows[0].data_revision)],
    );
  }
  return "applied";
}

async function removeLocalMembership(
  tx: Tx,
  input: {
    organizationId: string;
    userId: string;
    reason: string;
    workosMembershipId?: string | null;
  },
): Promise<void> {
  // A pending membership can be replaced by a new active WorkOS membership.
  // Do not let a delayed event for the old object revoke that replacement.
  // Rows without a provider ID remain fail-closed for compatibility.
  const removed = await tx.query(
    `DELETE FROM organization_members
     WHERE org_id = $1 AND user_id = $2
       AND (
         $3::text IS NULL OR workos_membership_id IS NULL
         OR workos_membership_id = $3
       )
     RETURNING user_id`,
    [input.organizationId, input.userId, input.workosMembershipId ?? null],
  );
  if (!removed.rows[0]) return;
  const revision = await tx.query<{ authorization_revision: string | number }>(
    `UPDATE organizations
     SET authorization_revision = authorization_revision + 1
     WHERE id = $1 RETURNING authorization_revision`,
    [input.organizationId],
  );
  await tx.query(
    `UPDATE cloud_workspace_endpoint_grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE org_id = $1 AND account_user_id = $2 AND revoked_at IS NULL`,
    [input.organizationId, input.userId],
  );
  await tx.query(
    `INSERT INTO security_events (
       kind, user_id, org_id, authorization_revision, payload
     ) VALUES (
       'organization.access_revoked', $1, $2, $3,
       jsonb_build_object('reason', $4::text)
     )`,
    [
      input.userId,
      input.organizationId,
      Number(revision.rows[0]?.authorization_revision ?? 1),
      input.reason,
    ],
  );
}

async function applyMembershipEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  const membership = MembershipData.parse(event.data);
  const role = Role.safeParse(membership.role.slug);
  if (!role.success) return "quarantined";
  const link = await linkedOrganization(tx, membership.organizationId, null);
  const organizationId = link?.organizationId ?? null;
  if (!organizationId || !link) return "ignored";
  const identity = await tx.query<{ user_id: string }>(
    `SELECT ui.user_id
     FROM user_identities ui
     JOIN users u ON u.id = ui.user_id
     WHERE ui.provider = 'workos' AND ui.provider_sub = $1
       AND ui.status = 'active' AND u.auth_status = 'active'
       AND u.deleted_at IS NULL`,
    [membership.userId],
  );
  const userId = identity.rows[0]?.user_id ?? null;
  const status =
    event.event === "organization_membership.deleted"
      ? "deleted"
      : membership.status;
  const projected = await tx.query(
    `INSERT INTO workos_membership_projections (
       workos_membership_id, workos_organization_id, workos_user_id,
       organization_id, user_id, status, role, directory_managed,
       last_provider_event_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workos_membership_id) DO UPDATE
     SET workos_organization_id = EXCLUDED.workos_organization_id,
         workos_user_id = EXCLUDED.workos_user_id,
         organization_id = EXCLUDED.organization_id,
         user_id = COALESCE(EXCLUDED.user_id, workos_membership_projections.user_id),
         status = EXCLUDED.status, role = EXCLUDED.role,
         directory_managed = EXCLUDED.directory_managed,
         last_provider_event_at = EXCLUDED.last_provider_event_at,
         updated_at = now()
     WHERE workos_membership_projections.last_provider_event_at
           <= EXCLUDED.last_provider_event_at
       AND (
         workos_membership_projections.status <> 'deleted'
         OR EXCLUDED.status = 'deleted'
       )
     RETURNING workos_membership_id`,
    [
      membership.id,
      membership.organizationId,
      membership.userId,
      organizationId,
      userId,
      status,
      role.data,
      membership.directoryManaged,
      membership.updatedAt,
    ],
  );
  if (!projected.rows[0]) return "ignored";
  if (!userId) return "applied";

  // Zeros mutations are committed locally before the provider command runs.
  // A webhook emitted for the provider's previous state can therefore arrive
  // while that command is queued or in flight. Keep the provider projection,
  // but do not let that stale delivery overwrite the locally enforced desired
  // state. Command completion records the provider's authoritative result (or
  // a terminal deletion tombstone) before later events are materialized.
  const desiredStatePending = await tx.query(
    `SELECT 1 FROM workos_command_outbox
     WHERE organization_id = $1 AND user_id = $2
       AND operation IN (
         'membership.create', 'membership.update', 'membership.delete'
       )
       AND state IN ('queued', 'processing')
     LIMIT 1`,
    [organizationId, userId],
  );
  if (desiredStatePending.rows[0]) return "applied";

  if (status !== "active" || link.state !== "active") {
    await removeLocalMembership(tx, {
      organizationId,
      userId,
      workosMembershipId: membership.id,
      reason:
        status === "inactive"
          ? "workos_membership_inactive"
          : "workos_membership_deleted",
    });
    return "applied";
  }

  const current = await tx.query<{
    role: "owner" | "admin" | "member";
    workos_membership_id: string | null;
  }>(
    `SELECT role, workos_membership_id FROM organization_members
     WHERE org_id = $1 AND user_id = $2 FOR UPDATE`,
    [organizationId, userId],
  );
  // A provider-side non-directory membership is not, by itself, a Zeros
  // product authorization grant. Normal Zeros organization creation and
  // invitation acceptance commit the local desired membership before the
  // WorkOS command runs, so legitimate convergence always has this row.
  // Refusing unsolicited materialization closes direct Dashboard/AuthKit
  // invitation acceptance (including WorkOS' corporate-domain allowance)
  // while preserving explicit SCIM provisioning for the enterprise path.
  if (!current.rows[0] && !membership.directoryManaged) return "applied";
  const changed =
    !current.rows[0] ||
    current.rows[0].role !== role.data ||
    current.rows[0].workos_membership_id !== membership.id;
  await tx.query(
    `INSERT INTO organization_members (
       org_id, user_id, role, workos_membership_id, membership_source
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, user_id) DO UPDATE
     SET role = EXCLUDED.role,
         workos_membership_id = EXCLUDED.workos_membership_id,
         membership_source = EXCLUDED.membership_source,
         authorization_revision = organization_members.authorization_revision +
           CASE WHEN organization_members.role IS DISTINCT FROM EXCLUDED.role
                  OR organization_members.workos_membership_id IS DISTINCT FROM EXCLUDED.workos_membership_id
                THEN 1 ELSE 0 END`,
    [
      organizationId,
      userId,
      role.data,
      membership.id,
      membership.directoryManaged ? "scim" : "workos",
    ],
  );
  await tx.query(
    `INSERT INTO team_members (team_id, org_id, user_id, role)
     SELECT t.id, t.org_id, $2,
            CASE WHEN $3 IN ('owner', 'admin')
                 THEN 'maintainer'::team_role ELSE 'member'::team_role END
     FROM teams t
     WHERE t.org_id = $1 AND t.is_default AND t.deleted_at IS NULL
     ON CONFLICT (team_id, user_id) DO UPDATE
     SET role = EXCLUDED.role`,
    [organizationId, userId, role.data],
  );
  if (changed) {
    const revision = await tx.query<{
      authorization_revision: string | number;
    }>(
      `UPDATE organizations
       SET authorization_revision = authorization_revision + 1
       WHERE id = $1 RETURNING authorization_revision`,
      [organizationId],
    );
    await tx.query(
      `INSERT INTO security_events (
         kind, user_id, org_id, authorization_revision, payload
       ) VALUES (
         'organization.authorization_changed', $1, $2, $3,
         jsonb_build_object('reason', 'workos_membership_changed')
       )`,
      [
        userId,
        organizationId,
        Number(revision.rows[0]?.authorization_revision ?? 1),
      ],
    );
  }
  return "applied";
}

async function applyInvitationEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  const invitation = InvitationData.parse(event.data);
  if (!invitation.organizationId) return "ignored";
  const link = await tx.query<{ organization_id: string }>(
    `SELECT organization_id FROM workos_organization_links
     WHERE workos_organization_id = $1`,
    [invitation.organizationId],
  );
  const organizationId = link.rows[0]?.organization_id;
  if (!organizationId) return "ignored";
  const matched = await tx.query<{ id: string }>(
    `SELECT id FROM invitations
     WHERE org_id = $1 AND workos_invitation_id = $2
     LIMIT 1 FOR UPDATE`,
    [organizationId, invitation.id],
  );
  // Email is not a provider-side correlation key. In particular, a delayed
  // event for a revoked invitation must never attach itself to a replacement
  // invitation for the same address. The command processor owns correlation:
  // it records the exact WorkOS ID returned by sendInvitation, or recovers that
  // exact pending object by listing WorkOS before retrying a lost response.
  if (!matched.rows[0]) return "ignored";
  await tx.query(
    `UPDATE invitations
     SET workos_invitation_id = $2, invitation_source = 'workos',
         workos_updated_at = $3,
         revoked_at = CASE
           WHEN $4 IN ('revoked', 'expired')
             THEN COALESCE(revoked_at, $6::timestamptz, now())
           WHEN $4 = 'accepted' AND accepted_at IS NULL
             THEN COALESCE(revoked_at, $5::timestamptz, now())
           ELSE revoked_at
         END
     WHERE id = $1
       AND (workos_updated_at IS NULL OR workos_updated_at <= $3::timestamptz)`,
    [
      matched.rows[0].id,
      invitation.id,
      invitation.updatedAt,
      invitation.state,
      invitation.acceptedAt,
      invitation.revokedAt,
    ],
  );
  return "applied";
}

/**
 * Repair the narrow provider-correlation race for invitations.
 *
 * WorkOS can publish an invitation event after accepting the API mutation but
 * before the outbox transaction has persisted the returned invitation ID. We
 * deliberately refuse to correlate that event by email, so its first delivery
 * is recorded as ignored. Once the command owns the exact provider ID, replay
 * only those durable exact-object events in provider order. This keeps the
 * anti-takeover correlation rule without losing a fast acceptance/revocation.
 */
export async function replayDeferredWorkOSInvitationEvents(
  tx: Tx,
  providerInvitationId: string,
): Promise<number> {
  const deferred = await tx.query<{
    event_id: string;
    event_type: WorkOSSyncEventName;
    event_created_at: Date;
    data: Record<string, unknown>;
  }>(
    `SELECT event_id, event_type, event_created_at, data
     FROM workos_event_inbox
     WHERE object_id = $1
       AND event_type IN (
         'invitation.created', 'invitation.accepted',
         'invitation.revoked', 'invitation.resent'
       )
       AND state = 'ignored'
     ORDER BY event_created_at, event_id
     FOR UPDATE`,
    [providerInvitationId],
  );
  let applied = 0;
  for (const row of deferred.rows) {
    const invitation = InvitationData.safeParse(row.data);
    if (!invitation.success) continue;
    const event: NormalizedEvent = {
      id: row.event_id,
      event: row.event_type,
      createdAt: row.event_created_at.toISOString(),
      data: invitation.data as unknown as Record<string, unknown>,
      objectId: invitation.data.id,
      organizationId: invitation.data.organizationId,
      userId: null,
    };
    if ((await applyInvitationEvent(tx, event)) !== "applied") continue;
    await finishInbox(tx, row.event_id, "applied");
    applied += 1;
  }
  return applied;
}

async function applyNormalizedEvent(
  tx: Tx,
  event: NormalizedEvent,
): Promise<InboxState> {
  if (event.event.startsWith("user.")) return applyUserEvent(tx, event);
  if (event.event.startsWith("session.")) return applySessionEvent(tx, event);
  if (event.event.startsWith("organization_membership.")) {
    return applyMembershipEvent(tx, event);
  }
  if (event.event.startsWith("organization.")) {
    return applyOrganizationEvent(tx, event);
  }
  return applyInvitationEvent(tx, event);
}

function providerSubjects(event: NormalizedEvent): WorkOSProviderSubject[] {
  return [
    ...(event.userId ? [{ kind: "user" as const, id: event.userId }] : []),
    ...(event.organizationId
      ? [{ kind: "organization" as const, id: event.organizationId }]
      : []),
  ];
}

async function recordErasureFencedEvent(
  tx: Tx,
  event: NormalizedEvent,
  source: "webhook" | "events_api",
): Promise<{ status: InboxState | "duplicate" }> {
  const inserted = await tx.query(
    `INSERT INTO workos_event_inbox (
       event_id, event_type, event_created_at, source, data, state,
       attempt_count, last_error_code, processed_at
     ) VALUES (
       $1, $2, $3, $4, '{}'::jsonb, 'ignored', 1,
       'target_erasure_fenced', now()
     )
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.id, event.event, event.createdAt, source],
  );
  return inserted.rows[0] ? { status: "ignored" } : { status: "duplicate" };
}

export async function ingestWorkOSManagementEvent(
  pool: pg.Pool,
  input: WorkOSManagementEvent,
  source: "webhook" | "events_api",
): Promise<{ status: InboxState | "duplicate" | "invalid" }> {
  const event = normalizeWorkOSManagementEvent(input);
  if (!event) {
    const envelope = EventEnvelope.safeParse(input);
    if (!envelope.success) return { status: "invalid" };
    return withSystemTx(pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO workos_event_inbox (
           event_id, event_type, event_created_at, source, data, state,
           attempt_count, last_error_code, processed_at
         ) VALUES (
           $1, $2, $3, $4, '{}'::jsonb, 'quarantined', 1,
           'invalid_payload', now()
         )
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          envelope.data.id,
          envelope.data.event,
          envelope.data.createdAt,
          source,
        ],
      );
      return inserted.rows[0]
        ? { status: "quarantined" as const }
        : { status: "duplicate" as const };
    });
  }
  const subjects = providerSubjects(event);
  const organizationExternalIds = event.event.startsWith("organization.")
    ? [OrganizationData.parse(event.data).externalId].filter(
        (value): value is string => value !== null,
      )
    : [];
  const lockKeys = await resolveWorkOSProviderLockKeys(pool, {
    userIds: event.userId ? [event.userId] : [],
    organizationIds: event.organizationId ? [event.organizationId] : [],
    organizationExternalIds,
  });
  return withWorkOSProviderLocks(pool, lockKeys, () =>
    withSystemTx(pool, async (tx) => {
      const fenceStatus = await workOSProviderErasureFenceStatus(tx, subjects);
      if (fenceStatus === "not_ready") {
        throw new HttpError(
          503,
          "workos_provider_erasure_reconciliation_pending",
          "WorkOS event ingestion is temporarily unavailable.",
        );
      }
      if (fenceStatus === "fenced") {
        return recordErasureFencedEvent(tx, event, source);
      }
      const inserted = await tx.query(
        `INSERT INTO workos_event_inbox (
           event_id, event_type, event_created_at, source, object_id,
           workos_organization_id, workos_user_id, data
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING event_id`,
        [
          event.id,
          event.event,
          event.createdAt,
          source,
          event.objectId,
          event.organizationId,
          event.userId,
          JSON.stringify(event.data),
        ],
      );
      if (!inserted.rows[0]) return { status: "duplicate" as const };
      try {
        const state = await applyNormalizedEvent(tx, event);
        return finishInbox(
          tx,
          event.id,
          state,
          state === "quarantined" ? "unsupported_role" : null,
        );
      } catch (error) {
        // The transaction intentionally rolls back so Events API reconciliation
        // can retry without advancing its cursor. Never persist raw errors.
        throw error;
      }
    }),
  );
}

/** Materialize SCIM/SSO membership projections that arrived before a user's
 * first Zeros authentication. Personal is deliberately unrelated to WorkOS. */
export async function materializeProjectedMemberships(
  tx: Tx,
  userId: string,
  workosUserId: string,
): Promise<void> {
  const projections = await tx.query<{
    organization_id: string;
    workos_membership_id: string;
    role: "owner" | "admin" | "member";
    directory_managed: boolean;
  }>(
    `UPDATE workos_membership_projections
     SET user_id = $1, updated_at = now()
     WHERE workos_user_id = $2 AND status = 'active'
     RETURNING organization_id, workos_membership_id, role, directory_managed`,
    [userId, workosUserId],
  );
  for (const projection of projections.rows) {
    if (!projection.organization_id) continue;
    const active = await tx.query(
      `SELECT 1
       FROM workos_organization_links wol
       JOIN organizations o ON o.id = wol.organization_id
       WHERE wol.organization_id = $1 AND wol.state = 'active'
         AND o.deleted_at IS NULL AND NOT o.is_personal`,
      [projection.organization_id],
    );
    if (!active.rows[0]) continue;
    await tx.query(
      `INSERT INTO organization_members (
         org_id, user_id, role, workos_membership_id, membership_source
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           workos_membership_id = EXCLUDED.workos_membership_id,
           membership_source = EXCLUDED.membership_source`,
      [
        projection.organization_id,
        userId,
        projection.role,
        projection.workos_membership_id,
        projection.directory_managed ? "scim" : "workos",
      ],
    );
    await tx.query(
      `INSERT INTO team_members (team_id, org_id, user_id, role)
       SELECT t.id, t.org_id, $2,
              CASE WHEN $3 IN ('owner', 'admin')
                   THEN 'maintainer'::team_role ELSE 'member'::team_role END
       FROM teams t
       WHERE t.org_id = $1 AND t.is_default AND t.deleted_at IS NULL
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projection.organization_id, userId, projection.role],
    );
  }
}

export class WorkOSEventsReconciler {
  constructor(
    private readonly pool: pg.Pool,
    private readonly provider: WorkOSManagementProvider,
  ) {}

  async tick(): Promise<number> {
    const cursor = await withSystemTx(this.pool, async (tx) => {
      const result = await tx.query<{ cursor: string | null }>(
        `SELECT cursor FROM workos_event_cursors
         WHERE stream = 'environment' FOR UPDATE`,
      );
      return result.rows[0]?.cursor ?? null;
    });
    const page = await this.provider.listEvents({
      events: [...WORKOS_SYNC_EVENT_NAMES],
      ...(cursor ? { after: cursor } : {}),
      limit: 100,
    });
    let processed = 0;
    for (const event of page.data) {
      const result = await ingestWorkOSManagementEvent(
        this.pool,
        event,
        "events_api",
      );
      if (result.status === "invalid") {
        throw new Error(
          "WorkOS Events API returned an invalid subscribed event",
        );
      }
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE workos_event_cursors
           SET cursor = $1, last_event_created_at = $2, updated_at = now()
           WHERE stream = 'environment'`,
          [event.id, event.createdAt],
        ),
      );
      processed += 1;
    }
    return processed;
  }
}

const MAX_WEBHOOK_BYTES = 64 * 1024;

async function boundedWebhookBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function webhookJson(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", pragma: "no-cache" },
  });
}

/** Official WorkOS SDK verification over the exact bounded body. Webhooks are
 * the low-latency path; the ordered Events API reconciler is the durable path. */
export function createWorkOSManagementEventRoutes(
  pool: pg.Pool,
  provider: WorkOSManagementProvider,
  webhookSecret: string,
): Hono {
  const app = new Hono();
  app.post("/auth/workos-webhook", async (c) => {
    const payload = await boundedWebhookBody(c.req.raw);
    if (payload === null) return webhookJson({ error: "body_too_large" }, 413);
    let event: WorkOSManagementEvent;
    try {
      event = await provider.constructWebhookEvent(
        payload,
        c.req.header("workos-signature") ?? "",
        webhookSecret,
      );
    } catch {
      return webhookJson({ error: "invalid_signature" }, 401);
    }
    if (
      !WORKOS_SYNC_EVENT_NAMES.includes(
        event.event as (typeof WORKOS_SYNC_EVENT_NAMES)[number],
      )
    ) {
      return webhookJson({ accepted: true, ignored: true }, 200);
    }
    let result: Awaited<ReturnType<typeof ingestWorkOSManagementEvent>>;
    try {
      result = await ingestWorkOSManagementEvent(pool, event, "webhook");
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "workos_provider_erasure_reconciliation_pending"
      ) {
        return webhookJson({ error: error.code }, 503);
      }
      throw error;
    }
    if (result.status === "invalid") {
      return webhookJson({ error: "invalid_event" }, 400);
    }
    return webhookJson({ accepted: true, status: result.status }, 200);
  });
  return app;
}

// Pro organization seats. Every collaborative organization admits at most
// PRO_ORGANIZATION_MEMBER_LIMIT members (owner included) plus pending
// invitations, and at most PRO_ORGANIZATION_FREE_MEMBER_LIMIT active members
// without Pro. Members without Pro beyond that allowance are on Hold. Seats are
// computed in SQL (migration 0216) so HTTP routes and cloud authority agree.
// Seat reads cross accounts, so they run only in a system transaction, after
// the caller has authorized the actor; elsewhere the SQL raises.

import { HttpError } from "./authz.js";
import type { Tx } from "./db.js";

export const PRO_ORGANIZATION_MEMBER_LIMIT = 10;
export const PRO_ORGANIZATION_FREE_MEMBER_LIMIT = 5;

export type OrganizationSeat = "pro" | "free" | "hold";

export interface OrganizationSeatUsage {
  members: number;
  pendingInvitations: number;
  freeMembers: number;
  heldMembers: number;
  memberLimit: number;
  freeMemberLimit: number;
}

const LIMITS = `${PRO_ORGANIZATION_MEMBER_LIMIT}, ${PRO_ORGANIZATION_FREE_MEMBER_LIMIT}`;

/** SQL predicate: the member is on Hold. Arguments are SQL expressions. */
export function memberOnHoldSql(organizationId: string, userId: string): string {
  return `organization_member_on_hold(${organizationId}, ${userId}, ${LIMITS})`;
}

export function memberNotOnHoldSql(organizationId: string, userId: string): string {
  return `NOT ${memberOnHoldSql(organizationId, userId)}`;
}

export function organizationMemberOnHold(): HttpError {
  return new HttpError(
    403,
    "organization_member_on_hold",
    "You're on Hold in this organization. Get Pro, or ask an owner to free a seat.",
  );
}

export async function accountProActive(tx: Tx, userId: string): Promise<boolean> {
  const { rows } = await tx.query<{ pro: boolean }>(
    "SELECT account_pro_active($1) AS pro",
    [userId],
  );
  return rows[0]?.pro === true;
}

export async function organizationMemberSeats(
  tx: Tx,
  organizationId: string,
): Promise<Map<string, OrganizationSeat>> {
  const { rows } = await tx.query<{ user_id: string; seat: OrganizationSeat }>(
    `SELECT user_id, seat FROM organization_member_seats($1, ${LIMITS})`,
    [organizationId],
  );
  return new Map(rows.map((row) => [row.user_id, row.seat]));
}

/** One member's seat in each organization, in a single statement. */
export async function memberSeatsAcross(
  tx: Tx,
  userId: string,
  organizationIds: readonly string[],
): Promise<Map<string, OrganizationSeat>> {
  if (!organizationIds.length) return new Map();
  const { rows } = await tx.query<{ org_id: string; seat: OrganizationSeat }>(
    `SELECT o.id AS org_id, s.seat
     FROM unnest($2::uuid[]) AS o(id)
     CROSS JOIN LATERAL organization_member_seats(o.id, ${LIMITS}) s
     WHERE s.user_id = $1`,
    [userId, organizationIds],
  );
  return new Map(rows.map((row) => [row.org_id, row.seat]));
}

/** Pending invitations reserve a seat until accepted, revoked or expired. */
export async function organizationSeats(
  tx: Tx,
  organizationId: string,
): Promise<{ seats: Map<string, OrganizationSeat>; usage: OrganizationSeatUsage }> {
  const seats = await organizationMemberSeats(tx, organizationId);
  const pending = await tx.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM invitations
     WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [organizationId],
  );
  const values = [...seats.values()];
  return {
    seats,
    usage: {
      members: seats.size,
      pendingInvitations: pending.rows[0]?.count ?? 0,
      freeMembers: values.filter((seat) => seat === "free").length,
      heldMembers: values.filter((seat) => seat === "hold").length,
      memberLimit: PRO_ORGANIZATION_MEMBER_LIMIT,
      freeMemberLimit: PRO_ORGANIZATION_FREE_MEMBER_LIMIT,
    },
  };
}

/** Run with the organization row locked, after superseded invitations are revoked. */
export async function assertInvitationCapacity(tx: Tx, organizationId: string): Promise<void> {
  const { usage } = await organizationSeats(tx, organizationId);
  if (usage.members + usage.pendingInvitations >= PRO_ORGANIZATION_MEMBER_LIMIT) {
    throw new HttpError(
      409,
      "organization_member_limit",
      `This organization already has ${PRO_ORGANIZATION_MEMBER_LIMIT} members and pending invitations`,
    );
  }
}

/** Run with the organization row locked, before inserting a new membership. */
export async function assertJoinCapacity(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<void> {
  const { usage } = await organizationSeats(tx, organizationId);
  if (usage.members >= PRO_ORGANIZATION_MEMBER_LIMIT) {
    throw new HttpError(
      409,
      "organization_member_limit",
      `This organization already has ${PRO_ORGANIZATION_MEMBER_LIMIT} members`,
    );
  }
  if (usage.freeMembers >= PRO_ORGANIZATION_FREE_MEMBER_LIMIT && !(await accountProActive(tx, userId))) {
    throw new HttpError(
      409,
      "organization_free_member_limit",
      `This organization's ${PRO_ORGANIZATION_FREE_MEMBER_LIMIT} free seats are taken. Join with Pro, or ask an owner to free a seat.`,
    );
  }
}

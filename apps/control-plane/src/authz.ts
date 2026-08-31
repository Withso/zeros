// ──────────────────────────────────────────────────────────
// Authorization spine — ONE helper, used by every organization-scoped route.
// Role is looked up in Postgres on every request (never trusted from
// the client, never baked into the JWT — revocation must be instant).
// ──────────────────────────────────────────────────────────

import type { Tx } from "./db.js";

export type OrganizationRole = "owner" | "admin" | "member";
/** Released clients still call this role TeamRole. The values were always
 * tenant-wide; keep the source alias until the legacy `/v1/teams` API retires. */
export type TeamRole = OrganizationRole;

const ROLE_RANK: Record<OrganizationRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export function roleAtLeast(
  role: OrganizationRole,
  min: OrganizationRole,
): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Staff role — product-wide, NOT team-scoped, and deliberately NOT ranked
 *  against OrganizationRole (see migrations 0007/0009 for why the
 *  two must not share an axis). null ⇒ not staff. */
export type StaffRole = "developer" | "support_admin";

export class HttpError extends Error {
  constructor(
    public status:
      | 400
      | 401
      | 403
      | 404
      | 409
      | 411
      | 413
      | 415
      | 422
      | 429
      | 502
      | 503,
    public code: string,
    message: string,
    /** Bounded, deliberately non-secret machine-readable recovery context. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Load the acting user's role in an organization; 404 (not 403) when the
 * organization is invisible to them — don't leak tenant ids. */
export async function requireOrganizationMembership(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<OrganizationRole> {
  const { rows } = await tx.query<{ role: OrganizationRole }>(
    `SELECT om.role
     FROM organization_members om
     JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL
     WHERE om.org_id = $1 AND om.user_id = $2`,
    [orgId, userId],
  );
  const role = rows[0]?.role;
  if (!role) throw new HttpError(404, "not_found", "Organization not found");
  return role;
}

export async function requireOrganizationRole(
  tx: Tx,
  orgId: string,
  userId: string,
  min: OrganizationRole,
): Promise<OrganizationRole> {
  const role = await requireOrganizationMembership(tx, orgId, userId);
  if (!roleAtLeast(role, min)) {
    throw new HttpError(403, "forbidden", `Requires ${min} role`);
  }
  return role;
}

/** Compatibility aliases for modules shipped during the flat-Team era. */
export const requireMembership = requireOrganizationMembership;
export const requireRole = requireOrganizationRole;

/** Require one exact product-wide capability. Staff roles are deliberately
 * not ranked: developer tooling and support account recovery are different
 * trust domains, so possession of either must never imply the other. */
export function requireStaffRole(
  staffRole: StaffRole | null,
  required: StaffRole,
): StaffRole {
  if (staffRole !== required) {
    throw new HttpError(404, "not_found", "Not found");
  }
  return staffRole;
}

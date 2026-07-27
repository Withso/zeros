// ──────────────────────────────────────────────────────────
// Authorization spine — ONE helper, used by every team-scoped route.
// Role is looked up in Postgres on every request (never trusted from
// the client, never baked into the JWT — revocation must be instant).
// ──────────────────────────────────────────────────────────

import type { Tx } from "./db.js";

export type TeamRole = "owner" | "admin" | "member";

const ROLE_RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(role: TeamRole, min: TeamRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Staff role — product-wide, NOT team-scoped, and deliberately NOT ranked
 *  against TeamRole (see backend/migrations/0007_staff_role.sql for why the
 *  two must not share an axis). null ⇒ not staff. */
export type StaffRole = "developer";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 503,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Load the acting user's role in a team; 404 (not 403) when the team is
 *  invisible to them — don't leak which team ids exist. */
export async function requireMembership(
  tx: Tx,
  teamId: string,
  userId: string,
): Promise<TeamRole> {
  const { rows } = await tx.query<{ role: TeamRole }>(
    `SELECT tm.role
     FROM team_members tm
     JOIN teams t ON t.id = tm.team_id AND t.deleted_at IS NULL
     WHERE tm.team_id = $1 AND tm.user_id = $2`,
    [teamId, userId],
  );
  const role = rows[0]?.role;
  if (!role) throw new HttpError(404, "not_found", "Team not found");
  return role;
}

export async function requireRole(
  tx: Tx,
  teamId: string,
  userId: string,
  min: TeamRole,
): Promise<TeamRole> {
  const role = await requireMembership(tx, teamId, userId);
  if (!roleAtLeast(role, min)) {
    throw new HttpError(403, "forbidden", `Requires ${min} role`);
  }
  return role;
}

/** Gate a route on staff. Takes the role off the AuthedUser the auth
 *  middleware already resolved, which re-reads it from Postgres on every
 *  request (auth.ts `ensureUser`) — so revoking staff takes effect on the
 *  next call, with no token to wait out.
 *
 *  404, not 403: a staff-only route should not confirm its own existence to a
 *  non-staff caller. Mirrors requireMembership's reasoning about not leaking
 *  which team ids exist. */
export function requireStaff(staffRole: StaffRole | null): StaffRole {
  if (!staffRole) throw new HttpError(404, "not_found", "Not found");
  return staffRole;
}

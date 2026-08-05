// ──────────────────────────────────────────────────────────
// Control-plane client — the desktop app's door to teams, membership, and
// invitations in apps/control-plane/.
//
// Auth: every call carries the CURRENT Auth0 access token from the app's
// existing session (main owns refresh/rotation via auth-session.ts — we read,
// never manage). The backend verifies it against the JWKS and decides
// authorization in Postgres; the client sends identity, nothing more.
//
// Config: VITE_CONTROL_PLANE_URL (unset → the Team settings area shows a
// not-configured empty state; nothing else breaks).
// ──────────────────────────────────────────────────────────

import { getSession } from "../auth/auth-store";

export const CONTROL_PLANE_URL: string | null =
  (import.meta.env.VITE_CONTROL_PLANE_URL as string | undefined)?.replace(
    /\/+$/,
    "",
  ) || null;

export type TeamRole = "owner" | "admin" | "member";

export type TeamSummary = {
  id: string;
  slug: string;
  name: string;
  /** Small raster logo as a data: URL (png/jpeg/webp), or null. */
  logo: string | null;
  role: TeamRole;
};

/** Product-wide staff role. NOT a TeamRole and never comparable to one — it
 *  says "works on Zeros", not "may do X in this team". null ⇒ ordinary user.
 *  Backed by `users.staff_role` and re-read from Postgres on every request;
 *  see apps/control-plane/migrations/0007_staff_role.sql. */
export type StaffRole = "developer";

export type Me = {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    staffRole: StaffRole | null;
  };
  teams: TeamSummary[];
};

export type TeamMember = {
  id: string;
  email: string;
  display_name: string | null;
  role: TeamRole;
  created_at: string;
};

export type TeamInvitation = {
  id: string;
  email: string;
  role: TeamRole;
  expires_at: string;
  created_at: string;
};

export type CreatedInvitation = {
  id: string;
  expiresAt: string;
  /** Returned exactly ONCE at creation; never retrievable again. */
  token: string;
  acceptUrl: string;
};

/** Structured API error — `code` mirrors the backend's error codes
 *  (last_owner, wrong_account, …) so UI can special-case. */
export class ControlPlaneError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!CONTROL_PLANE_URL) {
    throw new ControlPlaneError(0, "not_configured", "Control plane URL not configured");
  }
  const session = await getSession();
  const token = session?.access_token;
  if (!token) {
    throw new ControlPlaneError(401, "signed_out", "You're not signed in");
  }
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ControlPlaneError(
      res.status,
      parsed?.error?.code ?? "request_failed",
      parsed?.error?.message ?? `Request failed (${res.status})`,
    );
  }
  return (await res.json()) as T;
}

export const controlPlane = {
  me: () => request<Me>("GET", "/v1/me"),

  /** Explicit team creation — the ONLY way a team comes to exist (nothing is
   *  auto-created at sign-in; teams are optional). Creator becomes owner. */
  createTeam: (name: string, logo?: string | null) =>
    request<{ team: { id: string; slug: string; name: string; logo: string | null } }>(
      "POST",
      "/v1/teams",
      { name, ...(logo ? { logo } : {}) },
    ),

  /** Partial update: rename and/or change the logo (logo: null clears it). */
  updateTeam: (teamId: string, patch: { name?: string; logo?: string | null }) =>
    request<{ team: TeamSummary }>("PATCH", `/v1/teams/${teamId}`, patch),

  /** Owner-only soft delete; pending invitations are revoked server-side. */
  deleteTeam: (teamId: string) =>
    request<{ ok: true }>("DELETE", `/v1/teams/${teamId}`),

  listMembers: (teamId: string) =>
    request<{ members: TeamMember[] }>("GET", `/v1/teams/${teamId}/members`),

  setMemberRole: (teamId: string, userId: string, role: TeamRole) =>
    request<{ ok: true }>("PATCH", `/v1/teams/${teamId}/members/${userId}`, { role }),

  removeMember: (teamId: string, userId: string) =>
    request<{ ok: true }>("DELETE", `/v1/teams/${teamId}/members/${userId}`),

  createInvitation: (teamId: string, email: string, role: "admin" | "member") =>
    request<{ invitation: CreatedInvitation }>(
      "POST",
      `/v1/teams/${teamId}/invitations`,
      { email, role },
    ),

  listInvitations: (teamId: string) =>
    request<{ invitations: TeamInvitation[] }>("GET", `/v1/teams/${teamId}/invitations`),

  revokeInvitation: (teamId: string, invitationId: string) =>
    request<{ ok: true }>("DELETE", `/v1/teams/${teamId}/invitations/${invitationId}`),

  acceptInvitation: (token: string) =>
    request<{ team: { id: string; slug: string; name: string } }>(
      "POST",
      "/v1/invitations/accept",
      { token },
    ),

  /** The team settings doc (the engine's `team` resolve layer). */
  getTeamSettings: (teamId: string, scope = "*") =>
    request<{ scope: string; doc: Record<string, unknown>; updated_at: string | null }>(
      "GET",
      `/v1/teams/${teamId}/settings?scope=${encodeURIComponent(scope)}`,
    ),
};

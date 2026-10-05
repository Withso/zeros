import { z } from "zod";
import { cloudAccountRequest, CloudWorkspaceActorRoleSchema } from "./cloud-workspaces";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

const Uuid = z.string().uuid();
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const GuestRole = z.enum(["viewer", "prompter", "developer"]);
const Writers = z.object({
  limit: z.number().int().positive(), used: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
});

export const CloudWorkspaceCollaboratorsPageSchema = z.object({
  workspaceId: Uuid, organizationId: Uuid, accessRevision: Revision,
  writers: Writers.nullable(),
  guests: z.array(z.object({ id: Uuid, userId: Uuid, displayName: z.string().max(200).nullable().optional(), role: GuestRole, revision: Revision, expiresAt: z.string().datetime() })).max(100),
  invitations: z.array(z.object({ id: Uuid, role: GuestRole, expiresAt: z.string().datetime(),
    deliveryState: z.enum(["queued", "sending", "sent", "cancelled", "dead", "unavailable"]) })).max(100),
  members: z.array(z.object({ userId: Uuid, displayName: z.string().max(200).nullable().optional(), role: CloudWorkspaceActorRoleSchema.nullable() })).max(100),
  guestCursor: Uuid.nullable(), invitationCursor: Uuid.nullable(), memberCursor: Uuid.nullable(),
});
export type CloudWorkspaceCollaborators = z.infer<typeof CloudWorkspaceCollaboratorsPageSchema>;
export type CloudWorkspaceInvitationRole = z.infer<typeof GuestRole>;
export type CloudWorkspaceSharingMode = "private" | "organization";
export type CloudWorkspaceCollaboratorCollection = "guests" | "invitations" | "members";
export type CloudWorkspaceCollaboratorPage = {
  pageSize?: number; guestCursor?: string; invitationCursor?: string; memberCursor?: string;
};
const PageInput = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  guestCursor: Uuid.optional(), invitationCursor: Uuid.optional(), memberCursor: Uuid.optional(),
}).strict();

function workspacePath(target: CloudWorkspaceTarget): string {
  Uuid.parse(target.organizationId);
  return `/v1/cloud-workspaces/${Uuid.parse(target.workspaceId)}`;
}

export async function listCloudWorkspaceCollaborators(target: CloudWorkspaceTarget, input: CloudWorkspaceCollaboratorPage = {}): Promise<CloudWorkspaceCollaborators> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(PageInput.parse(input))) query.set(name, String(value));
  const page = await cloudAccountRequest(`${workspacePath(target)}/collaborators?${query}`, CloudWorkspaceCollaboratorsPageSchema);
  if (page.workspaceId !== target.workspaceId || page.organizationId !== target.organizationId)
    throw new Error("Cloud collaborator response changed identity");
  return page;
}

export function setCloudWorkspaceSharing(target: CloudWorkspaceTarget, sharingMode: CloudWorkspaceSharingMode, expectedRevision: number) {
  const body = z.object({ sharingMode: z.enum(["private", "organization"]), expectedRevision: Revision }).strict().parse({ sharingMode, expectedRevision });
  return cloudAccountRequest(`${workspacePath(target)}/sharing`, z.object({ sharingMode: z.enum(["private", "organization"]), accessRevision: Revision }),
    { body, method: "PATCH", idempotencyKey: crypto.randomUUID() });
}

export function inviteCloudWorkspaceCollaborator(target: CloudWorkspaceTarget, email: string, role: CloudWorkspaceInvitationRole, idempotencyKey: string) {
  const body = z.object({ email: z.string().trim().email().max(254), role: GuestRole }).strict().parse({ email, role });
  z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/).parse(idempotencyKey);
  return cloudAccountRequest(`${workspacePath(target)}/invitations`, z.object({
    invitation: z.object({ id: Uuid, expiresAt: z.string().datetime() }), replayed: z.boolean(),
  }), { body, idempotencyKey });
}

/** The existing assignment API supports only viewer/developer. Prompter is an invitation role. */
export function setCloudWorkspaceCollaboratorRole(target: CloudWorkspaceTarget, userId: string, role: "viewer" | "developer") {
  const body = z.object({ role: z.enum(["viewer", "developer"]) }).strict().parse({ role });
  return cloudAccountRequest(`${workspacePath(target)}/collaborators/${Uuid.parse(userId)}`,
    z.object({ userId: Uuid, role: z.enum(["viewer", "developer"]), writers: Writers }),
    { body, method: "PATCH", idempotencyKey: crypto.randomUUID() });
}

export function revokeCloudWorkspaceCollaborator(target: CloudWorkspaceTarget, userId: string) {
  return cloudAccountRequest(`${workspacePath(target)}/collaborators/${Uuid.parse(userId)}`, z.object({ revoked: z.literal(true) }),
    { body: {}, method: "DELETE", idempotencyKey: crypto.randomUUID() });
}

export function revokeCloudWorkspaceInvitation(target: CloudWorkspaceTarget, invitationId: string) {
  return cloudAccountRequest(`${workspacePath(target)}/invitations/${Uuid.parse(invitationId)}`, z.object({ revoked: z.literal(true) }),
    { body: {}, method: "DELETE", idempotencyKey: crypto.randomUUID() });
}

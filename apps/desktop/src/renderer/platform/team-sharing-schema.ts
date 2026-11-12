import { z } from "zod";

const uuid = z.string().uuid();

/** The top-level sharing fields of a v2 document, read only when the reply says teamSharing: 1. */
export const CloudWorkspaceSharingSchema = z.object({
  createdByUserId: uuid.nullable(),
  viewerRole: z.enum(["creator", "admin", "member"]),
  readOnly: z.boolean(),
  canManage: z.boolean(),
  following: z.boolean(),
  pinned: z.boolean(),
  followerIds: z.array(uuid).max(200),
  followerCount: z.number().int().nonnegative(),
  /** Phase 2 (activated): members write as themselves; canExecute is whether this run executes for people (readOnly = !canExecute). */
  teamWriting: z.literal(true).optional(),
  canExecute: z.boolean().optional(),
  /** Team sharing 3B: present only when the reply negotiated teamOwnership: 1 with well-formed fields. */
  ownership: z.lazy(() => CloudWorkspaceOwnershipSchema).optional(),
});
export type CloudWorkspaceSharing = z.infer<typeof CloudWorkspaceSharingSchema>;

/** Team sharing 3B (teamOwnership: 1): the Creator may be absent; who may reassign it. creatorRevision is opaque (equality only). */
export const CloudWorkspaceOwnershipSchema = z.object({
  creatorRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  noCreatorReason: z.enum(["left", "hold", "account_revoked"]).nullable(),
  canReassign: z.boolean(),
}).strict();
export type CloudWorkspaceOwnership = z.infer<typeof CloudWorkspaceOwnershipSchema>;

/** The ownership fields of a raw v2 reply, or undefined (not negotiated, or any malformed field). */
export function ownershipOf(reply: Record<string, unknown>): CloudWorkspaceOwnership | undefined {
  if (reply.teamOwnership !== 1) return undefined;
  const parsed = CloudWorkspaceOwnershipSchema.safeParse({ creatorRevision: reply.creatorRevision, noCreatorReason: reply.noCreatorReason ?? null, canReassign: reply.canReassign });
  return parsed.success ? parsed.data : undefined;
}

/** The sharing fields of a raw v2 reply, or undefined (no sharing, or any malformed field). */
export function sharingOf(reply: Record<string, unknown>): CloudWorkspaceSharing | undefined {
  if (reply.teamSharing !== 1) return undefined;
  const parsed = CloudWorkspaceSharingSchema.safeParse({
    createdByUserId: reply.createdByUserId ?? null, viewerRole: reply.viewerRole, readOnly: reply.readOnly, canManage: reply.canManage,
    following: reply.following, pinned: reply.pinned, followerIds: reply.followerIds ?? [], followerCount: reply.followerCount ?? 0,
    ...(reply.teamWriting === undefined ? {} : { teamWriting: reply.teamWriting === 1 ? true : reply.teamWriting }),
    ...(reply.canExecute === undefined ? {} : { canExecute: reply.canExecute }),
    ...(ownershipOf(reply) ? { ownership: ownershipOf(reply) } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}


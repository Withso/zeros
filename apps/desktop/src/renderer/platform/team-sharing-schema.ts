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
});
export type CloudWorkspaceSharing = z.infer<typeof CloudWorkspaceSharingSchema>;

/** The sharing fields of a raw v2 reply, or undefined (no sharing, or any malformed field). */
export function sharingOf(reply: Record<string, unknown>): CloudWorkspaceSharing | undefined {
  if (reply.teamSharing !== 1) return undefined;
  const parsed = CloudWorkspaceSharingSchema.safeParse({
    createdByUserId: reply.createdByUserId ?? null, viewerRole: reply.viewerRole, readOnly: reply.readOnly, canManage: reply.canManage,
    following: reply.following, pinned: reply.pinned, followerIds: reply.followerIds ?? [], followerCount: reply.followerCount ?? 0,
  });
  return parsed.success ? parsed.data : undefined;
}


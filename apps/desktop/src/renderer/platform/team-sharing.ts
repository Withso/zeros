import { z } from "zod";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { cloudAccountRequest } from "./cloud-workspaces";
export { CloudWorkspaceSharingSchema, sharingOf, type CloudWorkspaceSharing } from "./team-sharing-schema";

/** Team sharing phase 1 (team-sharing-wire.md section 4). Every route here
 * carries X-Zeros-Team-Sharing: 1; a control plane without sharing answers
 * the old creator-only shapes, which the catalog keeps apart. */
const uuid = z.string().uuid();
const key = () => crypto.randomUUID();

export const OrganizationMemberSchema = z.object({
  id: uuid,
  email: z.string().max(320).optional(),
  display_name: z.string().max(200).nullable().optional(),
  avatar_url: z.string().max(2048).nullable().optional(),
  role: z.string().max(32).optional(),
}).passthrough();
export interface OrganizationMember { id: string; name: string; avatarUrl: string | null; role: string | null }

/** Every member of the organization (readable by every member): names and avatars for Home, the Team list and avatars. */
export async function listOrganizationMembers(organizationId: string): Promise<OrganizationMember[]> {
  const { members } = await cloudAccountRequest(`/v1/organizations/${encodeURIComponent(uuid.parse(organizationId))}/members`,
    z.object({ members: z.array(OrganizationMemberSchema).max(5000) }).passthrough());
  return members.map(member => ({ id: member.id, name: member.display_name?.trim() || member.email?.split("@")[0] || "Teammate",
    avatarUrl: member.avatar_url && /^https:\/\//.test(member.avatar_url) ? member.avatar_url : null, role: member.role ?? null }));
}

const path = (target: CloudWorkspaceTarget, action: string) => `/v1/cloud-v2/workspaces/${uuid.parse(target.workspaceId)}/${action}`;

export async function setCloudWorkspaceFollowing(target: CloudWorkspaceTarget, following: boolean): Promise<boolean> {
  const reply = await cloudAccountRequest(path(target, following ? "follow" : "unfollow"), z.object({ following: z.boolean() }).passthrough(),
    { body: {}, idempotencyKey: key() }, { teamSharing: true });
  return reply.following;
}
export async function setCloudWorkspacePinned(target: CloudWorkspaceTarget, pinned: boolean): Promise<boolean> {
  const reply = await cloudAccountRequest(path(target, pinned ? "pin" : "unpin"), z.object({ pinned: z.boolean() }).passthrough(),
    { body: {}, idempotencyKey: key() }, { teamSharing: true });
  return reply.pinned;
}
export async function listCloudWorkspaceFollowers(target: CloudWorkspaceTarget): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const query: string = `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const reply: { userIds: string[]; nextCursor: string | null } = await cloudAccountRequest(`${path(target, "followers")}${query}`,
      z.object({ userIds: z.array(uuid).max(200), nextCursor: z.string().max(2048).nullable() }).passthrough(), undefined, { teamSharing: true });
    ids.push(...reply.userIds);
    if (!reply.nextCursor) break;
    cursor = reply.nextCursor;
  }
  return ids;
}

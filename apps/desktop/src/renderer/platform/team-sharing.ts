import { z } from "zod";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { cloudAccountRequest } from "./cloud-workspaces";
import { cloudV2Document, CloudV2WorkspaceSchema } from "./cloud-v2";
import type { CloudWorkspaceDocument } from "./cloud-workspace-contract";
import { ControlPlaneError } from "../features/team/control-plane";
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

/** Team sharing 3B: who the Creator or an admin may make the Creator. agentLogins (presentation only) are the agents that
 * person could run turns with; eligibility never depends on them. */
const revision = z.string().regex(/^[1-9][0-9]{0,18}$/);
const agentLogins = z.object({ claude: z.literal(true).optional(), codex: z.literal(true).optional(), cursor: z.literal(true).optional() }).strict();
export const ReassignCandidateSchema = z.union([
  z.object({ userId: uuid, eligible: z.literal(true), agentLogins: agentLogins.optional() }).strict(),
  z.object({ userId: uuid, eligible: z.literal(false), reason: z.enum(["on_hold", "account_inactive", "repository_access_required"]) }).strict(),
]);
export type ReassignCandidate = z.infer<typeof ReassignCandidateSchema>;

/** Every page of one Creator revision (up to 200 per page, 5 pages); a page of another revision is creator_changed. */
export async function listReassignCandidates(target: CloudWorkspaceTarget, signal?: AbortSignal): Promise<{ creatorRevision: string; candidates: ReassignCandidate[] }> {
  const candidates: ReassignCandidate[] = [];
  let cursor: string | null = null, held: string | undefined;
  for (let page = 0; page < 5; page++) {
    const query: string = `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const reply: { candidates: ReassignCandidate[]; nextCursor: string | null; creatorRevision: string } = await cloudAccountRequest(`${path(target, "reassign-candidates")}${query}`,
      z.object({ candidates: z.array(ReassignCandidateSchema).max(200), nextCursor: z.string().max(2048).nullable(), creatorRevision: revision }).passthrough(),
      undefined, { teamSharing: true, ...(signal ? { signal } : {}) });
    if (held !== undefined && reply.creatorRevision !== held) throw new ControlPlaneError(409, "creator_changed", "The Creator changed while the list was loading.");
    held = reply.creatorRevision; candidates.push(...reply.candidates);
    if (!reply.nextCursor) break;
    cursor = reply.nextCursor;
  }
  return { creatorRevision: held!, candidates };
}

export interface ReassignRequest { requestId: string; toUserId: string; expectedCreatorUserId: string | null; expectedCreatorRevision: string }
/** Compare-and-set on the held Creator and revision; the same requestId replays the same receipt. */
export async function reassignCloudWorkspace(target: CloudWorkspaceTarget, request: ReassignRequest): Promise<{
  workspace: CloudWorkspaceDocument; reassignment: { requestId: string; fromUserId: string | null; toUserId: string; creatorRevision: string } }> {
  const reply = await cloudAccountRequest(path(target, "reassign"), z.object({
    workspace: CloudV2WorkspaceSchema,
    reassignment: z.object({ requestId: uuid, fromUserId: uuid.nullable(), toUserId: uuid, creatorRevision: revision }).strict(),
  }).passthrough(), { body: { requestId: uuid.parse(request.requestId), toUserId: uuid.parse(request.toUserId),
    expectedCreatorUserId: request.expectedCreatorUserId === null ? null : uuid.parse(request.expectedCreatorUserId),
    expectedCreatorRevision: revision.parse(request.expectedCreatorRevision) }, idempotencyKey: request.requestId }, { teamSharing: true });
  // The reply's own workspace carries teamSharing/teamOwnership at the reply's top level.
  const flags = reply as { teamSharing?: unknown; teamOwnership?: unknown };
  const workspace = cloudV2Document(CloudV2WorkspaceSchema.parse({ ...reply.workspace, ...(flags.teamSharing === 1 ? { teamSharing: 1 } : {}), ...(flags.teamOwnership === 1 ? { teamOwnership: 1 } : {}) }));
  return { workspace, reassignment: reply.reassignment };
}

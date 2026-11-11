import type { CloudWorkspaceTarget } from "../platform/bridge/cloud-workspace-key";
import { setCloudWorkspaceFollowing, setCloudWorkspacePinned } from "../platform/team-sharing";
import { cloudV2Document, renameCloudV2Workspace } from "../platform/cloud-v2";
import { myUserId } from "../platform/team-sharing-state";
import { acceptCloudWorkspaceDocument, cloudWorkspaceDocument } from "./cloud-workspace-catalog";

type Flag = "following" | "pinned";
const latest = new Map<string, number>();
let sequence = 0;

function patch(target: CloudWorkspaceTarget, field: Flag, value: boolean): void {
  const doc = cloudWorkspaceDocument(target);
  if (!doc?.sharing || doc.sharing[field] === value) return;
  const me = myUserId();
  const sharing = { ...doc.sharing, [field]: value };
  // The viewer's own follow shows in the follower list at once.
  if (field === "following" && me) {
    const others = doc.sharing.followerIds.filter(id => id !== me);
    const was = doc.sharing.followerIds.includes(me);
    sharing.followerIds = value ? [...others, me].slice(0, 200) : others;
    sharing.followerCount = Math.max(0, doc.sharing.followerCount + (value && !was ? 1 : !value && was ? -1 : 0));
  }
  acceptCloudWorkspaceDocument({ ...doc, sharing });
}

/** Follow/Unfollow or Pin/Unpin at once, then the server's answer; a failure
 * puts it back unless a later toggle has already replaced it. */
export async function setCloudWorkspaceSharingFlag(target: CloudWorkspaceTarget, field: Flag, value: boolean): Promise<void> {
  const doc = cloudWorkspaceDocument(target);
  if (!doc?.sharing) throw new Error("This workspace isn't shared");
  const before = doc.sharing[field];
  const key = `${target.organizationId}/${target.workspaceId}/${field}`, mine = ++sequence;
  latest.set(key, mine);
  patch(target, field, value);
  try {
    const confirmed = field === "following" ? await setCloudWorkspaceFollowing(target, value) : await setCloudWorkspacePinned(target, value);
    if (latest.get(key) === mine) patch(target, field, confirmed);
  } catch (error) {
    if (latest.get(key) === mine) patch(target, field, before);
    throw error;
  } finally {
    if (latest.get(key) === mine) latest.delete(key);
  }
}

/** Rename through the control plane (never the worker), then show its document. */
export async function renameSharedCloudWorkspace(target: CloudWorkspaceTarget, name: string): Promise<void> {
  acceptCloudWorkspaceDocument(cloudV2Document(await renameCloudV2Workspace(target, name)));
}

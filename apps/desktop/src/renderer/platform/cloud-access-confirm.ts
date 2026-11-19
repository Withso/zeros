import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { getCloudV2Workspace } from "./cloud-v2";
import { reportWorkspaceAccessEnded, workspaceAccessScope } from "./team-sharing-registry";

// Use normal team headers to avoid a false 404 for non-creators. Only 404 and 403 member_access_revoked prove access ended.
export async function confirmCloudWorkspaceAccessEnded(target: CloudWorkspaceTarget): Promise<"ended" | "present" | "unknown"> {
  try { await getCloudV2Workspace(target); return "present"; }
  catch (error) {
    const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
    return status === 404 || (status === 403 && code === "member_access_revoked") ? "ended" : "unknown";
  }
}

// Fence confirmed stream termination to the account session that observed it.
export async function reportIfCloudWorkspaceAccessEnded(target: CloudWorkspaceTarget,
  confirm: typeof confirmCloudWorkspaceAccessEnded = confirmCloudWorkspaceAccessEnded): Promise<"ended" | "present" | "unknown"> {
  const session = workspaceAccessScope();
  const verdict = await confirm(target);
  if (verdict === "ended") reportWorkspaceAccessEnded(target, session);
  return verdict;
}

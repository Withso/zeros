import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { getCloudV2Workspace } from "./cloud-v2";
import { reportWorkspaceAccessEnded, workspaceAccessScope } from "./team-sharing-registry";

/** D2: did this person really lose access? One exact read of the workspace document with the renderer's normal team
 * headers (a header-less read 404s for every non-Creator). Only 404, or 403 member_access_revoked, is "ended"; a
 * successful read is "present"; anything else (5xx, 429, network, timeout, another 403) is "unknown", never ended. */
export async function confirmCloudWorkspaceAccessEnded(target: CloudWorkspaceTarget): Promise<"ended" | "present" | "unknown"> {
  try { await getCloudV2Workspace(target); return "present"; }
  catch (error) {
    const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
    return status === 404 || (status === 403 && code === "member_access_revoked") ? "ended" : "unknown";
  }
}

/** The events stream ended for this person: report access ended only once confirmed, and only for the account session
 * that was signed in when the stream ended (a late reply after an account switch is dropped). */
export async function reportIfCloudWorkspaceAccessEnded(target: CloudWorkspaceTarget,
  confirm: typeof confirmCloudWorkspaceAccessEnded = confirmCloudWorkspaceAccessEnded): Promise<"ended" | "present" | "unknown"> {
  const session = workspaceAccessScope();
  const verdict = await confirm(target);
  if (verdict === "ended") reportWorkspaceAccessEnded(target, session);
  return verdict;
}

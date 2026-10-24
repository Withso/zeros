import { cloudTargetForValue } from "./cloud-workspace-key";

/** Cloud v2 has no workspace or GitHub inline-comment service. Keep the same
 * capability at the read, write and presentation boundaries, including while
 * a workspace id and cwd are being reconciled. Malformed cloud ids fail closed. */
export function codeReviewAvailable({
  cwd,
  workspaceId,
}: {
  cwd?: string | null;
  workspaceId?: string | null;
}): boolean {
  try {
    return !cloudTargetForValue(cwd) && !cloudTargetForValue(workspaceId);
  } catch {
    return false;
  }
}

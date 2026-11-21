import { cloudComputerV2BuildRequired, cloudComputerV2CheckFailed } from "../../features/settings/cloud-computer-v2-create-gate";

export const ADD_CLOUD_REPOSITORY_REASON = "Add a repository to your Cloud Computer.";
export const READY_COPY_BUILDING = "This repository is still getting ready in the cloud. New workspaces take a little longer until it is.";

export type CreateTrayAction = "cloud-computer-settings" | "manage-repositories";

export interface CreateTrayState {
  message: string;
  action: CreateTrayAction | null;
}

/** One line under the Create composer for the existing blocked and
 * informational states, with at most one action. Nothing new is invented:
 * every message is a reason the Create page already had. */
export function createTrayState(input: {
  notice: string | null;
  reason: string | null;
  checking: boolean;
  computerRequired: boolean;
  computerReason: string | null;
  canManageComputer: boolean;
  /** Ready copies: the selected repository's first copy is still being made. */
  readyCopyBuilding?: boolean;
}): CreateTrayState | null {
  if (input.notice) return { message: input.notice, action: null };
  // Creating still works meanwhile; it just starts from a direct clone.
  if (!input.reason && !input.checking && input.readyCopyBuilding) return { message: READY_COPY_BUILDING, action: null };
  if (!input.reason || input.checking) return null;
  if (input.computerRequired) {
    const reason = input.computerReason;
    return {
      message: reason && reason !== cloudComputerV2BuildRequired ? reason
        : `${cloudComputerV2BuildRequired}${input.canManageComputer ? "." : ". Ask an organization admin to build it."}`,
      action: input.canManageComputer ? "cloud-computer-settings" : null,
    };
  }
  // Its copy points to Settings, so the line carries the way there.
  if (input.reason === cloudComputerV2CheckFailed)
    return { message: input.reason, action: "cloud-computer-settings" };
  if (input.reason === ADD_CLOUD_REPOSITORY_REASON)
    return { message: input.reason, action: "manage-repositories" };
  return { message: input.reason, action: null };
}

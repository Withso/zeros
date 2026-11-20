import { cloudComputerV2BuildRequired } from "../../features/settings/cloud-computer-v2-create-gate";

export const ADD_CLOUD_REPOSITORY_REASON = "Add a repository to your Cloud Computer.";

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
}): CreateTrayState | null {
  if (input.notice) return { message: input.notice, action: null };
  if (!input.reason || input.checking) return null;
  if (input.computerRequired) {
    const reason = input.computerReason;
    return {
      message: reason && reason !== cloudComputerV2BuildRequired ? reason
        : `${cloudComputerV2BuildRequired}${input.canManageComputer ? "." : ". Ask an organization admin to build it."}`,
      action: input.canManageComputer ? "cloud-computer-settings" : null,
    };
  }
  if (input.reason === ADD_CLOUD_REPOSITORY_REASON)
    return { message: input.reason, action: "manage-repositories" };
  return { message: input.reason, action: null };
}

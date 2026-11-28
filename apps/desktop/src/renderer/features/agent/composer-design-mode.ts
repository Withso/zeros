import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";

export function composerDesignModeAvailable(input: {
  chatId: string | null | undefined;
  bridge: unknown;
  workspaceId: string | null | undefined;
}): boolean {
  return Boolean(input.chatId && input.bridge && !isCloudWorkspace(input.workspaceId));
}

import type { WorkspaceSetupInfo } from "../../../platform/git";

/** The Setup tab's one status-cluster action. A live run can always be
 * stopped. A finished log offers "Rerun setup" only when the repository has a
 * setup command: the submodule fetch also writes a Setup log, and a rerun
 * without a command would only toast "No setup command". */
export function setupStatusAction(input: {
  state: WorkspaceSetupInfo["state"];
  hasLog: boolean;
  hasCommand: boolean | undefined;
}): "stop" | "rerun" | null {
  if (input.state === "running") return "stop";
  if (!input.hasLog || !input.hasCommand) return null;
  return "rerun";
}

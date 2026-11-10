/** Main -> renderer: an approval this Mac raised. Main keeps the decision;
 * the renderer only shows it and relays the person's choice. */
export interface LocalCommandApprovalView {
  requestId: string;
  workspaceId: string; workspaceName: string; workspaceTitle: string | null;
  /** The worker's chat id; the renderer scopes it with the workspace's organization. */
  chatId: string; chatTitle: string;
  macName: string;
  command: string; cwd?: string; description?: string; reason?: string;
  timeoutMs: number; extendedTimeoutReason?: string;
  /** For an explicit-Mac request: the Mac the chat's latest message came from. */
  explicitFrom?: string;
  approvalDeadline: string;
}
export type LocalCommandDecision = "deny" | "yes" | "always";
export const LOCAL_COMMAND_APPROVALS_EVENT = "local-commands:approvals";
export const LOCAL_COMMAND_OPEN_EVENT = "local-commands:open";

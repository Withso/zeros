import type { AgentMessage } from "../features/agent/use-agent-session";
import { toolPresentationReady } from "../features/agent/renderers/tool-readiness";
import { nativeToolTitle } from "../features/agent/renderers/native-tool-presentation";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { Workspace } from "../platform/git";
import type { ChatThread } from "../state/store";
import { folderIsWithinRoot } from "../state/workspace-resolution";

/** The sidebar already assigns nested chats to their most-specific workspace.
 * Keep that membership and recheck the folder before displaying a preview. */
export function sidebarPreviewChat(
  workspace: Workspace,
  chatIds: readonly string[],
  chats: readonly ChatThread[],
): ChatThread | null {
  let latest: ChatThread | null = null;
  for (const chat of chats) {
    if (chat.archived || chat.kind === "terminal" || !chatIds.includes(chat.id) ||
        !folderIsWithinRoot(chat.folder, workspace.path)) continue;
    if (!latest || chat.updatedAt > latest.updatedAt) latest = chat;
  }
  return latest;
}

/** Plain, bounded text only: never mount a transcript or render provider HTML
 * for a one-line preview. Returning a string also keeps the selector stable. */
export function sidebarPreviewText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if ("parentToolId" in message && message.parentToolId) continue;
    let text = "";
    if (message.kind === "text" && !message.retracted && !message.queued &&
        (message.role === "agent" || message.role === "user")) {
      text = message.text;
    } else if (message.kind === "tool" && toolPresentationReady(message)) {
      text = nativeToolTitle(message) ?? message.title;
    } else if (message.kind === "error_notice") {
      text = message.message;
    }
    const preview = text.trim().replace(/\s+/g, " ").slice(0, 400);
    if (preview) return preview;
  }
  return "";
}

export function sidebarWorkspaceDisplayId(workspace: Workspace): string {
  const id = parseCloudWorkspaceKey(workspace.path)?.workspaceId ?? workspace.id;
  return id.length > 12 ? id.slice(0, 8) : id;
}

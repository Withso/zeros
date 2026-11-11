import { useEffect } from "react";
import { cloudWorkspaceKey, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { lookupChatSender } from "../../platform/chat-senders-lookup";
import { chatKeyFor, useChatSender } from "../../platform/chat-senders";
import { useMyUserId } from "../../platform/team-sharing-state";
import type { OrganizationMember } from "../../platform/team-sharing";
import { useCloudFolderSharedDocument } from "../../state/cloud-workspace-creators";
import { useOrganizationRoster } from "../../state/organization-roster";

export interface PromptSender { name: string; avatarUrl: string | null }

/** Team sharing (decision 13): who sent a message, shown only in a shared
 * workspace and only for someone other than the viewer. Nothing until both
 * the attribution and the roster are known, so a name never flashes. */
export function promptSenderLabel(input: { shared: boolean; sender: string | null | undefined; me: string | null;
  roster: readonly Pick<OrganizationMember, "id" | "name" | "avatarUrl">[] | null }): PromptSender | null {
  const { shared, sender, me, roster } = input;
  if (!shared || !sender || sender === me || !roster) return null;
  const member = roster.find(item => item.id === sender);
  return member ? { name: member.name, avatarUrl: member.avatarUrl } : { name: "Former member", avatarUrl: null };
}

export function usePromptSender(chatId: string | null | undefined, messageId: string | null | undefined, active: boolean): PromptSender | null {
  const target = chatId ? parseCloudScopedId(chatId) : null;
  const doc = useCloudFolderSharedDocument(target ? cloudWorkspaceKey(target) : null);
  const sender = useChatSender(doc && target ? chatKeyFor(target, target.id) : null, messageId);
  // Not attributed yet (a live or worker-read message): ask the control plane once (messages.senders always opts in).
  const asks = active && !!doc && !!target && !!messageId && sender === undefined;
  useEffect(() => { if (asks) lookupChatSender({ organizationId: target!.organizationId, workspaceId: target!.workspaceId }, target!.id, messageId!); },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the target's identity is its key
    [asks, chatId, messageId]);
  const me = useMyUserId();
  const roster = useOrganizationRoster(doc && sender ? target!.organizationId : null, active && !!doc && !!sender);
  return promptSenderLabel({ shared: !!doc, sender, me, roster });
}

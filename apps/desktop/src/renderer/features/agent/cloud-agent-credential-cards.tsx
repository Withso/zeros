import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { parseCloudScopedId, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useBridge } from "../../platform/bridge/use-bridge";
import { useCloudWorkspaceRestartAction } from "../../shell/conversation/cloud-workspace-restart-controls";
import { CloudAgentCredentialsCard } from "./cloud-agent-credentials-card";
import { CloudAgentCredentialNoticeCard } from "./cloud-agent-credential-notice-card";
import { sameCloudAgentBootBinding } from "./cloud-agent-credential-selectors";
import { useSessionsStore } from "./sessions-store";

/** The outer boundary keeps both Local placements free of cloud hooks. */
export function CloudAgentCredentialCards({ folder, chatId, active }: {
  folder: string | undefined; chatId: string | null | undefined; active: boolean;
}) {
  const target = parseCloudWorkspaceKey(folder), conversation = parseCloudScopedId(chatId);
  if (!target || !folder || !chatId || !conversation || target.organizationId !== conversation.organizationId || target.workspaceId !== conversation.workspaceId) return null;
  return <CloudAgentCredentialCardsContent folder={folder} chatId={chatId} conversationId={conversation.id} active={active} />;
}
function CloudAgentCredentialCardsContent({ folder, chatId, conversationId, active }: {
  folder: string; chatId: string; conversationId: string; active: boolean;
}) {
  const bridge = useBridge() as (Partial<Pick<WorkspaceRuntimeClient, "cloudAgentBootBinding" | "onWorkspaceStatusChange">>) | null;
  const subscribe = useCallback((listener: () => void) => active ? bridge?.onWorkspaceStatusChange?.(folder, listener) ?? (() => {}) : () => {}, [bridge, folder, active]);
  const read = useCallback(() => bridge?.cloudAgentBootBinding?.(folder) ?? null, [bridge, folder]);
  const binding = useSyncExternalStore(subscribe, read, read);
  const entry = useSessionsStore(state => state.cloudAgentCredentials[chatId]);
  const context = useMemo(() => binding ? { binding, conversationId, initialAdoptions: binding.initialAdoptions } : undefined, [binding, conversationId]);
  const restart = useCloudWorkspaceRestartAction(folder, active);
  const state = binding && entry && sameCloudAgentBootBinding(binding, entry.binding) ? entry.state : undefined;
  return <>
    <CloudAgentCredentialNoticeCard folder={folder} active={active} context={context} state={state} workspace={restart.workspace} />
    <CloudAgentCredentialsCard folder={folder} active={active} binding={binding ?? undefined} restart={restart} />
  </>;
}

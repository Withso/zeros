import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { canReadCloudWorkspace } from "../../state/cloud-workspace-catalog";
import type { CloudAgentCredentialNoticeContext, CloudAgentCredentialNoticeState } from "./cloud-agent-credential-notice";
import { cloudAgentCredentialUseMatchesContext, sameCloudAgentCredentialNoticeContext } from "./cloud-agent-credential-notice";

const names = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };
/** Presentation of W4's validated actual-use state only. Cache/selection
 * changes never enter this component; no fetch, polling or wake is added. */
export function CloudAgentCredentialNoticeCard({ folder, active, context, state, workspace }: {
  folder: string | undefined;
  active: boolean;
  context?: CloudAgentCredentialNoticeContext;
  state?: CloudAgentCredentialNoticeState;
  workspace?: CloudWorkspaceDocument;
}) {
  const target = parseCloudWorkspaceKey(folder);
  const notice = state?.notice;
  const credentials = workspace?.agentCredentials;
  if (!target || !context || !state || !notice || !workspace || !credentials ||
      !canReadCloudWorkspace(workspace) || ["archiving", "archived"].includes(workspace.status) ||
      !sameCloudAgentCredentialNoticeContext(state.context, context) || !cloudAgentCredentialUseMatchesContext(context, notice) ||
      workspace.organizationId !== target.organizationId || workspace.id !== target.workspaceId ||
      context.binding.organizationId !== target.organizationId || context.binding.workspaceId !== target.workspaceId ||
      workspace.generation.number !== credentials.generation ||
      context.binding.generation !== credentials.generation || context.binding.engineInstanceId !== credentials.engineInstanceId ||
      context.binding.bootId !== credentials.bootId || context.binding.writerEpoch !== credentials.writerEpoch ||
      context.binding.fundingOwnerUserId !== credentials.fundingOwnerUserId || context.binding.fundingOwnerEpoch !== credentials.fundingOwnerEpoch ||
      credentials.mode !== "boot-owner-v1" || credentials.fundingScope !== "workspace-roles-v1") return null;
  return (
    <div role="status" aria-live={active ? "polite" : "off"} className="border-border1 mt-2 space-y-2 border-t px-3 pt-3 pb-2">
      <p className="text-fg2 text-xs">Using {notice.credentialRun.displayName} for {names[notice.credentialRun.provider]}.</p>
    </div>
  );
}

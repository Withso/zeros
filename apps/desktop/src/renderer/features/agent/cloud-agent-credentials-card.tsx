import type { ReactNode } from "react";
import type { CloudAgentBootIdentity } from "@zeros/protocol/cloud-agent-bootstrap";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { Button } from "../../shared/ui/primitives";
import { canReadCloudWorkspace } from "../../state/cloud-workspace-catalog";

/** Cached negotiated identity supplied by the active cloud peer. This is
 * presentation data; it grants no execution or restart authority. */
export type CloudAgentCredentialBinding = Pick<CloudAgentBootIdentity,
  "organizationId" | "workspaceId" | "generation" | "engineInstanceId" |
  "bootId" | "writerEpoch" | "fundingOwnerUserId" | "fundingOwnerEpoch" | "mode" | "fundingScope">;

type WorkspaceCredentials = Omit<CloudAgentCredentialBinding, "organizationId" | "workspaceId"> & {
  status: "current" | "owner-changed";
};

export interface CloudAgentCredentialsCardProps {
  folder: string | undefined;
  active: boolean;
  binding?: CloudAgentCredentialBinding;
  restart: {
    visible: boolean;
    enabled: boolean;
    workspace?: CloudWorkspaceDocument & { agentCredentials?: WorkspaceCredentials };
    disabledReason?: string;
    request(): void;
    dialog?: ReactNode;
  };
}

/** Uses the existing above-composer notice and restart flow. No reads, polling,
 * wakes, credential refresh or local-provider effects are added by this card. */
export function CloudAgentCredentialsCard(props: CloudAgentCredentialsCardProps) {
  const { folder, binding, restart, active } = props;
  const target = parseCloudWorkspaceKey(folder);
  const workspace = restart.workspace;
  const credentials = workspace?.agentCredentials;
  if (!target || !binding || !workspace || !restart.enabled || !restart.visible ||
      !canReadCloudWorkspace(workspace) || ["archiving", "archived"].includes(workspace.status) || credentials?.status !== "owner-changed" ||
      credentials.mode !== "boot-owner-v1" || credentials.fundingScope !== "workspace-roles-v1" ||
      workspace.organizationId !== target.organizationId || workspace.id !== target.workspaceId ||
      binding.organizationId !== target.organizationId || binding.workspaceId !== target.workspaceId ||
      binding.mode !== credentials.mode || binding.fundingScope !== credentials.fundingScope ||
      workspace.generation.number !== credentials.generation ||
      binding.generation !== credentials.generation || binding.engineInstanceId !== credentials.engineInstanceId ||
      binding.bootId !== credentials.bootId || binding.writerEpoch !== credentials.writerEpoch ||
      binding.fundingOwnerUserId !== credentials.fundingOwnerUserId || binding.fundingOwnerEpoch !== credentials.fundingOwnerEpoch) return null;

  const disabledReason = !workspace.capabilities.canManage
    ? "Workspace management access is required to restart."
    : restart.disabledReason ?? (!workspace.capabilities.canWrite ? "Workspace run access is required to restart." : undefined);
  const disabled = !active || !!disabledReason;
  return (
    <>
      <div role="status" aria-live={active ? "polite" : "off"} className="border-border1 mt-2 space-y-2 border-t px-3 pt-3 pb-2">
        <p className="text-fg2 text-xs">Agent credentials changed · <Button variant="ghost" size="compact" disabled={disabled}
          onClick={() => { if (!disabled) restart.request(); }}>Restart workspace</Button></p>
        {disabledReason && <p className="text-fg2 text-xs">{disabledReason}</p>}
      </div>
      {!disabled && restart.dialog}
    </>
  );
}

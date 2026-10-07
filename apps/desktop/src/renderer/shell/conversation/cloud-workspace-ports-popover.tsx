import { Plug } from "lucide-react";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { warmCloudServiceAccess } from "../../platform/cloud-workspace-access";
import { CloudWorkspaceAccessControls } from "./cloud-workspace-access-controls";
import { CloudWorkspacePopover } from "./cloud-workspace-popover";

export function CloudWorkspacePortsPopover({ workspace, active, onRevealWorkbench }: { workspace: CloudWorkspaceDocument; active: boolean; onRevealWorkbench?: () => void }) {
  return <CloudWorkspacePopover workspace={workspace} active={active} label="Port forwarding" icon={<Plug />}
    warm={() => { void warmCloudServiceAccess({ organizationId: workspace.organizationId, workspaceId: workspace.id }).catch(() => {}); }}>
    {(shown, close) => <CloudWorkspaceAccessControls workspace={workspace} active={shown} mode="ports"
      onOpenBrowser={() => { close(); onRevealWorkbench?.(); }} />}
  </CloudWorkspacePopover>;
}

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { Folder, GitBranch } from "lucide-react";
import type { Workspace } from "../../platform/git";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import { cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useWorkspaceStore } from "../../state/workspace-store";
import { PanelHeader, Tooltip } from "../../shared/ui/primitives";
import { workspaceLabel } from "../workspace-tabs";
import { CloudWorkspaceDetails } from "./cloud-workspace-details";

export function ConversationWorkspaceHeader({ workspace, ...props }: {
  workspace: Workspace | null;
  readOnly: boolean;
  windowControlsInset: boolean;
  trailing?: ReactNode;
  onRevealWorkbench?: () => void;
}) {
  const resolved = useActiveWorkspace();
  const current = workspace ?? resolved.workspace;
  const folder = current?.path ?? resolved.folder;
  const name = current ? workspaceLabel(current) : folder?.split(/[\\/]/).pop() || "Workspace";
  return <WorkspaceHeader {...props} folder={folder} name={name} branch={!!current} />;
}

/** Column chrome is mounted once above the split tree. Only the cloud branch
 * subscribes to cloud catalog state; organization-owned Local stays Local. */
export function WorkspaceHeader({ folder, ...props }: {
  folder: string | null;
  name: string;
  branch?: boolean;
  readOnly?: boolean;
  windowControlsInset?: boolean;
  trailing?: ReactNode;
  onRevealWorkbench?: () => void;
}) {
  return folder && parseCloudWorkspaceKey(folder)
    ? <CloudHeader key={`${getOrganizationStoreGeneration()}:${cloudCatalogGeneration()}:${folder}`} {...props} folder={folder} />
    : <LocalHeader {...props} />;
}

function LocalHeader(props: Omit<Parameters<typeof WorkspaceHeader>[0], "folder">) {
  // The 28px box the Cloud details button takes, so the name starts at one
  // column for branch, folder and cloud workspaces, published or not.
  const icon = (
    <span className="-ml-1.5 inline-flex size-7 items-center justify-center">
      {props.branch ? <GitBranch className="size-4" /> : <Folder className="size-4" />}
    </span>
  );
  return <WorkspaceHeaderView {...props} icon={icon} />;
}

function CloudHeader({ folder, ...props }: Parameters<typeof WorkspaceHeader>[0] & { folder: string }) {
  const active = useWorkspaceStore(state => state.activePage === "workspace");
  const target = parseCloudWorkspaceKey(folder)!;
  const subscribe = useCallback((listener: () => void) => active ? subscribeCloudWorkspaces(listener) : () => {}, [active]);
  const read = () => cloudWorkspaceDocument(target);
  const workspace = useSyncExternalStore(subscribe, read, read);
  return <WorkspaceHeaderView {...props} name={workspace?.name ?? props.name} icon={<CloudWorkspaceDetails folder={folder} />} />;
}

export function WorkspaceHeaderView({ name, icon, actions, readOnly, windowControlsInset, trailing }: {
  name: string;
  icon: ReactNode;
  actions?: ReactNode;
  readOnly?: boolean;
  windowControlsInset?: boolean;
  trailing?: ReactNode;
}) {
  // No divider: the header's bg1 runs straight into the chat below; a split
  // pane's own fill and corners set it apart.
  return <PanelHeader size="window" divider={false} aria-label="Workspace header" data-workspace-header="" data-tauri-drag-region="">
    {windowControlsInset && <span className="block h-full w-[108px] shrink-0" aria-hidden="true" data-window-controls-reserve="" />}
    <div className="text-fg2 inline-flex shrink-0 items-center" data-workspace-placement="">{icon}</div>
    <Tooltip label={name}>
      <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium" data-workspace-name="">{name}</span>
    </Tooltip>
    {!readOnly && <div className="flex shrink-0 items-center gap-1" data-workspace-header-actions="">{actions}{trailing}</div>}
  </PanelHeader>;
}

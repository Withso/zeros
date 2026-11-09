import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import type { Workspace } from "../../platform/git";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import { cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useWorkspaceStore } from "../../state/workspace-store";
import { PanelHeader } from "../../shared/ui/primitives";
import { workspaceLabel } from "../workspace-tabs";
import { CloudWorkspaceDetails } from "./cloud-workspace-details";
import { LocalWorkspaceDetails } from "./local-workspace-details";
import { WorkspaceIdentityLabel } from "./workspace-identity";

/** The branch the Local details show. A synthetic folder row keeps its
 * display name in `branch`, which is not a branch. */
export function workspaceHeaderBranch(workspace: Workspace | null): string | undefined {
  return workspace && !isLocalMainWorkspace(workspace) ? workspace.branch : undefined;
}

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
  return <WorkspaceHeader {...props} folder={folder} name={name} branch={workspaceHeaderBranch(current)} />;
}

/** Column chrome is mounted once above the split tree. Only the cloud branch
 * subscribes to cloud catalog state; organization-owned Local stays Local. */
export function WorkspaceHeader({ folder, ...props }: {
  folder: string | null;
  name: string;
  /** A Local workspace's branch, for its details. */
  branch?: string;
  readOnly?: boolean;
  windowControlsInset?: boolean;
  trailing?: ReactNode;
  onRevealWorkbench?: () => void;
}) {
  return folder && parseCloudWorkspaceKey(folder)
    ? <CloudHeader key={`${getOrganizationStoreGeneration()}:${cloudCatalogGeneration()}:${folder}`} {...props} folder={folder} />
    : <WorkspaceHeaderView {...props} identity={folder
      ? <LocalWorkspaceDetails key={folder} folder={folder} name={props.name} branch={props.branch} />
      : <WorkspaceIdentityLabel name={props.name} placement="local" />} />;
}

function CloudHeader({ folder, ...props }: Parameters<typeof WorkspaceHeader>[0] & { folder: string }) {
  const active = useWorkspaceStore(state => state.activePage === "workspace");
  const target = parseCloudWorkspaceKey(folder)!;
  const subscribe = useCallback((listener: () => void) => active ? subscribeCloudWorkspaces(listener) : () => {}, [active]);
  const read = () => cloudWorkspaceDocument(target);
  const workspace = useSyncExternalStore(subscribe, read, read);
  return <WorkspaceHeaderView {...props} identity={
    <CloudWorkspaceDetails folder={folder} name={workspace?.name ?? props.name} workspace={workspace} />
  } />;
}

export function WorkspaceHeaderView({ identity, actions, readOnly, windowControlsInset, trailing }: {
  /** The name, then where the workspace lives. */
  identity: ReactNode;
  actions?: ReactNode;
  readOnly?: boolean;
  windowControlsInset?: boolean;
  trailing?: ReactNode;
}) {
  // No divider: the header's bg1 runs straight into the chat below; a split
  // pane's own fill and corners set it apart.
  return <PanelHeader size="window" divider={false} aria-label="Workspace header" data-workspace-header="" data-tauri-drag-region="">
    {windowControlsInset && <span className="block h-full w-[108px] shrink-0" aria-hidden="true" data-window-controls-reserve="" />}
    <div className="flex min-w-0 flex-1 items-center">{identity}</div>
    {!readOnly && <div className="flex shrink-0 items-center gap-1" data-workspace-header-actions="">{actions}{trailing}</div>}
  </PanelHeader>;
}

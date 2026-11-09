import { useState } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Activity, ArrowUpRight, Clock, FolderGit2 } from "lucide-react";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { Popover, PopoverContent } from "../../shared/ui/primitives/popover";
import { toast } from "../../shared/ui/primitives/elements";
import { shellOpenUrl } from "../../platform/app";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { describeWorkspaceRuntimeStatus, type WorkspaceAvailability } from "../workbench/tab-status-model";
import { formatCompactAge } from "../../features/agent/format-age";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";
import { manageCloudWorkspace } from "../../state/cloud-workspace-catalog";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../../state/workspace-store";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { useWorkbenchAvailability } from "../../state/workbench-availability";
import { WorkspaceIdentityLabel, WorkspaceIdentityTrigger, useWorkspaceDetailsOpen } from "./workspace-identity";

/** With this desktop's engine connection, Running waits until agents can run. */
export function cloudStatusLabel(status: string, availability?: WorkspaceAvailability): string {
  return describeWorkspaceRuntimeStatus({ connection: "connected", since: 0, ...availability, cloud: true, state: status }, Date.now());
}

/** A cloud workspace's name and cloud in its header, opening what it is and
 * whether it is running, with Start and Stop. Everything else is the Local
 * workspace UI. The header owns the document's subscription. */
export function CloudWorkspaceDetails({ folder, name, workspace }: {
  folder: string;
  name: string;
  workspace: CloudWorkspaceDocument | undefined;
}) {
  const target = parseCloudWorkspaceKey(folder);
  const allowed = useCloudWorkspaceAccountAccess(target?.organizationId);
  const pageActive = useWorkspaceStore(state => state.activePage === "workspace");
  const surfaceActive = useCloudWorkspaceSurfaceActive(pageActive);
  const { availability } = useWorkbenchAvailability(folder, surfaceActive);
  const [open, setOpen] = useWorkspaceDetailsOpen(pageActive);
  const shown = open && surfaceActive;
  const [changing, setChanging] = useState(false);
  if (!target || !allowed) return <WorkspaceIdentityLabel name={name} placement="cloud" />;
  const change = (operation: "wake" | "stop", failure: string) => {
    setChanging(true);
    void manageCloudWorkspace(target, operation)
      .catch(error => toast.error(failure, { description: error instanceof Error ? error.message : "Try again." }))
      .finally(() => setChanging(false));
  };
  const repositoryName = workspace ? `${workspace.repository.owner}/${workspace.repository.name}` : "";
  const repositoryUrl = workspace && /^[\w.-]+$/.test(workspace.repository.owner) && /^[\w.-]+$/.test(workspace.repository.name)
    ? `https://github.com/${encodeURIComponent(workspace.repository.owner)}/${encodeURIComponent(workspace.repository.name)}` : null;
  const createdAge = workspace ? formatCompactAge(Date.parse(workspace.createdAt), Date.now()) : "";
  const rows = workspace ? [
    { Icon: FolderGit2, label: "Repository", value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
      <Tooltip label={repositoryName}><span className="min-w-0 truncate">{repositoryName}</span></Tooltip>
      {repositoryUrl && <Tooltip label="Open repository"><IconButton size="compact" label="Open repository"
        onClick={() => { void shellOpenUrl(repositoryUrl).catch(() => toast.error("Couldn't open repository")); }}><ArrowUpRight /></IconButton></Tooltip>}
    </span> },
    { Icon: Clock, label: "Created", value: <Tooltip label={new Date(workspace.createdAt).toLocaleString()}>
      <span>{createdAge === "now" ? "Just now" : `${createdAge} ago`}</span></Tooltip> },
    { Icon: Activity, label: "Status", value: <span role="status">{cloudStatusLabel(workspace.status, availability)}</span> },
  ] : [];
  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <WorkspaceIdentityTrigger name={name} placement="cloud" open={shown} />
      <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
        {workspace ? (
          <>
            <p className="text-fg1 mb-3 truncate text-xs leading-4.5 font-medium">{workspace.name}</p>
            <dl className="space-y-2">
              {rows.map(({ Icon, label, value }) => (
                <div key={label} className="flex min-w-0 items-center gap-2">
                  <dt className="text-fg2 flex shrink-0 items-center gap-2 text-xs"><Icon size={14} strokeWidth={1.5} />{label}</dt>
                  <dd className="text-fg1 ml-auto min-w-0 text-right text-xs">{value}</dd>
                </div>
              ))}
            </dl>
            {workspace.capabilities.canStart && ["stopped", "failed"].includes(workspace.status) && (
              <Button size="sm" className="mt-3" disabled={changing} onClick={() => change("wake", "Couldn't start cloud workspace")}>
                {changing ? "Starting…" : "Start workspace"}
              </Button>
            )}
            {workspace.capabilities.canManage && ["ready", "busy"].includes(workspace.status) && (
              <Button size="sm" variant="secondary" className="mt-3" disabled={changing} onClick={() => change("stop", "Couldn't stop cloud workspace")}>
                {changing ? "Stopping…" : "Stop workspace"}
              </Button>
            )}
          </>
        ) : <p className="text-fg2 text-xs">Loading workspace details…</p>}
      </PopoverContent>
    </Popover>
  );
}

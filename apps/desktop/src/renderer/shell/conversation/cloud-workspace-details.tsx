import { useCallback, useState, useSyncExternalStore } from "react";
import { Activity, ArrowUpRight, Clock, Cloud, FolderGit2 } from "lucide-react";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "../../shared/ui/primitives/popover";
import { toast } from "../../shared/ui/primitives/elements";
import { shellOpenUrl } from "../../platform/app";
import { describeWorkspaceRuntimeStatus } from "../workbench/tab-status-model";
import { formatCompactAge } from "../../features/agent/format-age";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";
import { cloudWorkspaceDocument, manageCloudWorkspace, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { useWorkspaceStore } from "../../state/workspace-store";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";

export function cloudStatusLabel(status: string): string {
  return describeWorkspaceRuntimeStatus({ cloud: true, state: status, connection: "connected", since: 0 }, Date.now());
}

/** The cloud icon in a cloud workspace's header: what it is and whether it
 * is running, with Start and Stop. Everything else is the Local workspace UI. */
export function CloudWorkspaceDetails({ folder }: { folder: string }) {
  const target = parseCloudWorkspaceKey(folder);
  const allowed = useCloudWorkspaceAccountAccess(target?.organizationId);
  const surfaceActive = useCloudWorkspaceSurfaceActive(useWorkspaceStore(state => state.activePage === "workspace"));
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const subscribe = useCallback((listener: () => void) => subscribeCloudWorkspaces(listener), []);
  const read = useCallback(() => target ? cloudWorkspaceDocument(target) : undefined, [target]);
  const workspace = useSyncExternalStore(subscribe, read, read);
  if (!target || !allowed) return null;
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
      {repositoryUrl && <Tooltip label="Open repository"><Button variant="ghost" size="icon-compact" aria-label="Open repository"
        onClick={() => { void shellOpenUrl(repositoryUrl).catch(() => toast.error("Couldn't open repository")); }}><ArrowUpRight /></Button></Tooltip>}
    </span> },
    { Icon: Clock, label: "Created", value: <Tooltip label={new Date(workspace.createdAt).toLocaleString()}>
      <span>{createdAge === "now" ? "Just now" : `${createdAge} ago`}</span></Tooltip> },
    { Icon: Activity, label: "Status", value: <span role="status">{cloudStatusLabel(workspace.status)}</span> },
  ] : [];
  return (
    <Popover open={open && surfaceActive} onOpenChange={setOpen}>
      <Tooltip label="Workspace details" delayDuration={1500} disabled={open}>
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label="Cloud workspace details" className="text-fg2 size-7 shrink-0">
            <Cloud size={16} strokeWidth={1.5} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
        {workspace ? (
          <>
            <p className="text-fg1 mb-3 truncate text-sm font-medium">{workspace.name}</p>
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

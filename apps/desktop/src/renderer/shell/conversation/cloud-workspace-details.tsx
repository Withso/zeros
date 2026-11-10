import { useState, type ReactNode } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Activity, ArrowUpRight, Clock, Cloud, Cpu, FolderGit2, HardDrive, MemoryStick, RotateCw, type LucideIcon } from "lucide-react";
import type { CloudWorkspaceResources } from "@zeros/protocol/cloud-v2-relay";
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
import { useCloudWorkspaceAccountAccess, useSignedInUserName } from "../../features/team/cloud-workspace-account-access";
import { useWorkbenchAvailability } from "../../state/workbench-availability";
import { useCloudWorkspaceResources } from "../../platform/cloud-workspace-resources";
import { WorkspaceIdentityLabel, WorkspaceIdentityTrigger, useWorkspaceDetailsOpen } from "./workspace-identity";

/** With this desktop's engine connection, Running waits until agents can run. */
export function cloudStatusLabel(status: string, availability?: WorkspaceAvailability): string {
  return describeWorkspaceRuntimeStatus({ connection: "connected", since: 0, ...availability, cloud: true, state: status }, Date.now());
}

const formatBytes = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0).replace(/\.0$/, "")} GB`;
const formatPercent = (value: number) => `${Math.round(value)}% used`;
type LifecycleChange = "wake" | "stop" | "restart";

/** What a cloud workspace is and whether it runs: where, its repository, age
 * and status (with Start, Stop and Restart), then the VM's usage when its
 * worker reports it. Older workers report none, and those rows stay out. */
export function CloudWorkspaceDetailsCard({ workspace, title, statusLabel, resources, changing, onChange, creatorName }: {
  workspace: CloudWorkspaceDocument;
  title?: string;
  /** Known only when the signed-in account created it (cloud access is creator-only). */
  creatorName?: string | null;
  statusLabel: string;
  resources: CloudWorkspaceResources | null;
  changing: boolean;
  onChange(operation: LifecycleChange): void;
}) {
  const running = ["ready", "busy"].includes(workspace.status);
  const repositoryName = `${workspace.repository.owner}/${workspace.repository.name}`;
  const repositoryUrl = /^[\w.-]+$/.test(workspace.repository.owner) && /^[\w.-]+$/.test(workspace.repository.name)
    ? `https://github.com/${encodeURIComponent(workspace.repository.owner)}/${encodeURIComponent(workspace.repository.name)}` : null;
  const createdAge = formatCompactAge(Date.parse(workspace.createdAt), Date.now());
  const rows: Array<{ Icon: LucideIcon; label: string; value: ReactNode }> = [
    { Icon: Cloud, label: "Environment", value: "Zeros Cloud" },
    { Icon: FolderGit2, label: "Repository", value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
      <Tooltip label={repositoryName}><span className="min-w-0 truncate">{repositoryName}</span></Tooltip>
      {repositoryUrl && <Tooltip label="Open repository"><IconButton size="compact" label="Open repository"
        onClick={() => { void shellOpenUrl(repositoryUrl).catch(() => toast.error("Couldn't open repository")); }}><ArrowUpRight /></IconButton></Tooltip>}
    </span> },
    { Icon: Clock, label: "Created", value: <Tooltip label={new Date(workspace.createdAt).toLocaleString()}>
      <span>{creatorName ? `${creatorName} · ` : ""}{createdAge === "now" ? "Just now" : `${createdAge} ago`}</span></Tooltip> },
    { Icon: Activity, label: "Status", value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
      <span role="status">{statusLabel}</span>
      {workspace.capabilities.canManage && running && <Tooltip label="Restart workspace"><IconButton size="compact" label="Restart workspace"
        disabled={changing} onClick={() => onChange("restart")}><RotateCw /></IconButton></Tooltip>}
    </span> },
    ...(resources ? [
      { Icon: Cpu, label: "CPU", value: `${resources.cpu.cores} ${resources.cpu.cores === 1 ? "core" : "cores"} · ${formatPercent(resources.cpu.usedPercent)}` },
      { Icon: MemoryStick, label: "Memory", value: `${formatBytes(resources.memory.totalBytes)} · ${formatPercent(resources.memory.usedPercent)}` },
      { Icon: HardDrive, label: "Disk", value: `${formatBytes(resources.disk.totalBytes)} · ${formatPercent(resources.disk.usedPercent)}` },
    ] : []),
  ];
  return (
    <>
      <p className="text-fg1 mb-3 truncate text-xs leading-4.5 font-medium">{title?.trim() || workspace.name}</p>
      <dl className="space-y-2">
        {rows.map(({ Icon, label, value }) => (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <dt className="text-fg2 flex shrink-0 items-center gap-2 text-xs"><Icon size={14} strokeWidth={1.5} />{label}</dt>
            <dd className="text-fg1 ml-auto min-w-0 text-right text-xs">{value}</dd>
          </div>
        ))}
      </dl>
      {workspace.capabilities.canStart && ["stopped", "failed"].includes(workspace.status) && (
        <Button size="sm" className="mt-3" disabled={changing} onClick={() => onChange("wake")}>
          {changing ? "Starting…" : "Start workspace"}
        </Button>
      )}
      {workspace.capabilities.canManage && running && (
        <Button size="sm" variant="secondary" className="mt-3" disabled={changing} onClick={() => onChange("stop")}>
          {changing ? "Stopping…" : "Stop workspace"}
        </Button>
      )}
    </>
  );
}

/** A cloud workspace's name and cloud in its header, opening its details.
 * Everything else is the Local workspace UI. The header owns the document's
 * subscription. */
export function CloudWorkspaceDetails({ folder, name, title, workspace }: {
  folder: string;
  /** `w-<n>` when the workspace has a number. */
  name: string;
  /** Its title: the first chat's name, or "Untitled". */
  title?: string;
  workspace: CloudWorkspaceDocument | undefined;
}) {
  const target = parseCloudWorkspaceKey(folder);
  const allowed = useCloudWorkspaceAccountAccess(target?.organizationId);
  const creatorName = useSignedInUserName(workspace?.createdBy);
  const pageActive = useWorkspaceStore(state => state.activePage === "workspace");
  const surfaceActive = useCloudWorkspaceSurfaceActive(pageActive);
  const { availability } = useWorkbenchAvailability(folder, surfaceActive);
  const [open, setOpen] = useWorkspaceDetailsOpen(pageActive);
  const shown = open && surfaceActive;
  const [changing, setChanging] = useState(false);
  const running = !!workspace && ["ready", "busy"].includes(workspace.status);
  const resources = useCloudWorkspaceResources(target && allowed ? target : null, shown && running);
  if (!target || !allowed) return <WorkspaceIdentityLabel name={name} title={title} placement="cloud" />;
  const failures: Record<LifecycleChange, string> = { wake: "Couldn't start cloud workspace", stop: "Couldn't stop cloud workspace", restart: "Couldn't restart cloud workspace" };
  const change = (operation: LifecycleChange) => {
    setChanging(true);
    void manageCloudWorkspace(target, operation)
      .catch(error => toast.error(failures[operation], { description: error instanceof Error ? error.message : "Try again." }))
      .finally(() => setChanging(false));
  };
  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <WorkspaceIdentityTrigger name={name} title={title} placement="cloud" open={shown} />
      <PopoverContent align="start" sideOffset={6} className="w-[320px]" aria-label="Cloud workspace details">
        {workspace ? (
          <CloudWorkspaceDetailsCard workspace={workspace} title={title} creatorName={creatorName} statusLabel={cloudStatusLabel(workspace.status, availability)}
            resources={running ? resources : null} changing={changing} onChange={change} />
        ) : <p className="text-fg2 text-xs">Loading workspace details…</p>}
      </PopoverContent>
    </Popover>
  );
}

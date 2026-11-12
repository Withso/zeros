import { useState, type ReactNode } from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { Activity, ArrowUpRight, CircleDollarSign, Clock, Cloud, Cpu, FolderGit2, HardDrive, MemoryStick, Pencil, RotateCw, UserRound, Users, Wrench, type LucideIcon } from "lucide-react";
import type { CloudWorkspaceResources } from "@zeros/protocol/cloud-v2-relay";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { openReassignDialog } from "../../features/team/reassign-dialog";
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
import { ConnectedMacs } from "./connected-macs";
import { useWorkspaceMacs } from "./use-workspace-macs";
import { useMyUserId } from "../../platform/team-sharing-state";
import { renameSharedCloudWorkspace } from "../../state/team-sharing-actions";
import { Input } from "../../shared/ui/primitives/input";
import { memberName, useOrganizationRoster } from "../../state/organization-roster";
import { workspaceNumberName } from "../../shared/lib/workspace-name";
import { WorkspaceIdentityLabel, WorkspaceIdentityTrigger, useWorkspaceDetailsOpen } from "./workspace-identity";

/** With this desktop's engine connection, Running waits until agents can run. */
export function cloudStatusLabel(status: string, availability?: WorkspaceAvailability): string {
  return describeWorkspaceRuntimeStatus({ connection: "connected", since: 0, ...availability, cloud: true, state: status }, Date.now());
}

const formatBytes = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0).replace(/\.0$/, "")} GB`;
const formatPercent = (value: number) => `${Math.round(value)}% used`;
type LifecycleChange = "wake" | "stop" | "restart";
const SETUP_LABELS = { running: "Running", succeeded: "Succeeded", failed: "Failed", interrupted: "Interrupted" } as const;
function setupLabel(setup: NonNullable<CloudWorkspaceDocument["setup"]>): string {
  return setup.state === "failed" && setup.reason === "timed_out" ? "Failed · timed out" : SETUP_LABELS[setup.state];
}

/** What a cloud workspace is and whether it runs: where, its repository, age
 * and status (with Start, Stop and Restart), its setup and agent cost when the
 * document carries them, then the VM's usage when its worker reports it.
 * Older servers and workers report none, and those rows stay out. */
export function CloudWorkspaceDetailsCard({ workspace, title, statusLabel, resources, changing, onChange, creatorName, runnerName, followers, onRename, ownership }: {
  workspace: CloudWorkspaceDocument;
  /** Team sharing 3B: the current Creator's name (null: none), and Reassign for the Creator or an admin. Replaces "Runs it". */
  ownership?: { creatorName: string | null; onReassign?: () => void } | null;
  title?: string;
  /** Team sharing: who runs it now, when that is not who created it. */
  runnerName?: string | null;
  /** Team sharing: the followers' names and how many follow. */
  followers?: { names: string[]; count: number } | null;
  /** Team sharing: rename through the control plane (the Creator and admins). */
  onRename?: (name: string) => Promise<void>;
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
    ...(ownership ? [{ Icon: UserRound, label: "Creator", value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
      <span className="min-w-0 truncate">{ownership.creatorName ?? (ownership.onReassign ? "None" : "None · An admin can reassign it.")}</span>
      {ownership.onReassign && <Button type="button" variant="ghost" size="compact" onClick={ownership.onReassign}>Reassign…</Button>}
    </span> }]
      : runnerName ? [{ Icon: UserRound, label: "Runs it", value: <span className="min-w-0 truncate">{runnerName}</span> }] : []),
    ...(followers ? [{ Icon: Users, label: "Followers", value: followers.count === 0 ? "None" : (
      <Tooltip label={followers.names.join(", ") + (followers.count > followers.names.length ? ` and ${followers.count - followers.names.length} more` : "")}>
        <span className="min-w-0 truncate">{followers.count === 1 ? followers.names[0] ?? "1 person" : `${followers.count} people`}</span>
      </Tooltip>
    ) }] : []),
    { Icon: Activity, label: "Status", value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
      <span role="status">{statusLabel}</span>
      {/* Restart is the Creator's, or (team writing) any member it executes for: an admin may stop a teammate's workspace, never restart it. */}
      {runsAsViewer(workspace) && running && <Tooltip label="Restart workspace"><IconButton size="compact" label="Restart workspace"
        disabled={changing} onClick={() => onChange("restart")}><RotateCw /></IconButton></Tooltip>}
    </span> },
    ...(workspace.setup ? [{ Icon: Wrench, label: "Setup", value: setupLabel(workspace.setup) }] : []),
    // Same rounding as a turn's usage card.
    ...(workspace.agentCost ? [{ Icon: CircleDollarSign, label: "Agent cost",
      value: `$${workspace.agentCost.totalUsd.toFixed(2)}${workspace.agentCost.estimated ? " · estimated" : ""}` }] : []),
    ...(resources ? [
      { Icon: Cpu, label: "CPU", value: `${resources.cpu.cores} ${resources.cpu.cores === 1 ? "core" : "cores"} · ${formatPercent(resources.cpu.usedPercent)}` },
      { Icon: MemoryStick, label: "Memory", value: `${formatBytes(resources.memory.totalBytes)} · ${formatPercent(resources.memory.usedPercent)}` },
      { Icon: HardDrive, label: "Disk", value: `${formatBytes(resources.disk.totalBytes)} · ${formatPercent(resources.disk.usedPercent)}` },
    ] : []),
  ];
  return (
    <>
      {onRename ? <RenameableTitle name={workspace.name} title={title?.trim() || workspace.name} onRename={onRename} />
        : <p className="text-fg1 mb-3 truncate text-xs leading-4.5 font-medium">{title?.trim() || workspace.name}</p>}
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
      {(workspace.capabilities.canManage || runsAsViewer(workspace)) && running && (
        <Button size="sm" variant="secondary" className="mt-3" disabled={changing} onClick={() => onChange("stop")}>
          {changing ? "Stopping…" : "Stop workspace"}
        </Button>
      )}
    </>
  );
}

/** The viewer runs this workspace's lifecycle as themself: its Creator, or a member of an activated (team writing) workspace that executes for them. */
const runsAsViewer = (workspace: CloudWorkspaceDocument) => !workspace.sharing?.readOnly &&
  (workspace.capabilities.canManage || workspace.sharing?.teamWriting === true);

function RenameableTitle({ name, title, onRename }: { name: string; title: string; onRename: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const commit = () => {
    const next = editing?.trim() ?? "";
    if (!next || next === name || busy) { setEditing(null); return; }
    setBusy(true);
    void onRename(next).then(() => setEditing(null), error => toast.error("Couldn't rename workspace", { description: error instanceof Error ? error.message : "Try again." }))
      .finally(() => setBusy(false));
  };
  if (editing !== null) return (
    <Input autoFocus className="mb-3" aria-label="Workspace name" value={editing} maxLength={120} disabled={busy}
      onChange={event => setEditing(event.target.value)} onBlur={commit}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); commit(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(null); }
      }} />
  );
  return (
    <div className="mb-3 flex min-w-0 items-center gap-1">
      <p className="text-fg1 min-w-0 flex-1 truncate text-xs leading-4.5 font-medium">{title}</p>
      <Tooltip label="Rename workspace"><IconButton size="compact" label="Rename workspace" onClick={() => setEditing(name)}><Pencil /></IconButton></Tooltip>
    </div>
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
  const signedInCreatorName = useSignedInUserName(workspace?.createdBy);
  const sharing = workspace?.sharing;
  const me = useMyUserId();
  const pageActive = useWorkspaceStore(state => state.activePage === "workspace");
  const roster = useOrganizationRoster(sharing ? target?.organizationId : null, pageActive && !!sharing);
  const nameOf = (id: string | null | undefined) => (id && id === me ? "You" : memberName(roster, id));
  const creatorName = sharing ? nameOf(sharing.createdByUserId) : signedInCreatorName;
  const runnerName = sharing && workspace?.ownerUserId && workspace.ownerUserId !== sharing.createdByUserId ? nameOf(workspace.ownerUserId) : null;
  const followers = sharing ? { names: sharing.followerIds.slice(0, 10).map(nameOf), count: sharing.followerCount } : null;
  // A reader never reads the worker's usage or the Creator's connected Macs.
  const reader = sharing?.readOnly === true;
  const surfaceActive = useCloudWorkspaceSurfaceActive(pageActive);
  const { availability } = useWorkbenchAvailability(folder, surfaceActive);
  const [open, setOpen] = useWorkspaceDetailsOpen(pageActive);
  const shown = open && surfaceActive;
  const [changing, setChanging] = useState(false);
  const running = !!workspace && ["ready", "busy"].includes(workspace.status);
  const resources = useCloudWorkspaceResources(target && allowed && !reader ? target : null, shown && running);
  const macs = useWorkspaceMacs(target && allowed && !reader ? target.workspaceId : null, shown,
    workspace ? { repository: workspace.repository.name, workspace: workspaceNumberName(workspace) ?? workspace.name } : undefined);
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
          <CloudWorkspaceDetailsCard workspace={workspace} title={title} creatorName={creatorName} runnerName={runnerName} followers={followers}
            ownership={sharing?.ownership ? { creatorName: workspace.ownerUserId ? nameOf(workspace.ownerUserId) : null,
              ...(sharing.ownership.canReassign ? { onReassign: () => openReassignDialog(target) } : {}) } : null}
            onRename={sharing && workspace.capabilities.canManage ? name => renameSharedCloudWorkspace(target, name) : undefined} statusLabel={cloudStatusLabel(workspace.status, availability)}
            resources={running ? resources : null} changing={changing} onChange={change} />
        ) : <p className="text-fg2 text-xs">Loading workspace details…</p>}
        {workspace && !reader && macs.macs && <ConnectedMacs macs={macs.macs} now={Date.now()} busyDeviceId={macs.busyDeviceId} onConnect={macs.connect} onDisconnect={macs.disconnect} sync={macs.sync} onSetWanted={macs.setWanted} />}
      </PopoverContent>
    </Popover>
  );
}

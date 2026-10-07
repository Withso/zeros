import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Clock,
  Cloud,
  Cpu,
  FolderGit2,
  HardDrive,
  MemoryStick,
  ArrowUpRight,
  Ellipsis,
  Pencil,
  Check,
  X,
  Wrench,
} from "lucide-react";
import { Button, Input, Tooltip } from "../../shared/ui/primitives";
import { Avatar, AvatarFallback, AvatarImage } from "../../shared/ui/primitives/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../shared/ui/primitives/dropdown-menu";
import { shellOpenUrl } from "../../platform/app";
import { describeWorkspaceRuntimeStatus } from "../workbench/tab-status-model";
import { formatCompactAge } from "../../features/agent/format-age";
import { CloudWorkspaceStatusRow } from "./cloud-workspace-restart-controls";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  cloudWorkspaceDetails,
  canReadCloudWorkspace,
  acceptCloudWorkspaceDocument,
  cloudWorkspaceDocument,
  cloudCatalogGeneration,
  manageCloudWorkspace,
  manageCloudWorkspaceRecovery,
  refreshCloudWorkspace,
} from "../../state/cloud-workspace-catalog";
import { useCachedRead } from "../../state/use-cached-read";
import { useCloudWorkspaceResourceUsage } from "../../state/use-cloud-workspace-resource-usage";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import { getOrganizationStoreGeneration, useTeams } from "../../features/team/team-store";
import { CloudWorkspaceSetupFailure } from "./cloud-workspace-setup-failure";
import { renameCloudWorkspace, type CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import { toast } from "../../shared/ui/primitives/elements";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
import { hasCloudWorkspaceAccountAccess, useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { warmCloudServiceAccess } from "../../platform/cloud-workspace-access";
import { CloudWorkspaceAccessControls } from "./cloud-workspace-access-controls";
import { useNativeRuntime } from "../../platform/runtime";
import { useWorkspaceStore } from "../../state/workspace-store";
import { warmCloudWorkspaceReplicas } from "../../state/cloud-replica-cache";
import { CloudWorkspaceSyncControls } from "./cloud-workspace-sync-controls";
import { CloudWorkspaceRuntimeControls } from "./cloud-workspace-runtime-controls";
import { subscribeCloudRuntimeUpgradeDetails, warmCloudRuntimeUpgrade } from "../../state/cloud-runtime-upgrade";

export function cloudStatusLabel(status: string): string {
  return (
    (
      {
        restoring: "Restoring workspace from saved checkpoint",
        waiting_for_capacity: "Recovery is waiting for capacity",
        waiting_for_funding: "Recovery is waiting for compute funding",
        recovery_needed: "Recovery needs attention",
      } as Record<string, string>
    )[status] ?? describeWorkspaceRuntimeStatus({ cloud: true, state: status, connection: "connected", since: 0 }, Date.now())
  );
}

/** The view accepts the same nested observations as the usage facade. Native
 * paths and grants never enter this presentation contract. */
export interface CloudWorkspaceUsage {
  organizationId: string;
  workspaceId: string;
  generation: number;
  cpu: { cores: number | null; usedPercent: number | null };
  memory: { totalBytes: number | null; usedPercent: number | null };
  disk: { totalBytes: number | null; usedPercent: number | null };
}

export function CloudWorkspaceDetailsContent({
  workspace,
  creator,
  resourceUsage,
  status,
  more,
  onRename,
  now = Date.now(),
}: {
  workspace: CloudWorkspaceDocument;
  creator: string;
  resourceUsage?: CloudWorkspaceUsage | null;
  status?: ReactNode;
  more?: ReactNode;
  onRename?: (name: string, version: number) => Promise<void>;
  now?: number;
}) {
  const resources = workspace.generation.resources;
  const recoveryState = workspace.recovery?.state;
  const refusal = cloudWorkspaceExecutionRefusal(workspace);
  const usage = ["ready", "busy"].includes(workspace.status) && !recoveryState && !refusal &&
    resourceUsage?.organizationId === workspace.organizationId && resourceUsage.workspaceId === workspace.id &&
    resourceUsage.generation === workspace.generation.number ? resourceUsage : null;
  const repositoryName = `${workspace.repository.owner}/${workspace.repository.name}`;
  const createdAge = formatCompactAge(Date.parse(workspace.createdAt), now);
  const repositoryUrl = ["github", "github.com"].includes(workspace.repository.forge) &&
    /^[\w.-]+$/.test(workspace.repository.owner) && /^[\w.-]+$/.test(workspace.repository.name)
    ? `https://github.com/${encodeURIComponent(workspace.repository.owner)}/${encodeURIComponent(workspace.repository.name)}` : null;
  const setup = refusal ? "Unavailable" : workspace.setupFailure ? "Setup failed" : recoveryState ? cloudStatusLabel(recoveryState) : ["ready", "busy", "stopped", "archived"].includes(
    workspace.status,
  )
    ? "Setup succeeded"
    : workspace.error
      ? "Setup failed"
      : "Setting up";
  const rows = [
    {
      Icon: FolderGit2,
      label: "Repository",
      value: <span className="inline-flex min-w-0 items-center justify-end gap-1">
        <Avatar className="size-4 shrink-0">
          {repositoryUrl && <AvatarImage src={`https://github.com/${encodeURIComponent(workspace.repository.owner)}.png?size=32`} alt="" />}
          <AvatarFallback className="text-xxs">{workspace.repository.owner.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <Tooltip label={repositoryName}><span className="min-w-0 truncate">{repositoryName}</span></Tooltip>
        {repositoryUrl && <Tooltip label="Open repository"><Button variant="ghost" size="icon-compact" aria-label="Open repository"
          onClick={() => { void shellOpenUrl(repositoryUrl).catch(() => toast.error("Couldn't open repository")); }}><ArrowUpRight /></Button></Tooltip>}
      </span>,
    },
    {
      Icon: Clock,
      label: "Created",
      value: <Tooltip label={new Date(workspace.createdAt).toLocaleString()}>
        <span className="min-w-0 truncate">{creator} · {createdAge === "now" ? "Just now" : `${createdAge} ago`}</span>
      </Tooltip>,
    },
    { Icon: Wrench, label: "Setup", value: setup },
    { Icon: Cloud, label: "Environment", value: "Zeros Cloud" },
    {
      Icon: Activity,
      label: "Status",
      value: status ?? <span role="status" className="inline-flex items-center gap-1.5">
        {!refusal && cloudStatusLabel(recoveryState ?? workspace.status) === "Running" && <span className="bg-green-primary size-1.5 rounded-full" aria-hidden="true" />}
        {cloudStatusLabel(refusal ? "failed" : recoveryState ?? workspace.status)}
      </span>,
    },
    {
      Icon: Cpu,
      label: "CPU",
      value: <ResourceValue capacity={`${usage?.cpu.cores ?? resources.cpuMillicores / 1000} cores`} percent={usage?.cpu.usedPercent} />,
    },
    {
      Icon: MemoryStick,
      label: "Memory",
      value: <ResourceValue capacity={formatGigabytes(usage?.memory.totalBytes ?? resources.memoryMiB * 1024 * 1024)} percent={usage?.memory.usedPercent} />,
    },
    {
      Icon: HardDrive,
      label: "Disk",
      value: <ResourceValue capacity={formatGigabytes(usage?.disk.totalBytes ?? resources.storageMiB * 1024 * 1024)} percent={usage?.disk.usedPercent} />,
    },
  ];
  return (
    <>
      <div className="mb-3 flex min-w-0 items-center gap-1">
        <WorkspaceName key={`${workspace.organizationId}:${workspace.id}`} workspace={workspace} onRename={onRename} />
        {more ?? <Button variant="ghost" size="icon-compact" disabled aria-label="More workspace actions"><Ellipsis /></Button>}
      </div>
      <dl className="space-y-2">
        {rows.map(({ Icon, label, value }, index) => (
          <div
            key={label}
            className={
              index === 3
                ? "border-border1 flex min-w-0 items-center gap-2 border-t pt-3"
                : "flex min-w-0 items-center gap-2"
            }
          >
            <dt className="text-fg2 flex shrink-0 items-center gap-2 text-xs">
              <Icon size={14} strokeWidth={1.5} />
              {label}
            </dt>
            <dd className="text-fg1 ml-auto min-w-0 text-right text-xs">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {recoveryState && workspace.recovery?.checkpointAt && (
        <p className="text-fg3 mt-3 text-xs">Saved checkpoint · {new Date(workspace.recovery.checkpointAt).toLocaleString()}</p>
      )}
      {refusal && <p className="text-fg2 mt-3 text-xs" role="alert">{refusal.message}</p>}
      {!refusal && workspace.setupFailure && (
        <div className="mt-3"><CloudWorkspaceSetupFailure failure={workspace.setupFailure} /></div>
      )}
      {!refusal && workspace.error && !recoveryState && !workspace.setupFailure && (
        <p className="text-red-primary mt-3 text-xs" role="alert">
          {workspace.error.message}
        </p>
      )}
    </>
  );
}

function formatGigabytes(bytes: number): string {
  return `${Number((bytes / 1_000_000_000).toFixed(1))} GB`;
}

function ResourceValue({ capacity, percent }: { capacity: string; percent?: number | null }) {
  const available = percent !== null && percent !== undefined && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  return <span className="inline-flex items-center gap-1">
    <span className="text-muted-fg">{capacity}</span><span className="text-muted-fg" aria-hidden="true">·</span>
    <span>{available ? `${Number(percent.toFixed(1))}% used` : <Tooltip label="Live usage unavailable"><span aria-label="Live usage unavailable">—</span></Tooltip>}</span>
  </span>;
}

function WorkspaceName({ workspace, onRename }: { workspace: CloudWorkspaceDocument; onRename?: (name: string, version: number) => Promise<void> }) {
  const [draft, setDraft] = useState<{ name: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = () => {
    if (!draft || !onRename || pending.current || !workspace.capabilities.canManage || !draft.name.trim()) return;
    pending.current = true; setBusy(true);
    void onRename(draft.name.trim(), draft.version).then(() => {
      if (alive.current) { setDraft(null); toast.success("Workspace renamed"); }
    }).catch(error => { if (alive.current) toast.error("Couldn't rename workspace", { description: error instanceof Error ? error.message : "Try again." }); })
      .finally(() => { pending.current = false; if (alive.current) setBusy(false); });
  };
  if (draft) return <form className="flex min-w-0 flex-1 items-center gap-1" onSubmit={event => { event.preventDefault(); save(); }}>
    <Input aria-label="Workspace name" maxLength={120} value={draft.name} disabled={busy} autoFocus
      onChange={event => setDraft({ ...draft, name: event.target.value })} onKeyDown={event => { if (event.key === "Escape" && !busy) { event.preventDefault(); setDraft(null); } }} />
    <Button type="submit" variant="ghost" size="icon-compact" aria-label="Save workspace name" disabled={busy || !draft.name.trim()}><Check /></Button>
    <Button type="button" variant="ghost" size="icon-compact" aria-label="Cancel rename" disabled={busy} onClick={() => setDraft(null)}><X /></Button>
  </form>;
  return <>
    <Tooltip label={workspace.name}><h2 className="text-fg1 min-w-0 flex-1 truncate text-sm font-medium">{workspace.name}</h2></Tooltip>
    <Tooltip label={workspace.capabilities.canManage ? "Rename workspace" : "Workspace management access is required to rename"}>
      <span className="inline-flex"><Button variant="ghost" size="icon-compact" aria-label="Rename workspace" disabled={!workspace.capabilities.canManage || !onRename}
        onClick={() => setDraft({ name: workspace.name, version: workspace.version })}><Pencil /></Button></span>
    </Tooltip>
  </>;
}

function WorkspaceMore({ workspace, active, focusRequest }: { workspace: CloudWorkspaceDocument; active: boolean; focusRequest: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (focusRequest && active) setOpen(true); }, [focusRequest, active]);
  return <DropdownMenu open={open && active} onOpenChange={setOpen}>
    <Tooltip label="More workspace actions"><DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon-compact" aria-label="More workspace actions"><Ellipsis /></Button>
    </DropdownMenuTrigger></Tooltip>
    <DropdownMenuContent align="end" className="w-64 p-3">
      <CloudWorkspaceRuntimeControls workspace={workspace} active={open && active} focusRequest={focusRequest} />
    </DropdownMenuContent>
  </DropdownMenu>;
}

export function CloudWorkspaceDetails({ folder }: { folder: string }) {
  const target = parseCloudWorkspaceKey(folder);
  const nativeAccessEnabled = useCloudWorkspaceAccountAccess(target?.organizationId);
  const key = target ? cloudWorkspaceKey(target) : null;
  const [open, setOpen] = useState(false);
  const [runtimeFocusRequest, setRuntimeFocusRequest] = useState(0);
  const [starting, setStarting] = useState(false);
  const [acknowledgedCheckpoint, setAcknowledgedCheckpoint] = useState<string | null>(null);
  const { me } = useTeams();
  const syncEnabled = nativeAccessEnabled;
  const native = useNativeRuntime().ready;
  const surfaceActive = useCloudWorkspaceSurfaceActive(useWorkspaceStore(state => state.activePage === "workspace"));
  const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration();
  useEffect(() => subscribeCloudRuntimeUpgradeDetails(intent => {
    if (!nativeAccessEnabled || !surfaceActive || intent.account !== account || intent.catalog !== catalog ||
      account !== getOrganizationStoreGeneration() || catalog !== cloudCatalogGeneration() || cloudWorkspaceKey(intent) !== key) return;
    setRuntimeFocusRequest(version => version + 1);
    setOpen(true);
  }), [nativeAccessEnabled, surfaceActive, account, catalog, key]);
  const mounted = useRef(false);
  const warmSurface = useRef({ key, active: surfaceActive, account, catalog });
  warmSurface.current = { key, active: surfaceActive, account, catalog };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!surfaceActive) { setOpen(false); setRuntimeFocusRequest(0); } }, [surfaceActive]);
  const details = useCachedRead(
    cloudWorkspaceDetails,
    key,
    (value) => refreshCloudWorkspace(parseCloudWorkspaceKey(value)!),
    { enabled: open && surfaceActive && nativeAccessEnabled, maxAgeMs: 10_000 },
  );
  const resourceUsage = useCloudWorkspaceResourceUsage(key, { active: surfaceActive, open, featureActive: nativeAccessEnabled });
  if (!key || !nativeAccessEnabled) return null;
  const warm = () => {
    if (!surfaceActive) return;
    const confirmed = cloudWorkspaceDetails.peekSnapshot(key).data;
    if (nativeAccessEnabled && confirmed?.capabilities.canManage && !cloudWorkspaceExecutionRefusal(confirmed)) warmCloudRuntimeUpgrade(target!, confirmed.generation.number);
    if (nativeAccessEnabled && target && canReadCloudWorkspace(confirmed)) void warmCloudServiceAccess(target).catch(() => {});
    void cloudWorkspaceDetails
      .load(key, () => refreshCloudWorkspace(parseCloudWorkspaceKey(key)!), {
        maxAgeMs: 10_000,
      })
      .then(workspace => {
        if (!mounted.current || !warmSurface.current.active || warmSurface.current.key !== key ||
          warmSurface.current.account !== account || warmSurface.current.catalog !== catalog) return;
        if (nativeAccessEnabled) {
          if (workspace.capabilities.canManage && !cloudWorkspaceExecutionRefusal(workspace)) warmCloudRuntimeUpgrade(target!, workspace.generation.number);
        }
        if (syncEnabled && native && surfaceActive && me?.user.id && workspace.capabilities.canEdit === true) {
          return warmCloudWorkspaceReplicas(me.user.id, parseCloudWorkspaceKey(key)!);
        }
      })
      .catch(() => {});
  };
  const rename = async (name: string, version: number) => {
    const current = () => mounted.current && warmSurface.current.active && warmSurface.current.key === key &&
      hasCloudWorkspaceAccountAccess(target!.organizationId) &&
      account === getOrganizationStoreGeneration() && catalog === cloudCatalogGeneration();
    if (!current() || !details.data?.capabilities.canManage) throw new Error("Workspace management access is required to rename.");
    try {
      const workspace = await renameCloudWorkspace(target!, { name, version }, crypto.randomUUID());
      if (!current() || !cloudWorkspaceDocument(target!)) throw new Error("The cloud workspace changed.");
      acceptCloudWorkspaceDocument(workspace);
    } finally {
      // Success and version conflicts both converge on the exact catalog read.
      if (current()) void refreshCloudWorkspace(target!).catch(() => {});
    }
  };
  return (
    <Popover open={open && surfaceActive} onOpenChange={next => { setRuntimeFocusRequest(0); setOpen(next); }}>
      <Tooltip label="Cloud workspace details">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cloud workspace details"
            className="text-fg2 size-7 shrink-0"
            onPointerEnter={warm}
            onFocus={warm}
          >
            <Cloud size={16} strokeWidth={1.5} />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="max-h-[min(80vh,var(--radix-popover-content-available-height))] w-[360px] overflow-y-auto"
        aria-label="Cloud workspace details"
        onOpenAutoFocus={event => { if (runtimeFocusRequest) event.preventDefault(); }}
      >
        {details.data ? (
          <CloudWorkspaceDetailsContent
            workspace={details.data}
            creator={
              details.data.createdByDisplayName ?? (me?.user.id === details.data.createdBy
                ? (me.user.displayName ?? "You")
                : "Workspace member")
            }
            resourceUsage={resourceUsage.data}
            onRename={rename}
            status={nativeAccessEnabled ? <CloudWorkspaceStatusRow folder={key} active={open && surfaceActive} inline /> : undefined}
            more={nativeAccessEnabled && details.data.capabilities.canManage && !cloudWorkspaceExecutionRefusal(details.data) ? <WorkspaceMore workspace={details.data} active={open && surfaceActive} focusRequest={runtimeFocusRequest} /> : undefined}
          />
        ) : (
          <p className="text-fg2 text-xs">
            {details.error?.message ?? "Loading workspace details…"}
          </p>
        )}
        {details.data && details.error && (
          <p className="text-fg3 mt-3 text-xs" role="status">
            Couldn’t refresh. Showing the last confirmed details.
          </p>
        )}
        {details.data?.recovery?.checkpointId && !cloudWorkspaceExecutionRefusal(details.data) && details.data.recovery.state !== "restoring" &&
          (details.data.recovery.state || details.data.status === "failed") &&
          ["failed", "stopped", "archived"].includes(details.data.status) && (
            <div className="mt-3">
              {details.data.recovery.needsAcknowledgement && (
                <label className="text-fg2 mb-2 flex items-start gap-2 text-xs">
                  <Checkbox checked={acknowledgedCheckpoint === `${key}:${details.data.recovery.checkpointId}`}
                    onChange={() => setAcknowledgedCheckpoint(acknowledgedCheckpoint === `${key}:${details.data!.recovery!.checkpointId}` ? null : `${key}:${details.data!.recovery!.checkpointId}`)} />
                  Recovering may discard changes after this saved checkpoint.
                </label>
              )}
              <Button size="sm" disabled={starting || me?.user.id !== details.data.ownerUserId || !details.data.capabilities.canManage ||
                (details.data.recovery.needsAcknowledgement && acknowledgedCheckpoint !== `${key}:${details.data.recovery.checkpointId}`)}
                onClick={() => {
                  const recovery = details.data!.recovery!;
                  setStarting(true);
                  void manageCloudWorkspaceRecovery(target!, { sourceGeneration: recovery.sourceGeneration, checkpointId: recovery.checkpointId!,
                    ...(recovery.needsAcknowledgement ? { allowDataLoss: true } : {}) })
                    .catch(error => toast.error("Couldn't recover cloud workspace", { description: error instanceof Error ? error.message : "Try again." }))
                    .finally(() => setStarting(false));
                }}>
                {starting ? "Restoring…" : details.data.recovery.state?.startsWith("waiting_") ? "Retry recovery" : "Recover workspace"}
              </Button>
            </div>
          )}
        {details.data && !cloudWorkspaceExecutionRefusal(details.data) && !details.data.recovery?.state &&
          ["stopped", "archived"].includes(details.data.status) && (
            <div className="mt-3">
              <Button
                size="sm"
                disabled={starting || !details.data.capabilities.canStart}
                onClick={() => {
                  setStarting(true);
                  void manageCloudWorkspace(target!, "wake")
                    .catch((error) =>
                      toast.error("Couldn't start cloud workspace", {
                        description:
                          error instanceof Error ? error.message : "Try again.",
                      }),
                    )
                    .finally(() => setStarting(false));
                }}
              >
                {starting ? "Starting…" : "Start workspace"}
              </Button>
              {!details.data.capabilities.canStart && (
                <p className="text-fg3 mt-2 text-xs">
                  {details.data.capabilities.startUnavailableReason}
                </p>
              )}
            </div>
          )}
        {details.data && !cloudWorkspaceExecutionRefusal(details.data) && <CloudWorkspaceAccessControls workspace={details.data} active={open && surfaceActive} mode="ssh" />}
        {details.data && <CloudWorkspaceSyncControls key={`${me?.user.id}:${key}`} workspace={details.data} active={open && surfaceActive} />}
      </PopoverContent>
    </Popover>
  );
}

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Clock,
  Cloud,
  Cpu,
  FolderGit2,
  HardDrive,
  MemoryStick,
  Wrench,
} from "lucide-react";
import { Button } from "../../shared/ui";
import { Tooltip } from "../../shared/ui/primitives";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  cloudWorkspaceDetails,
  manageCloudWorkspace,
  manageCloudWorkspaceRecovery,
  refreshCloudWorkspace,
} from "../../state/cloud-workspace-catalog";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cloudWorkspaceKey,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import { useTeams } from "../../features/team/team-store";
import { CloudWorkspaceSetupFailure } from "./cloud-workspace-setup-failure";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { toast } from "../../shared/ui/primitives/elements";
import { Checkbox } from "../../shared/ui/primitives/checkbox";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import { warmCloudServiceAccess } from "../../platform/cloud-workspace-access";
import { CloudWorkspaceAccessControls } from "./cloud-workspace-access-controls";
import { useNativeRuntime } from "../../platform/runtime";
import { useWorkspaceStore } from "../../state/workspace-store";
import { warmCloudWorkspaceReplicas } from "../../state/cloud-replica-cache";
import { CloudWorkspaceSyncControls } from "./cloud-workspace-sync-controls";
import { cloudWorkspaceCollaborationKey, cloudWorkspaceCollaborationOwner, warmCloudWorkspaceCollaboration } from "../../state/cloud-workspace-collaboration-cache";
import { CloudWorkspaceSharingControls } from "./cloud-workspace-sharing-controls";

export function cloudStatusLabel(status: string): string {
  return (
    (
      {
        ready: "Running",
        busy: "Running",
        creating: "Creating",
        provisioning: "Setting up",
        starting: "Starting",
        stopping: "Stopping",
        stopped: "Stopped",
        archived: "Archived",
        error: "Needs attention",
        failed: "Setup failed",
        restoring: "Restoring workspace from saved checkpoint",
        waiting_for_capacity: "Recovery is waiting for capacity",
        waiting_for_funding: "Recovery is waiting for compute funding",
        recovery_needed: "Recovery needs attention",
      } as Record<string, string>
    )[status] ?? status.replaceAll("_", " ")
  );
}

export function CloudWorkspaceDetailsContent({
  workspace,
  creator,
}: {
  workspace: CloudWorkspaceDocument;
  creator: string;
}) {
  const resources = workspace.generation.resources;
  const recoveryState = workspace.recovery?.state;
  const setup = workspace.setupFailure ? "Setup failed" : recoveryState ? cloudStatusLabel(recoveryState) : ["ready", "busy", "stopped", "archived"].includes(
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
      value: `${workspace.repository.owner}/${workspace.repository.name}`,
    },
    {
      Icon: Clock,
      label: "Created",
      value: `${creator} · ${new Date(workspace.createdAt).toLocaleDateString()}`,
    },
    { Icon: Wrench, label: "Setup", value: setup },
    { Icon: Cloud, label: "Environment", value: "Zeros Cloud" },
    {
      Icon: Activity,
      label: "Status",
      value: cloudStatusLabel(recoveryState ?? workspace.status),
    },
    {
      Icon: Cpu,
      label: "CPU",
      value: `${resources.cpuMillicores / 1000} cores`,
    },
    {
      Icon: MemoryStick,
      label: "Memory",
      value: `${Number((resources.memoryMiB / 1024).toFixed(2))} GiB`,
    },
    {
      Icon: HardDrive,
      label: "Disk",
      value: `${Number((resources.storageMiB / 1024).toFixed(2))} GiB`,
    },
  ];
  return (
    <>
      <h2 className="text-fg1 mb-3 truncate text-sm font-medium">
        {workspace.name}
      </h2>
      <dl className="space-y-3">
        {rows.map(({ Icon, label, value }, index) => (
          <div
            key={label}
            className={
              index === 3
                ? "border-border1 flex items-start gap-3 border-t pt-3"
                : "flex items-start gap-3"
            }
          >
            <dt className="text-fg2 flex shrink-0 items-center gap-2 text-xs">
              <Icon size={14} strokeWidth={1.5} />
              {label}
            </dt>
            <dd className="text-fg1 ml-auto min-w-0 text-right text-xs break-words">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {recoveryState && workspace.recovery?.checkpointAt && (
        <p className="text-fg3 mt-3 text-xs">Saved checkpoint · {new Date(workspace.recovery.checkpointAt).toLocaleString()}</p>
      )}
      {workspace.setupFailure && (
        <div className="mt-3"><CloudWorkspaceSetupFailure failure={workspace.setupFailure} /></div>
      )}
      {workspace.error && !recoveryState && !workspace.setupFailure && (
        <p className="text-error mt-3 text-xs" role="alert">
          {workspace.error.message}
        </p>
      )}
    </>
  );
}

export function CloudWorkspaceDetails({ folder }: { folder: string }) {
  const nativeAccessEnabled = useInternalFeatureActive("cloudComputerV2");
  const target = parseCloudWorkspaceKey(folder);
  const key = target ? cloudWorkspaceKey(target) : null;
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [acknowledgedCheckpoint, setAcknowledgedCheckpoint] = useState<string | null>(null);
  const { me } = useTeams();
  const syncEnabled = useInternalFeatureActive("cloudComputerV2");
  const native = useNativeRuntime().ready;
  const surfaceActive = useWorkspaceStore(state => state.activePage === "workspace");
  const sharingActive = useInternalFeatureActive("cloudComputerV2");
  const mounted = useRef(false);
  const warmSurface = useRef({ key, active: sharingActive && surfaceActive });
  warmSurface.current = { key, active: sharingActive && surfaceActive };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!surfaceActive) setOpen(false); }, [surfaceActive]);
  const details = useCachedRead(
    cloudWorkspaceDetails,
    key,
    (value) => refreshCloudWorkspace(parseCloudWorkspaceKey(value)!),
    { enabled: open && surfaceActive, maxAgeMs: 10_000 },
  );
  if (!key) return null;
  const warm = () => {
    if (!surfaceActive) return;
    if (nativeAccessEnabled && target) void warmCloudServiceAccess(target).catch(() => {});
    const owner = sharingActive ? cloudWorkspaceCollaborationOwner(target!) : null;
    const ownerKey = owner ? cloudWorkspaceCollaborationKey(owner) : null;
    if (sharingActive) warmCloudWorkspaceCollaboration(target!);
    void cloudWorkspaceDetails
      .load(key, () => refreshCloudWorkspace(parseCloudWorkspaceKey(key)!), {
        maxAgeMs: 10_000,
      })
      .then(workspace => {
        if (mounted.current && warmSurface.current.active && warmSurface.current.key === key && ownerKey) {
          const currentOwner = cloudWorkspaceCollaborationOwner(target!);
          if (currentOwner && cloudWorkspaceCollaborationKey(currentOwner) === ownerKey)
            warmCloudWorkspaceCollaboration(target!);
        }
        if (syncEnabled && native && surfaceActive && me?.user.id && workspace.capabilities.canEdit === true) {
          return warmCloudWorkspaceReplicas(me.user.id, parseCloudWorkspaceKey(key)!);
        }
      })
      .catch(() => {});
  };
  return (
    <Popover open={open && surfaceActive} onOpenChange={setOpen}>
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
      >
        {details.data ? (
          <CloudWorkspaceDetailsContent
            workspace={details.data}
            creator={
              me?.user.id === details.data.createdBy
                ? (me.user.displayName ?? "You")
                : "Workspace member"
            }
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
        {details.data && sharingActive && <CloudWorkspaceSharingControls workspace={details.data} active={open && surfaceActive} />}
        {details.data?.recovery?.checkpointId && details.data.recovery.state !== "restoring" &&
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
        {details.data && !details.data.recovery?.state &&
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
        {details.data && <CloudWorkspaceAccessControls workspace={details.data} active={open} />}
        {details.data && <CloudWorkspaceSyncControls key={`${me?.user.id}:${key}`} workspace={details.data} active={open && surfaceActive} />}
      </PopoverContent>
    </Popover>
  );
}

import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Ellipsis, Globe } from "lucide-react";

import {
  useLocalDevServers,
  type LocalDevServerFilter,
  type LocalDevServerRow,
} from "../../../features/browser/local-dev-servers";
import { workspacePreviewAvailable } from "../../../platform/cloud-workspace-access";
import {
  isCloudWorkspace,
  parseCloudWorkspaceKey,
} from "../../../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../../../platform/cloud-workspaces";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../../state/cloud-workspace-catalog";
import { useCloudWorkspaceDetectedPorts } from "../../../state/use-cloud-workspace-detected-ports";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tile,
} from "../../../shared/ui/primitives";
import { Inline } from "../../../shared/ui/layout/inline";
import { Stack } from "../../../shared/ui/layout/stack";

export interface BrowserStartPageProps {
  /** Workbench scope: a local folder path or a `cloud://` workspace key. */
  scope: string;
  active: boolean;
  onOpen: (url: string) => void;
}

/** Empty Browser tab: the Local workspace's loopback servers, or the VM's
 * detected ports for cloud placements. The two branches never share reads. */
export function BrowserStartPage({ scope, active, onOpen }: BrowserStartPageProps) {
  const cloud = isCloudWorkspace(scope);
  const previewAvailable = workspacePreviewAvailable(scope);
  return (
    <div className="bg-bg1 absolute inset-0 overflow-y-auto">
      <div className="flex min-h-full w-full items-center justify-center px-6 py-12">
        <Stack gap={6} className="w-full max-w-xl">
          <Stack gap={2} align="center" className="text-center">
            <Globe className="text-fg2 size-7" strokeWidth={1.5} aria-hidden />
            <p className="text-fg2 m-0 text-sm">
              {previewAvailable ? "Open a site or preview your app" : "Open a site"}
            </p>
          </Stack>
          {cloud ? (
            previewAvailable ? (
              <CloudPortsSection scope={scope} active={active} onOpen={onOpen} />
            ) : (
              <Stack as="section" gap={2} aria-label="Workspace ports">
                <SectionHeading label="Workspace" />
                <NeutralLine>Cloud preview URLs are not configured for this build.</NeutralLine>
              </Stack>
            )
          ) : (
            <LocalServersSection scope={scope} active={active} onOpen={onOpen} />
          )}
        </Stack>
      </div>
    </div>
  );
}

// ── Shared row ─────────────────────────────────────────────

type RowTone = "online" | "offline" | "unknown" | "warning";

const DOT_CLASSES: Record<RowTone, string> = {
  online: "bg-green-primary size-1.5 shrink-0 rounded-full",
  offline: "bg-red-primary size-1.5 shrink-0 rounded-full",
  warning: "bg-yellow-icon size-1.5 shrink-0 rounded-full",
  unknown: "bg-fg3 size-1.5 shrink-0 rounded-full",
};

function ServerRow({
  title,
  detail,
  detailTitle,
  tone,
  statusLabel,
  onOpen,
}: {
  title: string;
  detail: string;
  detailTitle?: string;
  tone: RowTone;
  statusLabel: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <Tile
        className="flex w-full items-center gap-3 p-2"
        onClick={onOpen}
        aria-label={`Open ${title}, ${statusLabel}`}
      >
        <span className="bg-bg1 border-border1 flex size-8 shrink-0 items-center justify-center rounded-md border">
          <Globe className="text-fg3 size-4" strokeWidth={1.5} aria-hidden />
        </span>
        <Stack gap={0.5} className="min-w-0 flex-1">
          <span className="text-fg1 truncate text-xs">{title}</span>
          <span className="text-fg3 truncate text-2xxs" title={detailTitle}>
            {detail}
          </span>
        </Stack>
        <Inline gap={1.5} align="center" className="shrink-0">
          <span className={DOT_CLASSES[tone]} aria-hidden />
          <span className="text-muted-fg text-2xxs">{statusLabel}</span>
        </Inline>
      </Tile>
    </li>
  );
}

function SectionHeading({ label, menu }: { label: string; menu?: ReactNode }) {
  return (
    <Inline align="center" justify="between" className="min-h-7">
      <h2 className="text-fg2 m-0 text-xs font-medium">{label}</h2>
      {menu}
    </Inline>
  );
}

function NeutralLine({ children }: { children: ReactNode }) {
  return <p className="text-fg3 m-0 text-xs">{children}</p>;
}

// ── Local placement ────────────────────────────────────────

const LOCAL_STATUS: Record<LocalDevServerRow["status"], { tone: RowTone; label: string }> = {
  online: { tone: "online", label: "Running" },
  offline: { tone: "offline", label: "Offline" },
  unknown: { tone: "unknown", label: "Checking" },
};

/** Every row belongs to the workspace, so the detail names the subfolder a
 * server runs in, or its process when it runs at the workspace root. */
export function localRowDetail(row: LocalDevServerRow, root: string | null): string {
  const host = `localhost:${row.port}`;
  const base = root && root.length > 1 ? root.replace(/\/+$/, "") : null;
  const subfolder =
    base && row.cwd?.startsWith(`${base}/`) ? row.cwd.slice(base.length + 1) : undefined;
  const owner = subfolder || row.processName;
  return owner ? `${host} · ${owner}` : host;
}

function LocalServersSection({ scope, active, onOpen }: BrowserStartPageProps) {
  const { available, state, filter, rows, hasOffline, clearHistory, setFilter } = useLocalDevServers({
    scope,
    active,
  });
  const onFilter = useCallback(
    (value: string) => setFilter(value === "online" ? "online" : "all"),
    [setFilter],
  );
  const root = state.probe?.root ?? (available ? scope : null);
  let emptyLine: string | null = null;
  if (!available) emptyLine = "Open a workspace to see its local servers.";
  else if (rows.length === 0) {
    if (state.probe) emptyLine = "No servers are running in this workspace.";
    else if (state.error) emptyLine = "Couldn't check for local servers.";
    else emptyLine = "Looking for servers in this workspace…";
  }
  return (
    <Stack as="section" gap={2} aria-label="Local servers">
      <SectionHeading
        label="Local"
        menu={
          available ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton size="standard" label="Local server options">
                  <Ellipsis strokeWidth={1.5} />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!hasOffline} onSelect={clearHistory}>
                  Clear history
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-muted-fg font-normal">Show</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={filter satisfies LocalDevServerFilter} onValueChange={onFilter}>
                  <DropdownMenuRadioItem value="all" indicator="check">All</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="online" indicator="check">Online</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      {emptyLine ? (
        <NeutralLine>{emptyLine}</NeutralLine>
      ) : (
        <Stack as="ul" gap={1.5} className="m-0 list-none p-0">
          {rows.map((row) => {
            const status = LOCAL_STATUS[row.status];
            return (
              <ServerRow
                key={row.url}
                title={row.title ?? `localhost:${row.port}`}
                detail={localRowDetail(row, root)}
                detailTitle={row.cwd}
                tone={status.tone}
                statusLabel={status.label}
                onOpen={() => onOpen(row.url)}
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

// ── Cloud placement ────────────────────────────────────────

/** Neutral copy for every VM state that has no live ports. Null = running. */
export function cloudPortsNotice(doc: CloudWorkspaceDocument | undefined): string | null {
  if (!doc) return "Ports appear when the workspace is ready.";
  if (doc.deletedAt !== null) return "This workspace is unavailable.";
  switch (doc.status) {
    case "ready":
    case "busy":
      return doc.capabilities.canEdit === true
        ? null
        : "Editing access is required to open workspace ports.";
    case "creating":
    case "provisioning":
    case "setting_up":
      return "Ports appear after the workspace finishes setting up.";
    case "starting":
    case "waking":
    case "restoring":
      return "Ports appear once the workspace has started.";
    case "sleeping":
    case "stopped":
      return "Start the workspace to see its ports.";
    case "stopping":
      return "The workspace is stopping.";
    case "archived":
      return "This workspace is archived.";
    case "failed":
    case "error":
      return "Ports are unavailable until the workspace recovers.";
    case "deleting":
    case "deleted":
      return "This workspace is unavailable.";
    default:
      return "Ports appear when the workspace is running.";
  }
}

function CloudPortsSection({ scope, active, onOpen }: BrowserStartPageProps) {
  const target = useMemo(() => parseCloudWorkspaceKey(scope), [scope]);
  const getDocument = useCallback(
    () => (target ? cloudWorkspaceDocument(target) : undefined),
    [target],
  );
  const doc = useSyncExternalStore(subscribeCloudWorkspaces, getDocument, getDocument);
  const notice = cloudPortsNotice(doc);
  // Passive heartbeat read: polls only ready/busy VMs and never wakes one.
  const detected = useCloudWorkspaceDetectedPorts(scope, {
    active,
    open: true,
    featureActive: notice === null,
  });
  const data =
    target &&
    detected.data?.organizationId === target.organizationId &&
    detected.data.workspaceId === target.workspaceId
      ? detected.data
      : undefined;
  const ports = useMemo(
    () =>
      (data?.ports ?? [])
        .filter((port) => port.health !== "closed")
        .sort((a, b) => a.port - b.port),
    [data],
  );
  let line: string | null = notice;
  if (!line && ports.length === 0) {
    if (data) line = "No ports are open in this workspace.";
    else if (detected.error) line = "Couldn't load workspace ports.";
    else line = "Checking workspace ports…";
  }
  return (
    <Stack as="section" gap={2} aria-label="Workspace ports">
      <SectionHeading label="Workspace" />
      {line ? (
        <NeutralLine>{line}</NeutralLine>
      ) : (
        <Stack as="ul" gap={1.5} className="m-0 list-none p-0">
          {ports.map((port) => {
            const host = `localhost:${port.port}`;
            const unhealthy = port.health === "unhealthy";
            return (
              <ServerRow
                key={port.port}
                title={`Port ${port.port}`}
                detail={port.processLabel ? `${host} · ${port.processLabel}` : host}
                tone={unhealthy ? "warning" : "online"}
                statusLabel={unhealthy ? "Not responding" : "Running"}
                onOpen={() => onOpen(`http://localhost:${port.port}`)}
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

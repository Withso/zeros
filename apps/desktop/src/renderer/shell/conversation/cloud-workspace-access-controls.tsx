import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { ArrowUpRight, ChevronDown, ChevronsLeftRight, Copy, Plug, Plus, Square, Terminal, X } from "lucide-react";
import { Button, Input, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Switch, Tooltip } from "../../shared/ui/primitives";
import { toast } from "../../shared/ui/primitives/elements";
import { copyToClipboardWithFallback } from "../../shared/lib/clipboard";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { workspacePreviewAvailable } from "../../platform/cloud-workspace-access";
import { workbenchScopeForFolder, useWorkspaceStore } from "../../state/workspace-store";
import { planBrowserOpen } from "../workbench/use-open-browser";
import { defaultScopeFor } from "../workbench/tab-model";
import { useNativeRuntime } from "../../platform/runtime";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceExecutionRefusal } from "../../platform/cloud-workspace-execution";
import {
  cloudServiceAccessKey,
  cloudServiceContextKey,
  copyCloudWorkspaceSshCommand,
  invalidateCloudServiceAccess,
  openCloudWorkspaceTerminal,
  readCloudServiceAccess,
  readCloudServiceContext,
  readCloudWorkspacePortForwarding,
  setCloudWorkspacePortForwarding,
  revokeCloudWorkspaceAccess,
  startCloudWorkspaceTunnel,
  type CloudServiceAccessRow,
  type CloudServiceContext,
} from "../../platform/cloud-workspace-access";
import {
  cloudServiceAccessCache,
  cloudServiceContextCache,
} from "../../state/read-caches";
import { useCachedRead } from "../../state/use-cached-read";
import { useCloudWorkspaceDetectedPorts } from "../../state/use-cloud-workspace-detected-ports";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { CloudWorkspaceForwardingCache, cloudWorkspaceForwardingKey } from "./cloud-workspace-forwarding-cache";

const forwardingPreferences = new CloudWorkspaceForwardingCache({
  isCurrent: owner => {
    const context = cloudServiceContextCache.peekSnapshot(owner.account).data;
    const workspace = cloudWorkspaceDocument(owner);
    return cloudServiceContextKey() === owner.account && cloudCatalogGeneration() === owner.catalog &&
      context?.authorityId === owner.authorityId && context.deviceId === owner.deviceId && context.keyVersion === owner.keyVersion &&
      canReadCloudWorkspace(workspace) && workspace?.generation.number === owner.generation;
  },
  read: ({ organizationId, workspaceId, authorityId, deviceId, keyVersion }) =>
    readCloudWorkspacePortForwarding({ organizationId, workspaceId, authorityId, deviceId, keyVersion }),
  write: ({ organizationId, workspaceId, authorityId, deviceId, keyVersion }, patch) =>
    setCloudWorkspacePortForwarding({ organizationId, workspaceId, authorityId, deviceId, keyVersion, ...patch }),
});
subscribeCloudWorkspaces(() => forwardingPreferences.prune());

const subscribeVisibility = (listener: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

type AccessMode = "ssh" | "ports";
export type CloudWorkspaceForwardingState = { forwardingEnabled: boolean; autoForwardEnabled: boolean };
export type CloudWorkspaceDetectedPort = { port: number; processLabel?: string | null };

export function CloudWorkspaceAccessControls({
  workspace,
  active,
  mode = "ssh",
  onOpenBrowser,
}: {
  workspace: CloudWorkspaceDocument;
  active: boolean;
  mode?: AccessMode;
  onOpenBrowser?: () => void;
}) {
  const internal = useCloudWorkspaceAccountAccess(workspace.organizationId);
  const { ready: native } = useNativeRuntime();
  const shown = useSyncExternalStore(subscribeVisibility, visible, () => true);
  if (!internal || !active || !shown || workspace.placement !== "cloud") return null;
  return (
    <ActiveAccess
      key={`${cloudServiceContextKey()}:${workspace.organizationId}:${workspace.id}:${workspace.generation.number}`}
      workspace={workspace}
      native={native}
      mode={mode}
      onOpenBrowser={onOpenBrowser}
    />
  );
}

function ActiveAccess({
  workspace,
  native,
  mode,
  onOpenBrowser,
}: {
  workspace: CloudWorkspaceDocument;
  native: boolean;
  mode: AccessMode;
  onOpenBrowser?: () => void;
}) {
  const contextKey = cloudServiceContextKey();
  const context = useCachedRead(
    cloudServiceContextCache,
    contextKey,
    readCloudServiceContext,
    { enabled: native, maxAgeMs: 5_000 },
  );
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
  };
  const key = context.data ? cloudServiceAccessKey(target, context.data) : null;
  const access = useCachedRead(
    cloudServiceAccessCache,
    key,
    readCloudServiceAccess,
    { enabled: native, maxAgeMs: 5_000 },
  );
  const detected = useCloudWorkspaceDetectedPorts(cloudWorkspaceKey(target), {
    active: true, open: true, featureActive: mode === "ports",
  });
  const preferenceKey = mode === "ports" && context.data ? cloudWorkspaceForwardingKey({ ...target, ...context.data,
    account: contextKey, catalog: cloudCatalogGeneration(), generation: workspace.generation.number }) : null;
  const preferences = useCachedRead(forwardingPreferences.snapshots, preferenceKey,
    value => forwardingPreferences.fetch(value), { enabled: native, maxAgeMs: 5_000 });
  const refreshContext = context.refresh,
    refreshAccess = access.refresh, refreshPreferences = preferences.refresh;
  useEffect(() => {
    if (!native) return;
    const timer = setInterval(() => {
      if (visible()) {
        refreshContext();
        refreshAccess();
        refreshPreferences();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [native, refreshContext, refreshAccess, refreshPreferences]);
  return (
    <CloudWorkspaceAccessContent
      key={key ?? contextKey}
      workspace={workspace}
      native={native}
      mode={mode}
      onOpenBrowser={onOpenBrowser}
      context={context.data}
      rows={access.data}
      readError={!!context.error || !!access.error || !!preferences.error}
      forwarding={preferences.data}
      onForwardingChange={preferenceKey ? patch => forwardingPreferences.write(preferenceKey, patch) : undefined}
      detectedPorts={detected.error ? null : detected.data?.ports}
    />
  );
}

export function CloudWorkspaceAccessContent({
  workspace,
  native,
  context,
  rows,
  readError,
  mode,
  forwarding,
  onForwardingChange,
  detectedPorts,
  onOpenBrowser,
}: {
  workspace: CloudWorkspaceDocument;
  native: boolean;
  context?: CloudServiceContext;
  rows?: CloudServiceAccessRow[];
  readError: boolean;
  mode: AccessMode;
  forwarding?: CloudWorkspaceForwardingState;
  onForwardingChange?: (patch: Partial<CloudWorkspaceForwardingState>) => Promise<unknown>;
  detectedPorts?: CloudWorkspaceDetectedPort[] | null;
  onOpenBrowser?: () => void;
}) {
  const inputId = useId();
  const [remotePort, setRemotePort] = useState("4173"),
    [localPort, setLocalPort] = useState("4173");
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const working = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const target = {
    organizationId: workspace.organizationId,
    workspaceId: workspace.id,
  };
  const refusal = cloudWorkspaceExecutionRefusal(workspace);
  const ready =
    ["ready", "busy"].includes(workspace.status) && !workspace.recovery?.state && !refusal;
  const allowed =
    native && !!context && workspace.capabilities.canEdit === true && ready && !readError;
  const act = (task: () => Promise<unknown>, success: string) => {
    if (working.current || !context) return;
    working.current = true;
    setPending(true);
    const epoch = cloudServiceContextKey();
    void task()
      .then(
        () => {
          if (mounted.current && epoch === cloudServiceContextKey())
            toast.success(success);
        },
        (error) => {
          if (mounted.current && epoch === cloudServiceContextKey())
            toast.error("Couldn't update cloud access", { description: error instanceof Error ? error.message : "Try again." });
        },
      )
      .finally(() => {
        if (epoch === cloudServiceContextKey())
          invalidateCloudServiceAccess(target);
        working.current = false;
        if (mounted.current) setPending(false);
      });
  };
  const note = refusal?.message ?? (!native
    ? "Use the Mac app to open SSH or forward a port."
    : workspace.capabilities.canEdit !== true
      ? "Editing access is required for SSH and port forwarding."
      : !ready
        ? "Start the workspace before opening access."
        : null);
  const connections = rows?.filter(row => row.generation === workspace.generation.number && row.kind === (mode === "ssh" ? "ssh" : "tunnel")) ?? [];
  const detected = detectedPorts?.filter(port => !connections.some(row => row.remotePort === port.port)) ?? [];
  const openPreview = (port: number) => {
    if (!allowed || !workspacePreviewAvailable(cloudWorkspaceKey(target))) return;
    const scope = workbenchScopeForFolder(cloudWorkspaceKey(target));
    const state = useWorkspaceStore.getState();
    const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
    const action = planBrowserOpen(current.tabs, current.activeId, { url: `http://localhost:${port}`, title: `Port ${port}` });
    if (action) { state.dispatch({ ...action, scope }); onOpenBrowser?.(); }
  };
  const previewButton = (port: number) => <Tooltip label="Open in Zeros Browser">
    <Button variant="ghost" size="icon-compact" aria-label={`Open port ${port} in Browser`} disabled={!allowed || !workspacePreviewAvailable(cloudWorkspaceKey(target))}
      onClick={() => openPreview(port)}><ArrowUpRight /></Button>
  </Tooltip>;
  return (
    <section
      className={mode === "ssh" ? "mt-3 space-y-2" : "space-y-3"}
      aria-label={mode === "ssh" ? "Open via SSH" : "Workspace ports"}
    >
      {mode === "ssh" ? <div className="flex min-w-0 items-center">
        <Button variant="secondary" className="rounded-r-none"
          aria-label="Open via SSH in Terminal"
          disabled={!allowed || pending}
          onClick={() =>
            act(
              () => openCloudWorkspaceTerminal({ ...target, ...context }),
              "Opened in Terminal.",
            )
          }
        >
          <Terminal />Open in Terminal
        </Button>
        <DropdownMenu><DropdownMenuTrigger asChild>
          <Button variant="secondary" size="icon-sm" className="-ml-px rounded-l-none" aria-label="SSH options" disabled={!native || !context || pending}><ChevronDown /></Button>
        </DropdownMenuTrigger><DropdownMenuContent align="start">
          <DropdownMenuItem disabled={!allowed} onSelect={() => act(() => openCloudWorkspaceTerminal({ ...target, ...context }), "Opened in Terminal.")}><Terminal />Terminal</DropdownMenuItem>
          <DropdownMenuItem disabled={!allowed} onSelect={() => act(() => copyCloudWorkspaceSshCommand({ ...target, ...context }), "SSH command copied")}><Copy />Copy SSH command</DropdownMenuItem>
          {connections.map(row => <DropdownMenuItem key={row.accessId} onSelect={() => act(() => revokeCloudWorkspaceAccess(row.accessId), "SSH connection closed")}>
            <X />{row.closing ? "Retry close SSH connection" : "Close SSH connection"}
          </DropdownMenuItem>)}
        </DropdownMenuContent></DropdownMenu>
      </div> : <>
        <div className="flex items-center gap-2 text-xs">
          <Plug className="text-fg3 size-4 shrink-0" />
          <span className="text-fg2 flex-1">Forward to localhost</span>
          <Switch aria-label="Forward to localhost" checked={forwarding?.forwardingEnabled ?? false} disabled={!allowed || pending || !forwarding || !onForwardingChange}
            onCheckedChange={forwardingEnabled => act(() => onForwardingChange!({ forwardingEnabled }), "Port forwarding updated")} />
        </div>
        <div className="flex items-center gap-2 text-xs">
          <ChevronsLeftRight className="text-fg3 size-4 shrink-0" />
          <span className="text-fg2 flex-1">Auto-forwarding</span>
          <Switch aria-label="Auto-forwarding" checked={forwarding?.autoForwardEnabled ?? true} disabled={!allowed || pending || !forwarding?.forwardingEnabled || !onForwardingChange}
            onCheckedChange={autoForwardEnabled => act(() => onForwardingChange!({ autoForwardEnabled }), "Auto-forwarding updated")} />
        </div>
        <div className="border-border1 flex items-center gap-2 border-t pt-2">
          <h2 className="text-fg1 flex-1 text-xs font-medium">Ports</h2>
          <Tooltip label={adding ? "Cancel adding a port" : "Add port"}>
            <Button variant="ghost" size="icon-compact" aria-label={adding ? "Cancel adding a port" : "Add port"} disabled={!allowed || pending}
              onClick={() => setAdding(value => !value)}>{adding ? <X /> : <Plus />}</Button>
          </Tooltip>
        </div>
        {adding && <div className="flex items-end gap-2">
        <label
          className="text-fg2 min-w-0 flex-1 space-y-1 text-xs"
          htmlFor={`${inputId}-remote`}
        >
          Workspace port
          <Input
            id={`${inputId}-remote`}
            type="text"
            inputMode="numeric"
            maxLength={5}
            value={remotePort}
            onChange={(event) => setRemotePort(event.target.value)}
            disabled={!allowed || pending}
          />
        </label>
        <label
          className="text-fg2 min-w-0 flex-1 space-y-1 text-xs"
          htmlFor={`${inputId}-local`}
        >
          Mac port
          <Input
            id={`${inputId}-local`}
            type="text"
            inputMode="numeric"
            maxLength={5}
            value={localPort}
            onChange={(event) => setLocalPort(event.target.value)}
            disabled={!allowed || pending}
          />
        </label>
        <Button
          size="sm"
          disabled={
            !allowed ||
            pending ||
            !validCloudWorkspacePort(remotePort) ||
            !validCloudWorkspacePort(localPort)
          }
          onClick={() =>
            act(
              () =>
                startCloudWorkspaceTunnel({
                  ...target,
                  ...context,
                  remotePort: Number(remotePort),
                  localPort: Number(localPort),
                }),
              "Port forwarded on this Mac.",
            )
          }
        >
          Forward port
        </Button>
      </div>}
      {connections.map((row) => (
        <div key={row.accessId} className="flex items-center gap-2 text-xs">
          <span className="text-fg2 min-w-0 flex-1 truncate">
            {row.remotePort}<span className="text-muted-fg"> · localhost:{row.localPort}</span>
          </span>
          {row.remotePort !== null && previewButton(row.remotePort)}
          <Tooltip label="Copy localhost address"><Button variant="ghost" size="icon-compact" aria-label={`Copy localhost:${row.localPort}`} disabled={pending}
            onClick={() => act(() => copyToClipboardWithFallback(`http://localhost:${row.localPort}`), "Localhost address copied")}><Copy /></Button></Tooltip>
          <Button
            size="icon-compact"
            variant="ghost"
            disabled={!native || pending}
            aria-label={row.closing ? `Retry stopping port ${row.remotePort}` : `Stop forwarding port ${row.remotePort}`}
            onClick={() =>
              act(
                () => revokeCloudWorkspaceAccess(row.accessId),
                "Access closed.",
              )
            }
          >
            <Square />
          </Button>
        </div>
      ))}
      {detected.map(port => <div key={port.port} className="flex items-center gap-2 text-xs">
        <span className="text-fg2 min-w-0 flex-1 truncate">{port.port}{port.processLabel && <span className="text-muted-fg"> · {port.processLabel}</span>}</span>
        {previewButton(port.port)}
        <Button variant="ghost" size="compact" disabled={!allowed || pending} aria-label={`Forward port ${port.port}`}
          onClick={() => act(() => startCloudWorkspaceTunnel({ ...target, ...context, remotePort: port.port, localPort: port.port }), "Port forwarded on this Mac.")}>Forward</Button>
      </div>)}
      {connections.length === 0 && detected.length === 0 && <p className="text-fg3 text-xs" role="status">{detectedPorts === undefined || detectedPorts === null ? "Detected ports unavailable" : "No ports detected"}</p>}
      </>}
      {note && <p className="text-fg3 text-xs">{note}</p>}
      {readError && (
        <p className="text-fg3 text-xs" role="status">
          Couldn’t refresh access. Showing the last confirmed connections.
        </p>
      )}
    </section>
  );
}

export function validCloudWorkspacePort(value: string): boolean {
  return /^\d{4,5}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
}

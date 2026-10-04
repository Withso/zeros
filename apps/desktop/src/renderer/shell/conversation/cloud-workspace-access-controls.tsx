import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useInternalFeatureActive } from "../../features/settings/internal-features";
import { Button, Input } from "../../shared/ui";
import { useNativeRuntime } from "../../platform/runtime";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import {
  cloudServiceAccessKey,
  cloudServiceContextKey,
  copyCloudWorkspaceSshCommand,
  invalidateCloudServiceAccess,
  openCloudWorkspaceTerminal,
  readCloudServiceAccess,
  readCloudServiceContext,
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

const subscribeVisibility = (listener: () => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const visible = () =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

export function CloudWorkspaceAccessControls({
  workspace,
  active,
}: {
  workspace: CloudWorkspaceDocument;
  active: boolean;
}) {
  const internal = useInternalFeatureActive("cloudComputerV2");
  const { ready: native } = useNativeRuntime();
  const shown = useSyncExternalStore(subscribeVisibility, visible, () => true);
  if (!internal || !active || !shown) return null;
  return (
    <ActiveAccess
      key={`${cloudServiceContextKey()}:${workspace.organizationId}:${workspace.id}:${workspace.generation.number}`}
      workspace={workspace}
      native={native}
    />
  );
}

function ActiveAccess({
  workspace,
  native,
}: {
  workspace: CloudWorkspaceDocument;
  native: boolean;
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
  const refreshContext = context.refresh,
    refreshAccess = access.refresh;
  useEffect(() => {
    if (!native) return;
    const timer = setInterval(() => {
      if (visible()) {
        refreshContext();
        refreshAccess();
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [native, refreshContext, refreshAccess]);
  return (
    <AccessActions
      key={key ?? contextKey}
      workspace={workspace}
      native={native}
      context={context.data}
      rows={access.data}
      readError={!!context.error || !!access.error}
    />
  );
}

function AccessActions({
  workspace,
  native,
  context,
  rows,
  readError,
}: {
  workspace: CloudWorkspaceDocument;
  native: boolean;
  context?: CloudServiceContext;
  rows?: CloudServiceAccessRow[];
  readError: boolean;
}) {
  const inputId = useId();
  const [remotePort, setRemotePort] = useState("4173"),
    [localPort, setLocalPort] = useState("4173");
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState<string | null>(null);
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
  const ready =
    ["ready", "busy"].includes(workspace.status) && !workspace.recovery?.state;
  const allowed =
    native && !!context && workspace.capabilities.canEdit === true && ready;
  const validPort = (value: string) =>
    /^\d{4,5}$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
  const act = (task: () => Promise<unknown>, success: string) => {
    if (working.current || !context) return;
    working.current = true;
    setPending(true);
    setMessage(null);
    const epoch = cloudServiceContextKey();
    void task()
      .then(
        () => {
          if (mounted.current && epoch === cloudServiceContextKey())
            setMessage(success);
        },
        (error) => {
          if (mounted.current && epoch === cloudServiceContextKey())
            setMessage(
              error instanceof Error
                ? error.message
                : "Cloud access could not be opened.",
            );
        },
      )
      .finally(() => {
        if (epoch === cloudServiceContextKey())
          invalidateCloudServiceAccess(target);
        working.current = false;
        if (mounted.current) setPending(false);
      });
  };
  const note = !native
    ? "Use the Mac app to open SSH or forward a port."
    : workspace.capabilities.canEdit !== true
      ? "Editing access is required for SSH and port forwarding."
      : !ready
        ? "Start the workspace before opening access."
        : "SSH commands are single-use. Request a new command to reconnect.";
  return (
    <section
      className="border-border1 mt-3 space-y-3 border-t pt-3"
      aria-label="SSH and port forwarding"
    >
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!allowed || pending}
          onClick={() =>
            act(
              () => openCloudWorkspaceTerminal({ ...target, ...context }),
              "Opened in Terminal.",
            )
          }
        >
          Open Terminal
        </Button>
        <Button
          size="sm"
          disabled={!allowed || pending}
          onClick={() =>
            act(
              () => copyCloudWorkspaceSshCommand({ ...target, ...context }),
              "Copied. Paste the command into Terminal.",
            )
          }
        >
          Copy SSH command
        </Button>
      </div>
      <p className="text-fg3 text-xs">{note}</p>
      <div className="flex items-end gap-2">
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
            !validPort(remotePort) ||
            !validPort(localPort)
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
      </div>
      <p className="text-fg3 text-xs">
        Forwarded ports listen on 127.0.0.1 on this Mac.
      </p>
      {rows?.map((row) => (
        <div key={row.accessId} className="flex items-center gap-2 text-xs">
          <span className="text-fg2 min-w-0 flex-1 truncate">
            {row.kind === "ssh"
              ? "SSH connection"
              : `127.0.0.1:${row.localPort} → ${row.remotePort}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!native || pending}
            onClick={() =>
              act(
                () => revokeCloudWorkspaceAccess(row.accessId),
                "Access closed.",
              )
            }
          >
            {row.closing ? "Retry close" : "Close"}
          </Button>
        </div>
      ))}
      {readError && (
        <p className="text-fg3 text-xs" role="status">
          Couldn’t refresh access. Showing the last confirmed connections.
        </p>
      )}
      {message && (
        <p className="text-fg2 text-xs" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────
// Customize → MCP — the scope-aware server list
// ──────────────────────────────────────────────────────────
//
// One list component for both scopes:
//   • USER — the machine-wide `~/.zeros/settings.toml` `[[mcp.servers]]`
//     (what every repo inherits). Carries the gateway integration (OAuth
//     sign-in, status chips, per-tool allowlist), the import-from-other-tools
//     wizard, and the read-only "Inherited" rows (every non-user layer —
//     team, managed, repo — each tagged with its own source badge).
//   • REPO — that repo's personal `.zeros/settings.local.toml`. Shows ONLY
//     the repo's own servers; user-level servers inherit implicitly and are
//     deliberately NOT repeated here (a one-line footnote says so). Gateway
//     auth is user-level only, so a hand-written oauth/header entry gets a
//     "User-only auth" chip (the engine skips it with a warning).
//
// We read the RAW servers array and write it back whole (manipulated by
// index), so a hand-written entry this UI can't fully render is preserved,
// never silently dropped, across an add/edit/remove/toggle — the same
// round-trip contract the old Settings → MCP panel had.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  LogIn,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

import { Button, Input } from "../../shared/ui";
import { Switch } from "../../shared/ui/primitives/switch";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { cn } from "@/renderer/shared/ui/cn";
import { toast } from "../../shared/ui/primitives/elements";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { useBridge } from "../../platform/bridge/use-bridge";
import { runtimeExecutionKey } from "../../platform/bridge/ws-client";
import { shellOpenUrl } from "../../platform/app";
import {
  workspaceOp,
  type SettingsReadWire,
  bridgeMcpGatewayAuthorize,
  bridgeMcpGatewayCancelAuth,
  bridgeMcpGatewayReconnect,
  bridgeMcpGatewayBeginAuth,
  bridgeMcpGatewayCompleteAuth,
  bridgeMcpGatewayStatus,
  bridgeMcpResolveComposed,
  type ComposedMcpServerWire,
  type GatewayBackendStatusWire,
} from "../../platform/bridge/workspace-bridge";
import { primeSettingsLayer, useSettingsLayer } from "../settings/use-settings";
import { SettingsSection, SETTINGS_CARD_LIST_CLS, SETTINGS_GROUP_RADIUS } from "../settings/settings-ui";
import {
  asString,
  disabledToolsOf,
  endpointSummary,
  isEnabled,
  readRawServers,
  transportOf,
  withToggled,
  withToolDisabled,
  type RawServer,
} from "./mcp-server-model";
import { mcpConnectionCache, mcpConnectionKey, rememberMcpConnection } from "./mcp-connection-status";
import { McpImportDialog } from "./mcp-import-dialog";
import type { ResolvedCustomizeScope } from "./customize-page";
import { useCachedRead } from "../../state/use-cached-read";
import { mcpGatewayStatusCache, mcpGatewayStatusKey } from "../../state/read-caches";
import { shouldUseHeadlessMcpAuth } from "./mcp-auth-flow";
import { mcpConnectionView } from "./mcp-connection-view";

// The filled-card recipe the Models settings page uses — rows separated by
// hairline dividers inside one rounded `--bg1-highlight` surface.
export const MCP_CARD_CLS =
  `${SETTINGS_CARD_LIST_CLS} ${SETTINGS_GROUP_RADIUS} flex flex-col divide-y`;

/** Friendly label for a settings layer (the source badge). */
const LAYER_LABEL: Record<string, string> = {
  user: "User",
  team: "Team",
  managed: "Managed",
  repo: "Shared",
  "repo-local": "Repo",
  "workspace-local": "This Workspace",
};
function layerLabel(s: string): string {
  return LAYER_LABEL[s] ?? s;
}

/** Build a raw server entry from a composed (resolved) one, for "Override
 *  here" (copy an inherited managed server into the user layer to edit). */
function rawFromComposed(c: ComposedMcpServerWire): RawServer {
  if (c.transport !== "stdio") {
    return {
      name: c.name,
      transport: c.transport,
      url: c.url ?? "",
      ...(c.auth ? { auth: c.auth } : {}),
      ...(c.oauth_client_id ? { oauth_client_id: c.oauth_client_id } : {}),
      ...(c.oauth_scopes ? { oauth_scopes: c.oauth_scopes } : {}),
    };
  }
  return {
    name: c.name,
    transport: "stdio",
    command: c.command ?? "",
    ...(c.args && c.args.length ? { args: c.args } : {}),
    ...(c.cwd ? { cwd: c.cwd } : {}),
  };
}

/** The no-browser paste-code sign-in: show the authorization URL to open
 *  elsewhere, then take the pasted code (or full redirect URL) to finish. */
export function HeadlessAuthModal({
  state,
  busy,
  onCancel,
  onComplete,
}: {
  state: { server: string; url: string } | null;
  busy: boolean;
  onCancel: () => void;
  onComplete: (code: string) => void;
}) {
  const id = React.useId();
  const [code, setCode] = useState("");
  useEffect(() => {
    if (state) setCode("");
  }, [state]);
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to {state?.server}</DialogTitle>
          <DialogDescription>
            Open the sign-in URL in a browser, authorize access, then paste
            the code or redirect URL below.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-fg1 text-xs font-medium">
                Authorization URL
              </label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-url`}
                  readOnly
                  value={state?.url ?? ""}
                  className="font-sans text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="secondary"
                  className="shrink-0"
                  onClick={async () => {
                    if (!state?.url) return;
                    try {
                      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                      await navigator.clipboard.writeText(state.url);
                      toast.success("URL copied");
                    } catch { toast.error("Could not copy the URL. Select it and copy it manually."); }
                  }}
                >
                  Copy
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-code`} className="text-fg1 text-xs font-medium">
                Code or redirect URL
              </label>
              <Input
                id={`${id}-code`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={busy}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing && !busy && code.trim()) {
                    event.preventDefault(); onComplete(code.trim());
                  }
                }}
                placeholder="code=… or the full …/callback?code=… URL"
                className="font-sans text-xs"
                autoFocus
              />
              <p className="text-fg2 text-xs">
                Paste what the browser shows after you authorize.
              </p>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!code.trim() || busy}
            onClick={() => onComplete(code.trim())}
          >
            {busy && <ZerosSpinner size={16} tone="inverted" />}
            Finish sign-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── List row ─────────────────────────────────────────────

function ServerRow({
  verificationOwner,
  server,
  busy,
  gateway,
  onToggle,
  onEdit,
  onConnect,
  onRemove,
}: {
  server: RawServer;
  verificationOwner: string;
  busy: boolean;
  /** Gateway controls for this exact user or repository configuration. */
  gateway?: {
    status?: GatewayBackendStatusWire;
    observedAt: number;
    error?: string | null;
    signingIn: boolean;
    signInBlocked: boolean;
    onSignIn: () => void;
    onCancel: () => void;
    onReconnect: () => void;
    onToolToggle?: (tool: string, disabled: boolean) => void;
    onBeginHeadless?: () => void;
  };
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onConnect: () => void;
  onRemove: () => void;
}) {
  const name = asString(server.name) || "(unnamed)";
  const description = asString(server.description);
  const enabled = isEnabled(server);
  const isOauth = server.auth === "oauth";
  const gatewayManaged = isOauth || server.auth === "header";
  const verificationKey = mcpConnectionKey(verificationOwner, server);
  const verification = useSyncExternalStore(useCallback(listener => mcpConnectionCache.subscribe(verificationKey, listener), [verificationKey]), useCallback(() => mcpConnectionCache.getSnapshot(verificationKey), [verificationKey]));
  const st = gateway?.status?.state ?? (verification.data?.status === "connected" ? "connected" : undefined);
  const gwDown = gatewayManaged && !!gateway?.error;
  const checked = !gwDown && (!gateway?.status || verification.updatedAt >= gateway.observedAt) ? verification.data : undefined;
  const view = mcpConnectionView(server, checked, gwDown ? "error" : gateway?.status?.state);
  const allTools = gateway?.status?.tools ?? [];
  const disabledSet = new Set(disabledToolsOf(server));
  const canExpand =
    st === "connected" && allTools.length > 0 && !!gateway?.onToolToggle;
  const [showTools, setShowTools] = useState(false);
  const chipCls = cn(
    "inline-flex select-none items-center gap-1 text-xs",
    view.tone === "error" ? "text-red-primary" : view.tone === "success" ? "text-green-primary" : "text-fg2",
  );
  const chipText = view.label;
  return (
    <div className="flex flex-col gap-2 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="ghost"
          onClick={onEdit}
          disabled={busy}
          className="h-auto min-w-0 flex-1 justify-start gap-2.5 px-0 py-1 text-left"
          aria-label={`Edit ${name}`}
        >
          <span className="border-border1 text-fg2 shrink-0 rounded-sm border px-1.5 py-px text-xs font-medium select-none">
            {transportOf(server)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-fg1 truncate text-xs font-medium">
                {name}
              </span>

            </span>
            <span className="text-fg2 block truncate text-xs">
              {description || (
                <span className="font-mono">{endpointSummary(server)}</span>
              )}
            </span>
          </span>
        </Button>
        <div className="flex shrink-0 items-center gap-1.5">
          {
            (canExpand ? (
              <Tooltip label="Show tools">
                <Button
                  variant="ghost"
                  onClick={() => setShowTools((v) => !v)}
                  className={cn(chipCls, "hover:text-fg1")}
                  aria-expanded={showTools}
                >
                  {chipText}
                  <ChevronDown
                    className={cn(
                      "size-3 transition-transform",
                      showTools && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </Button>
              </Tooltip>
            ) : (
              <Tooltip
                label={
                  gwDown
                    ? (gateway?.error ?? undefined)
                    : gateway?.status?.detail
                }
              >
                <span className={chipCls}>{chipText}</span>
              </Tooltip>
            ))}
          {isOauth && gateway && view.action === "connect" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={gateway.onSignIn}
              disabled={gateway.signInBlocked || busy}
            >
              {gateway.signingIn ? (
                <ZerosSpinner size={16} />
              ) : (
                <LogIn className="size-3.5" aria-hidden="true" />
              )}
              Connect
            </Button>
          )}
          {
            isOauth &&
            enabled &&
            gateway?.onBeginHeadless &&
            !gwDown &&
            st === "needs-auth" && (
              <Tooltip label="Device login">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-fg2 hover:text-fg1 px-1.5 text-xs"
                  onClick={gateway.onBeginHeadless}
                  disabled={gateway.signInBlocked || busy}
                >
                  No browser?
                </Button>
              </Tooltip>
            )}
          { gateway?.signingIn && <Button variant="ghost" size="sm" onClick={gateway.onCancel}>Cancel</Button>}
          {view.action && view.label !== "Connected" && !(isOauth && gateway && view.action === "connect") && (
            <Button variant="secondary" disabled={busy || gateway?.signInBlocked} onClick={gateway && view.tone === "error" ? gateway.onReconnect : onConnect}>
              {view.tone === "error" ? "Retry" : "Connect"}
            </Button>
          )}
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={busy || gateway?.signInBlocked}
            aria-label={enabled ? "Disable server" : "Enable server"}
            className="mr-1"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onEdit}
            disabled={busy || gateway?.signInBlocked}
            aria-label="Edit server"
          >
            <Pencil className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRemove}
            disabled={busy || gateway?.signInBlocked}
            className="text-fg2 hover:bg-red-primary/10 hover:text-red-primary"
            aria-label="Remove server"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {showTools && canExpand && (
        <div className="border-border1 ml-9 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border p-2">
          {allTools.map((t) => (
            <label
              key={t}
              className="flex items-center justify-between gap-3 py-0.5"
            >
              <span className="text-fg1 truncate font-mono text-xs">{t}</span>
              <Switch
                checked={!disabledSet.has(t)}
                onCheckedChange={(on) => gateway?.onToolToggle?.(t, !on)}
                disabled={busy}
                aria-label={
                  disabledSet.has(t) ? `Enable tool ${t}` : `Disable tool ${t}`
                }
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** A read-only row for a server inherited from any non-user layer (team,
 *  managed, repo), with an "Override here" affordance copying it into the
 *  user layer to edit. The source badge names which layer it came from. */
function InheritedServerRow({
  composed,
  busy,
  onOverride,
}: {
  composed: ComposedMcpServerWire;
  busy: boolean;
  onOverride: () => void;
}) {
  const endpoint =
    composed.transport !== "stdio"
      ? composed.url || "(no url)"
      : `${composed.command ?? ""} ${(composed.args ?? []).join(" ")}`.trim() ||
        "(no command)";
  return (
    <div className="flex items-center justify-between gap-4 py-3 opacity-80">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="border-border1 text-fg2 rounded-sm border px-1.5 py-px text-xs font-medium select-none">
          {composed.transport}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-fg1 truncate text-sm">{composed.name}</span>
            <span className="border-border1 text-xxs text-fg2 shrink-0 rounded-sm border px-1 py-px font-medium select-none">
              {layerLabel(composed.source)}
            </span>
          </div>
          <div className="text-fg2 truncate font-mono text-xs">{endpoint}</div>
        </div>
      </div>
      <Tooltip label="Copy server">
        <Button
          variant="secondary"
          size="sm"
          onClick={onOverride}
          disabled={busy}
        >
          Override here
        </Button>
      </Tooltip>
    </div>
  );
}

/** The always-present creation affordance — doubles as the empty state. */
function NewServerCard({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="bg-bg1-highlight hover:bg-bg2 flex w-full items-center gap-3 rounded-lg px-4 py-3.5 text-left transition-colors disabled:pointer-events-none disabled:opacity-50"
    >
      <span
        className="bg-bg2-hover text-fg2 flex size-8 shrink-0 items-center justify-center rounded-md"
        aria-hidden="true"
      >
        <Plus className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-fg1 text-sm font-medium">New MCP server</span>
        <span className="text-fg2 text-xs">Add a custom MCP server</span>
      </span>
    </button>
  );
}

// ── Section ──────────────────────────────────────────────

export function CustomizeMcpSection({
  scope,
  surfaceActive = true,
  onNew,
  onEdit,
  onSwitchToUser,
}: {
  scope: ResolvedCustomizeScope;
  /** False while the Home deck keeps the page mounted but hidden — gates the
   *  gateway status polling (active-only effects stay off hidden surfaces). */
  surfaceActive?: boolean;
  onNew: () => void;
  onEdit: (server: RawServer, connect?: boolean) => void;
  /** Repo scope's footnote link — jump to the User scope's list. */
  onSwitchToUser: () => void;
}) {
  const isUser = scope.kind === "user";
  const repoRoot = scope.kind === "repo" ? scope.project.repoRoot : undefined;
  const { layer, loading, error } = useSettingsLayer(
    isUser ? "user" : "repo-local",
    repoRoot,
  );
  const servers = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);

  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  // Guard against a stale write resolving after the component changed servers.
  const writeSeq = useRef(0);
  const mutating = useRef(false);
  useEffect(() => () => { writeSeq.current++; }, []);

  // ── Gateway controls (user scope only) — the one user-global gateway
  // fronts every auth:"oauth"/"header" backend. Local engines open the
  // browser directly; cloud engines return a URL that this trusted renderer
  // opens on the user's device.
  const bridge = useBridge();
  const execution = useSyncExternalStore(
    useCallback((changed) => bridge?.onExecutionIdentityChange(changed) ?? (() => {}), [bridge]),
    useCallback(() => bridge ? runtimeExecutionKey(bridge.executionIdentity) : "", [bridge]),
  );
  const statusKey = bridge ? mcpGatewayStatusKey(bridge, execution, repoRoot) : null;
  const gatewayRead = useCachedRead(mcpGatewayStatusCache, statusKey, async (key) => {
    const matches = () => bridge && key === mcpGatewayStatusKey(bridge, runtimeExecutionKey(bridge.executionIdentity), repoRoot);
    if (!bridge || !matches()) throw new Error("MCP connection changed.");
    const snapshot = await bridgeMcpGatewayStatus(bridge, repoRoot);
    if (!matches()) throw new Error("MCP connection changed.");
    return snapshot;
  }, { enabled: surfaceActive, maxAgeMs: 30_000 });
  const gwStatus = useMemo(() => new Map((gatewayRead.data?.servers ?? []).map((s) => [s.name, s])), [gatewayRead.data]);
  const gwHealth = gatewayRead.data ?? { running: false, error: null };
  const refreshGateway = gatewayRead.refresh;
  const [composed, setComposed] = useState<ComposedMcpServerWire[]>([]);
  useEffect(() => {
    if (!bridge || !isUser || !surfaceActive) return;
    let live = true;
    void bridgeMcpResolveComposed(bridge)
      .then((c) => live && setComposed(c))
      .catch(() => {
        /* leave empty — badges/inherited are best-effort */
      });
    return () => {
      live = false;
    };
  }, [bridge, execution, isUser, surfaceActive, servers]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const authAttempt = useRef(0);
  // The gateway owns one OAuth flight across all servers. Claim it before
  // rendering disabled controls and retain it while a paste-code dialog waits.
  const authPending = useRef(false);
  const pendingServer = useRef<string | null>(null);
  useEffect(() => {
    const generation = authAttempt;
    authPending.current = false;
    setSigningIn(null);
    setHeadlessAuth(null);
    setHeadlessBusy(false);
    return () => {
      generation.current++;
      if (pendingServer.current && bridge && runtimeExecutionKey(bridge.executionIdentity) === execution)
        void bridgeMcpGatewayCancelAuth(bridge, pendingServer.current, repoRoot).catch(() => {});
      pendingServer.current = null;
    };
  }, [bridge, execution, repoRoot, surfaceActive]);
  useEffect(() => {
    if (!surfaceActive) return;
    const refresh = () => { if (document.visibilityState !== "hidden") refreshGateway(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refreshGateway, surfaceActive]);
  const previousServers = useRef({ key: statusKey, servers });
  useEffect(() => {
    if (statusKey && previousServers.current.key === statusKey && previousServers.current.servers !== servers) {
      mcpGatewayStatusCache.invalidate(statusKey);
    }
    previousServers.current = { key: statusKey, servers };
  }, [statusKey, servers]);
  const cancelSignIn = async (name: string) => {
    if (!bridge) return;
    const attempt = ++authAttempt.current;
    // Retire the UI flight even if cleanup cannot reach the engine. A late
    // authorization reply must not keep the controls locked or affect Retry.
    authPending.current = false;
    pendingServer.current = null;
    setSigningIn(null);
    setHeadlessAuth(null);
    setHeadlessBusy(false);
    try { await bridgeMcpGatewayCancelAuth(bridge, name, repoRoot); }
    catch { if (attempt === authAttempt.current) toast.error("Could not confirm cancellation. Try connecting again."); }
    if (attempt === authAttempt.current) refreshGateway();
  };

  const handleSignIn = async (name: string) => {
    if (!bridge || !surfaceActive || authPending.current) return;
    authPending.current = true;
    pendingServer.current = name;
    const attempt = ++authAttempt.current;
    let awaitingCode = false;
    setSigningIn(name);
    try {
      const st = await bridgeMcpGatewayAuthorize(bridge, name, repoRoot);
      if (attempt !== authAttempt.current) return;
      rememberAuthorization(name, st);
      if (statusKey) mcpGatewayStatusCache.invalidate(statusKey);
      if (st.state === "connected")
        toast.success(`Signed in to ${name} — ${st.toolCount} tools`);
      else toast.error(`${name}: ${st.detail ?? st.state}`);
    } catch (e) {
      if (attempt !== authAttempt.current) return;
      if (shouldUseHeadlessMcpAuth(e)) {
        try {
          const url = await bridgeMcpGatewayBeginAuth(bridge, name, repoRoot);
          if (attempt !== authAttempt.current) return;
          setHeadlessAuth({ server: name, url });
          awaitingCode = true;
          await shellOpenUrl(url);
          return;
        } catch (headlessError) {
          if (attempt !== authAttempt.current) return;
          toast.error(
            `Couldn't start sign-in for ${name}: ${headlessError instanceof Error ? headlessError.message : String(headlessError)}`,
          );
          return;
        }
      }
      toast.error(
        `Couldn't sign in to ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (attempt === authAttempt.current) {
        if (!awaitingCode) { authPending.current = false; pendingServer.current = null; }
        setSigningIn(null);
        refreshGateway();
      }
    }
  };

  // Headless (no-browser) paste-code sign-in.
  const [headlessAuth, setHeadlessAuth] = useState<{
    server: string;
    url: string;
  } | null>(null);
  const [headlessBusy, setHeadlessBusy] = useState(false);
  const handleBeginHeadless = async (name: string) => {
    if (!bridge || !surfaceActive || authPending.current) return;
    authPending.current = true;
    pendingServer.current = name;
    const attempt = ++authAttempt.current;
    let awaitingCode = false;
    setSigningIn(name);
    try {
      const url = await bridgeMcpGatewayBeginAuth(bridge, name, repoRoot);
      if (attempt !== authAttempt.current) return;
      setHeadlessAuth({ server: name, url });
      awaitingCode = true;
    } catch (e) {
      if (attempt !== authAttempt.current) return;
      toast.error(
        `Couldn't start sign-in for ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (attempt === authAttempt.current) {
        if (!awaitingCode) { authPending.current = false; pendingServer.current = null; }
        setSigningIn(null);
      }
    }
  };
  const handleCompleteHeadless = async (code: string) => {
    if (!bridge || !headlessAuth || headlessBusy) return;
    const server = headlessAuth.server;
    const attempt = ++authAttempt.current;
    setHeadlessBusy(true);
    try {
      const st = await bridgeMcpGatewayCompleteAuth(bridge, server, code, repoRoot);
      if (attempt !== authAttempt.current) return;
      rememberAuthorization(server, st);
      if (statusKey) mcpGatewayStatusCache.invalidate(statusKey);
      if (st.state === "connected")
        toast.success(`Signed in to ${server} — ${st.toolCount} tools`);
      else toast.error(`${server}: ${st.detail ?? st.state}`);
      setHeadlessAuth(null);
    } catch (e) {
      if (attempt !== authAttempt.current) return;
      setHeadlessAuth(null);
      toast.error(
        `Couldn't finish sign-in: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      if (attempt === authAttempt.current) {
        authPending.current = false;
        pendingServer.current = null;
        setHeadlessBusy(false);
        refreshGateway();
      }
    }
  };

  const rememberAuthorization = (name: string, result: GatewayBackendStatusWire) => {
    const server = servers.find(row => row.name === name);
    if (statusKey && server) rememberMcpConnection(statusKey, server, {
      status: result.state === "error" ? "failed" : result.state, stages: [],
      ...(result.state === "connected" ? { toolCount: result.tools?.length ?? result.toolCount, tools: result.tools } : {}),
    });
  };

  const persist = async (previous: RawServer | null, server: RawServer | null, successMsg?: string): Promise<boolean> => {
    if (!bridge || mutating.current) return false;
    mutating.current = true;
    const seq = ++writeSeq.current;
    setBusy(true);
    try {
      const result = await workspaceOp(bridge, server ? "mcp.saveServer" : "mcp.deleteServer", {
        layer: isUser ? "user" : "repo-local", ...(repoRoot ? { repoRoot } : {}), previous, ...(server ? { server } : {}),
      }) as Pick<SettingsReadWire, "path" | "doc">;
      primeSettingsLayer(isUser ? "user" : "repo-local", repoRoot, result);
      if (seq === writeSeq.current) { if (successMsg) toast.success(successMsg); refreshGateway(); }
      return true;
    } catch (error) {
      if (seq === writeSeq.current) toast.error(error instanceof Error ? error.message : "Couldn’t save this MCP server.");
      return false;
    } finally { mutating.current = false; if (seq === writeSeq.current) setBusy(false); }
  };
  const handleRemove = (index: number) => void persist(servers[index], null, "MCP server removed");
  const handleToggle = (index: number, enabled: boolean) => void persist(servers[index], withToggled([servers[index]], 0, enabled)[0]);
  const handleToolToggle = (index: number, tool: string, disabled: boolean) => void persist(servers[index], withToolDisabled([servers[index]], 0, tool, disabled)[0]);

  // Cursor caps total MCP tools at ~40; sum the ENABLED tools across connected
  // gateway servers so the user can keep under it (a lower bound — direct
  // servers add more, unknown to us).
  const gwToolTotal = useMemo(
    () =>
      [...gwStatus.values()].reduce(
        (n, s) => n + (s.state === "connected" ? s.toolCount : 0),
        0,
      ),
    [gwStatus],
  );

  // Stable row keys: the server NAME (unique per scope — the form enforces
  // it), disambiguated by occurrence for hand-written dupes. Index keys would
  // bleed per-row state (an open tools expander) onto the next server when a
  // row above it is removed.
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return servers.map((s) => {
      const name = asString(s.name) || "(unnamed)";
      const n = seen.get(name) ?? 0;
      seen.set(name, n + 1);
      return n === 0 ? name : `${name}~${n}`;
    });
  }, [servers]);

  // Servers contributed by any non-user layer — read-only + override.
  const currentNames = useMemo(
    () => new Set(servers.map((s) => asString(s.name))),
    [servers],
  );
  const inherited = useMemo(
    () =>
      isUser
        ? composed.filter(
            (c) => c.source !== "user" && !currentNames.has(c.name),
          )
        : [],
    [isUser, composed, currentNames],
  );
  const handleOverride = (c: ComposedMcpServerWire) =>
    void persist(
      null, rawFromComposed(c),
      `Added ${c.name} to your servers`,
    );

  const scopeBlurb = isUser
    ? "Connect tools and services across your local projects. Changes apply to new chats."
    : `MCP servers for ${scope.kind === "repo" ? scope.project.name : "this repo"} and its local workspaces. Saved privately on this device; changes apply to new chats here.`;

  return (
    <div className="flex flex-col gap-4" {...(!surfaceActive ? { inert: "" } : {})}>
      <SettingsSection
        title="MCP servers"
        description={scopeBlurb}
        action={
          isUser ? (
            <Tooltip label="Import servers">
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => setImporting(true)}
              >
                <Download className="size-3.5" aria-hidden="true" />
                Import
              </Button>
            </Tooltip>
          ) : undefined
        }
      >
        {gwToolTotal > 0 && (
          <p
            className={cn(
              "text-xs",
              gwToolTotal > 40 ? "text-red-primary" : "text-fg2",
            )}
          >
            {gwToolTotal} gateway tool{gwToolTotal === 1 ? "" : "s"} enabled
            {gwToolTotal > 40
              ? " — over Cursor's ~40-tool cap; expand a server below and turn some off."
              : " · Cursor caps total MCP tools at ~40."}
          </p>
        )}

        {error && (
          <p className="text-red-primary flex items-center gap-1.5 text-sm">
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}

        {loading && servers.length === 0 ? (
          <div className="min-h-24" aria-busy="true" />
        ) : (
          <div className="flex flex-col gap-3">
            {servers.length > 0 && (
              <div className={MCP_CARD_CLS}>
                {servers.map((server, index) => (
                  <ServerRow
                    key={rowKeys[index]}
                    server={server}
                    verificationOwner={statusKey ?? "unavailable-local"}
                    busy={busy}
                    gateway={
                      (server.auth === "oauth" || server.auth === "header")
                        ? {
                            status: gwStatus.get(asString(server.name))?.url === server.url ? gwStatus.get(asString(server.name)) : undefined,
                            observedAt: gatewayRead.updatedAt,
                            error: gwHealth.error,
                            signingIn: signingIn === asString(server.name),
                            signInBlocked: signingIn !== null || headlessAuth !== null,
                            onCancel: () => { void cancelSignIn(asString(server.name)).catch(() => toast.error("Couldn't cancel sign-in.")); },
                            onReconnect: () => { if (bridge) void bridgeMcpGatewayReconnect(bridge, repoRoot).then(refreshGateway).catch(() => toast.error("Couldn't reconnect MCP servers.")); },
                            onSignIn: () =>
                              void handleSignIn(asString(server.name)),
                            onToolToggle: (tool, disabled) =>
                              handleToolToggle(index, tool, disabled),
                            onBeginHeadless: () =>
                              void handleBeginHeadless(asString(server.name)),
                          }
                        : undefined
                    }
                    onToggle={(enabled) => handleToggle(index, enabled)}
                    onEdit={() => onEdit(server)}
                    onConnect={() => onEdit(server, true)}
                    onRemove={() => handleRemove(index)}
                  />
                ))}
              </div>
            )}

            <NewServerCard onClick={onNew} disabled={loading || busy} />
          </div>
        )}

        {inherited.length > 0 && (
          <div className="flex flex-col gap-1 pt-2">
            {/* Layer-neutral on purpose: `inherited` is every non-user
                source (team, managed, repo…), so naming one of them here
                would misattribute the others. Each row carries its own
                source badge — that's where attribution belongs. */}
            <div className="text-fg2 text-xs font-medium">Inherited</div>
            <div className={MCP_CARD_CLS}>
              {inherited.map((c) => (
                <InheritedServerRow
                  key={`${c.source}:${c.name}`}
                  composed={c}
                  busy={busy}
                  onOverride={() => handleOverride(c)}
                />
              ))}
            </div>
          </div>
        )}

        {!isUser && (
          <p className="text-fg2 text-xs">
            Your User MCP servers apply here automatically.{" "}
            <button
              type="button"
              onClick={onSwitchToUser}
              className="text-fg2 hover:text-fg1 font-medium underline-offset-2 transition-colors hover:underline"
            >
              Manage User servers
            </button>
          </p>
        )}
      </SettingsSection>

      {isUser && (
        <McpImportDialog
          open={importing}
          onClose={() => setImporting(false)}
        />
      )}

      <HeadlessAuthModal
        state={headlessAuth}
        busy={headlessBusy}
        onCancel={() => { if (headlessAuth) void cancelSignIn(headlessAuth.server).catch(() => toast.error("Couldn't cancel sign-in.")); }}
        onComplete={(code) => void handleCompleteHeadless(code)}
      />
    </div>
  );
}

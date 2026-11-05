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
import { Button, Input } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives/badge";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { SkeletonLine } from "../../shared/ui/primitives/skeleton";
import { Tooltip } from "@/renderer/shared/ui/primitives";
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
import { SettingsAddRow, SettingsGroup, SettingsList } from "../settings/settings-ui";
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
import { McpServerRow, McpToolCount, McpToolList } from "./mcp-server-row";

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
            Authorize in your browser, then paste the code or redirect URL.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-url`} className="text-fg1 text-xs leading-4.5 font-medium">
                Authorization URL
              </label>
              <div className="flex gap-2">
                <Input
                  id={`${id}-url`}
                  readOnly
                  value={state?.url ?? ""}
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
              <label htmlFor={`${id}-code`} className="text-fg1 text-xs leading-4.5 font-medium">
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
                autoFocus
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!code.trim()}
            onClick={() => onComplete(code.trim())}
          >
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
  const blocked = busy || !!gateway?.signInBlocked;
  const detail = gwDown ? gateway?.error ?? undefined : gateway?.status?.detail;
  // Status shows only when the server needs the person: Connected, Starts
  // with agent and Disabled are normal states and the switch says Disabled.
  const tone = gateway?.signingIn ? null
    : view.tone === "warning" ? "warning" as const
      : view.tone === "error" ? "failure" as const
        : view.label === "Needs connection" ? "neutral" as const : null;
  const status = gateway?.signingIn ? (
    <Badge variant="neutral">
      <ZerosSpinner size={12} label="Signing in" />
      Signing in…
    </Badge>
  ) : tone ? (
    <Tooltip label={detail}>
      <Badge variant={tone}>{view.label}</Badge>
    </Tooltip>
  ) : null;
  // One action. A sign-in server connects in the browser; others open the
  // editor to check the connection. While signing in, only Cancel.
  const action = gateway?.signingIn ? (
    <Button variant="secondary" size="compact" onClick={gateway.onCancel}>
      Cancel
    </Button>
  ) : view.action && view.label !== "Connected" ? (
    isOauth && gateway && view.action === "connect" ? (
      <Button
        variant="secondary"
        size="compact"
        onClick={gateway.onSignIn}
        disabled={blocked}
      >
        Connect
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="compact"
        disabled={blocked}
        onClick={gateway && view.tone === "error" ? gateway.onReconnect : onConnect}
      >
        {view.tone === "error" ? "Retry" : "Connect"}
      </Button>
    )
  ) : null;
  const headless =
    isOauth && enabled && gateway?.onBeginHeadless && !gwDown && st === "needs-auth"
      ? gateway.onBeginHeadless
      : undefined;
  return (
    <McpServerRow
      transport={transportOf(server)}
      name={name}
      hint={description || endpointSummary(server)}
      hintMono={!description}
      status={status}
      action={action}
      tools={
        canExpand ? (
          <McpToolCount
            count={allTools.length}
            open={showTools}
            onToggle={() => setShowTools((value) => !value)}
          />
        ) : undefined
      }
      toggle={{ checked: enabled, onCheckedChange: onToggle, disabled: blocked }}
      onOpen={{ label: `Edit ${name}`, onClick: onEdit, disabled: busy }}
      menu={{
        disabled: blocked,
        items: [
          { label: "Edit", onSelect: onEdit },
          ...(headless
            ? [{ label: "Sign in without a browser", onSelect: headless }]
            : []),
          { label: "Remove", onSelect: onRemove, destructive: true },
        ],
      }}
    >
      {showTools && canExpand ? (
        <McpToolList
          server={name}
          tools={allTools}
          isOn={(tool) => !disabledSet.has(tool)}
          onToggle={(tool, on) => gateway?.onToolToggle?.(tool, !on)}
          disabled={busy}
        />
      ) : null}
    </McpServerRow>
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
    <McpServerRow
      transport={composed.transport}
      name={composed.name}
      hint={endpoint}
      hintMono
      dimmed
      status={<Badge variant="neutral">{layerLabel(composed.source)}</Badge>}
      trailing={
        <Button
          variant="secondary"
          size="compact"
          onClick={onOverride}
          disabled={busy}
        >
          Override here
        </Button>
      }
    />
  );
}

/** Two quiet rows while the list first loads. */
function SkeletonRows() {
  return (
    <>
      {["46%", "34%"].map((width) => (
        <div key={width} aria-hidden className="flex h-5 items-center">
          <SkeletonLine style={{ width }} />
        </div>
      ))}
    </>
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
    ? "Changes apply to new chats."
    : `For ${scope.kind === "repo" ? scope.project.name : "this repository"} only. Changes apply to new chats.`;

  const toolLine = `${gwToolTotal} ${gwToolTotal === 1 ? "tool" : "tools"} on · Cursor allows about 40.`;

  return (
    <div className="flex flex-col gap-8" {...(!surfaceActive ? { inert: "" } : {})}>
      <section aria-label="MCP servers" className="flex flex-col gap-2">
        <div className="flex items-end justify-between gap-4 px-0.5">
          <p className="text-fg3 m-0 text-3xxs leading-4">{scopeBlurb}</p>
          {isUser && (
            <Button
              variant="secondary"
              size="compact"
              className="shrink-0"
              onClick={() => setImporting(true)}
            >
              Import
            </Button>
          )}
        </div>
        <SettingsList aria-busy={(loading && servers.length === 0) || undefined}>
          {gwToolTotal > 40 && (
            <MessageRow tone="warning" flush>
              {`${toolLine} Turn some off.`}
            </MessageRow>
          )}
          {error && (
            <MessageRow tone="error" role="alert" flush>
              {error}
            </MessageRow>
          )}
          {loading && servers.length === 0 ? (
            <SkeletonRows />
          ) : servers.length === 0 ? (
            <p className="text-fg2 m-0 text-xs leading-4.5">No servers yet.</p>
          ) : (
            servers.map((server, index) => (
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
            ))
          )}
          <SettingsAddRow label="Add server" onClick={onNew} disabled={loading || busy} />
        </SettingsList>
        {gwToolTotal > 0 && gwToolTotal <= 40 && (
          <p className="text-fg3 m-0 px-0.5 text-3xxs leading-4">{toolLine}</p>
        )}
        {!isUser && (
          <p className="text-fg3 m-0 px-0.5 text-3xxs leading-4">
            Your User servers apply here too.{" "}
            <button
              type="button"
              onClick={onSwitchToUser}
              className="text-fg1 hover:text-fg1 font-medium underline-offset-2 hover:underline"
            >
              Manage User servers
            </button>
          </p>
        )}
      </section>

      {inherited.length > 0 && (
        // Layer-neutral on purpose: `inherited` is every non-user source
        // (team, managed, repo…); each row's badge names its own layer.
        <SettingsGroup title="Inherited" description="From your team, admin or repository.">
          {inherited.map((c) => (
            <InheritedServerRow
              key={`${c.source}:${c.name}`}
              composed={c}
              busy={busy}
              onOverride={() => handleOverride(c)}
            />
          ))}
        </SettingsGroup>
      )}

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

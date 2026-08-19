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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { useBridge } from "../../platform/bridge/use-bridge";
import { shellOpenUrl } from "../../platform/app";
import {
  bridgeMcpGatewayAuthorize,
  bridgeMcpGatewayBeginAuth,
  bridgeMcpGatewayCompleteAuth,
  bridgeMcpGatewayStatus,
  bridgeMcpResolveComposed,
  type ComposedMcpServerWire,
  type GatewayBackendStatusWire,
} from "../../platform/bridge/workspace-bridge";
import { useSettingsLayer } from "../settings/use-settings";
import { SettingsSection } from "../settings/settings-ui";
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
import { McpImportDialog } from "./mcp-import-dialog";
import type { ResolvedCustomizeScope } from "./customize-page";
import { shouldUseHeadlessMcpAuth } from "./mcp-auth-flow";

// The filled-card recipe the Models settings page uses — rows separated by
// hairline dividers inside one rounded `--bg1-highlight` surface.
export const MCP_CARD_CLS =
  "bg-bg1-highlight divide-border1 flex flex-col divide-y rounded-lg px-4";

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
  if (c.transport === "http") {
    return {
      name: c.name,
      transport: "http",
      url: c.url ?? "",
      ...(c.auth ? { auth: c.auth } : {}),
    };
  }
  return {
    name: c.name,
    transport: "stdio",
    command: c.command ?? "",
    ...(c.args && c.args.length ? { args: c.args } : {}),
  };
}

/** The no-browser paste-code sign-in: show the authorization URL to open
 *  elsewhere, then take the pasted code (or full redirect URL) to finish. */
function HeadlessAuthModal({
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
            No browser here? Open this URL on any device, authorize, then paste
            the code (or the full redirect URL) it gives you.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-fg1 text-[14px] font-medium">
              Authorization URL
            </span>
            <div className="flex gap-2">
              <Input
                readOnly
                value={state?.url ?? ""}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="secondary"
                size="lg"
                className="shrink-0"
                onClick={() => {
                  if (state?.url) {
                    void navigator.clipboard?.writeText(state.url);
                    toast.success("URL copied");
                  }
                }}
              >
                Copy
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-fg1 text-[14px] font-medium">
              Code or redirect URL
            </span>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="code=… or the full …/callback?code=… URL"
              className="font-mono text-xs"
              autoFocus
            />
            <p className="text-fg2 text-xs">
              Paste what the browser shows after you authorize.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!code.trim() || busy}
            onClick={() => onComplete(code.trim())}
            className="gap-1.5"
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
  server,
  busy,
  repoScope,
  gateway,
  onToggle,
  onEdit,
  onRemove,
}: {
  server: RawServer;
  busy: boolean;
  /** True in a repo scope — gateway-auth entries get the "User-only" chip. */
  repoScope: boolean;
  /** Gateway controls for a gateway-fronted (oauth/header) server, user scope only. */
  gateway?: {
    status?: GatewayBackendStatusWire;
    error?: string | null;
    signingIn: boolean;
    onSignIn: () => void;
    onToolToggle?: (tool: string, disabled: boolean) => void;
    onBeginHeadless?: () => void;
  };
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const name = asString(server.name) || "(unnamed)";
  const description = asString(server.description);
  const enabled = isEnabled(server);
  const isOauth = server.auth === "oauth";
  const gatewayManaged = isOauth || server.auth === "header";
  const st = gateway?.status?.state;
  const gwDown = gatewayManaged && !!gateway?.error;
  const allTools = gateway?.status?.tools ?? [];
  const disabledSet = new Set(disabledToolsOf(server));
  const canExpand =
    st === "connected" && allTools.length > 0 && !!gateway?.onToolToggle;
  const [showTools, setShowTools] = useState(false);
  const chipCls = cn(
    "inline-flex select-none items-center gap-1 rounded-sm border px-1.5 py-px text-xs font-medium",
    gwDown || st === "error"
      ? "border-red-primary/40 text-red-primary"
      : st === "connected"
        ? "border-border1 text-fg1"
        : "border-border1 text-fg2",
  );
  const chipText = gwDown
    ? "Gateway unavailable"
    : st === "connected"
      ? `${gateway?.status?.toolCount ?? 0}/${allTools.length} tools`
      : st === "error"
        ? "error"
        : isOauth
          ? "OAuth · sign in"
          : "connecting…";
  return (
    <div className={cn("flex flex-col gap-2 py-3.5", !enabled && "opacity-60")}>
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
          aria-label={`Edit ${name}`}
        >
          <span className="border-border1 text-fg2 shrink-0 rounded-sm border px-1.5 py-px text-xs font-medium select-none">
            {transportOf(server)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="text-fg1 truncate text-[14px] font-medium">
                {name}
              </span>
              {repoScope && gatewayManaged && (
                <Tooltip label="Gateway auth (OAuth / brokered header) works for User servers only — this entry is ignored here. Move it to the User scope.">
                  <span className="border-red-primary/40 text-red-primary text-xxs shrink-0 rounded-sm border px-1 py-px font-medium select-none">
                    User-only auth
                  </span>
                </Tooltip>
              )}
            </span>
            <span className="text-fg2 block truncate text-xs">
              {description || (
                <span className="font-mono">{endpointSummary(server)}</span>
              )}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {!repoScope &&
            gatewayManaged &&
            (canExpand ? (
              <Tooltip label="Show tools">
                <button
                  type="button"
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
                </button>
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
          {!repoScope && isOauth && gateway && !gwDown && st !== "connected" && (
            <Tooltip label="Sign in">
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={gateway.onSignIn}
                disabled={gateway.signingIn || busy}
              >
                {gateway.signingIn ? (
                  <ZerosSpinner size={16} />
                ) : (
                  <LogIn className="size-3.5" aria-hidden="true" />
                )}
                Sign in
              </Button>
            </Tooltip>
          )}
          {!repoScope &&
            isOauth &&
            gateway?.onBeginHeadless &&
            !gwDown &&
            st !== "connected" && (
              <Tooltip label="Authorize on another device">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-fg2 hover:text-fg1 px-1.5 text-xs"
                  onClick={gateway.onBeginHeadless}
                  disabled={gateway.signingIn || busy}
                >
                  No browser?
                </Button>
              </Tooltip>
            )}
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={busy}
            aria-label={enabled ? "Disable server" : "Enable server"}
            className="mr-1"
          />
          <Tooltip label="Edit">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onEdit}
              disabled={busy}
              aria-label="Edit server"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip label="Remove">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onRemove}
              disabled={busy}
              className="text-fg2 hover:bg-red-primary/10 hover:text-red-primary"
              aria-label="Remove server"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
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
    composed.transport === "http"
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
      <Tooltip label="Copy into your user servers to edit">
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
        <span className="text-fg1 text-[14px] font-medium">New MCP server</span>
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
  onEdit: (index: number) => void;
  /** Repo scope's footnote link — jump to the User scope's list. */
  onSwitchToUser: () => void;
}) {
  const isUser = scope.kind === "user";
  const repoRoot = scope.kind === "repo" ? scope.project.repoRoot : undefined;
  const { layer, loading, error, write } = useSettingsLayer(
    isUser ? "user" : "repo-local",
    repoRoot,
  );
  const servers = useMemo(() => readRawServers(layer?.doc), [layer?.doc]);

  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  // Guard against a stale write resolving after the component changed servers.
  const writeSeq = useRef(0);

  // ── Gateway controls (user scope only) — the one user-global gateway
  // fronts every auth:"oauth"/"header" backend. Local engines open the
  // browser directly; cloud engines return a URL that this trusted renderer
  // opens on the user's device.
  const bridge = useBridge();
  const [gwStatus, setGwStatus] = useState<
    Map<string, GatewayBackendStatusWire>
  >(new Map());
  const [gwHealth, setGwHealth] = useState<{
    running: boolean;
    error: string | null;
  }>({ running: false, error: null });
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
  }, [bridge, isUser, surfaceActive, servers]);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const refreshGateway = useCallback(async () => {
    if (!bridge || !isUser) return;
    try {
      const s = await bridgeMcpGatewayStatus(bridge);
      setGwStatus(new Map(s.servers.map((x) => [x.name, x])));
      setGwHealth({ running: s.running, error: s.error });
    } catch {
      /* gateway down / remote — leave status empty (rows show "sign in") */
    }
  }, [bridge, isUser]);
  useEffect(() => {
    if (!isUser || !surfaceActive) return;
    void refreshGateway();
    // The gateway (re)starts asynchronously after a settings change — re-poll
    // once so a freshly-added server flips to connected, or surfaces "Gateway
    // unavailable" if the start failed (e.g. the port is taken).
    const t = setTimeout(() => void refreshGateway(), 1500);
    return () => clearTimeout(t);
  }, [refreshGateway, isUser, surfaceActive, servers]);

  const handleSignIn = async (name: string) => {
    if (!bridge) return;
    setSigningIn(name);
    try {
      const st = await bridgeMcpGatewayAuthorize(bridge, name);
      setGwStatus((prev) => new Map(prev).set(name, st));
      if (st.state === "connected")
        toast.success(`Signed in to ${name} — ${st.toolCount} tools`);
      else toast.error(`${name}: ${st.detail ?? st.state}`);
    } catch (e) {
      if (shouldUseHeadlessMcpAuth(e)) {
        try {
          const url = await bridgeMcpGatewayBeginAuth(bridge, name);
          setHeadlessAuth({ server: name, url });
          await shellOpenUrl(url);
          return;
        } catch (headlessError) {
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
      setSigningIn(null);
      void refreshGateway();
    }
  };

  // Headless (no-browser) paste-code sign-in.
  const [headlessAuth, setHeadlessAuth] = useState<{
    server: string;
    url: string;
  } | null>(null);
  const [headlessBusy, setHeadlessBusy] = useState(false);
  const handleBeginHeadless = async (name: string) => {
    if (!bridge) return;
    setSigningIn(name);
    try {
      const url = await bridgeMcpGatewayBeginAuth(bridge, name);
      setHeadlessAuth({ server: name, url });
    } catch (e) {
      toast.error(
        `Couldn't start sign-in for ${name}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSigningIn(null);
    }
  };
  const handleCompleteHeadless = async (code: string) => {
    if (!bridge || !headlessAuth) return;
    const server = headlessAuth.server;
    setHeadlessBusy(true);
    try {
      const st = await bridgeMcpGatewayCompleteAuth(bridge, server, code);
      setGwStatus((prev) => new Map(prev).set(server, st));
      if (st.state === "connected")
        toast.success(`Signed in to ${server} — ${st.toolCount} tools`);
      else toast.error(`${server}: ${st.detail ?? st.state}`);
      setHeadlessAuth(null);
    } catch (e) {
      toast.error(
        `Couldn't finish sign-in: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setHeadlessBusy(false);
      void refreshGateway();
    }
  };

  const persist = async (
    next: RawServer[],
    successMsg?: string,
  ): Promise<boolean> => {
    const seq = ++writeSeq.current;
    setBusy(true);
    try {
      await write({ mcp: { servers: next } });
      if (successMsg && seq === writeSeq.current) toast.success(successMsg);
      return true;
    } catch {
      toast.error("Couldn't save MCP servers");
      return false;
    } finally {
      if (seq === writeSeq.current) setBusy(false);
    }
  };

  const handleRemove = (index: number) =>
    void persist(
      servers.filter((_, i) => i !== index),
      "MCP server removed",
    );
  const handleToggle = (index: number, enabled: boolean) =>
    void persist(withToggled(servers, index, enabled));
  const handleToolToggle = (index: number, tool: string, disabled: boolean) =>
    void persist(withToolDisabled(servers, index, tool, disabled));

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
      [...servers, rawFromComposed(c)],
      `Added ${c.name} to your servers`,
    );

  const scopeBlurb = isUser
    ? "Tools every agent can call, in every repo. Changes apply to each agent's next chat — no restart needed."
    : `Tools available only in ${scope.kind === "repo" ? scope.project.name : "this repo"}. Saved on this Mac (never committed); changes apply to each agent's next chat here.`;

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="MCP servers"
        description={scopeBlurb}
        action={
          isUser ? (
            <Tooltip label="Import servers found in Cursor / Claude / Codex configs">
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 gap-1.5"
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
                    busy={busy}
                    repoScope={!isUser}
                    gateway={
                      isUser &&
                      (server.auth === "oauth" || server.auth === "header")
                        ? {
                            status: gwStatus.get(asString(server.name)),
                            error: gwHealth.error,
                            signingIn: signingIn === asString(server.name),
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
                    onEdit={() => onEdit(index)}
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
        onCancel={() => setHeadlessAuth(null)}
        onComplete={(code) => void handleCompleteHeadless(code)}
      />
    </div>
  );
}

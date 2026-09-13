// ──────────────────────────────────────────────────────────
// Providers panel — Settings → Providers
// ──────────────────────────────────────────────────────────
//
// One tab per coding agent. Connect opens Account / CLI / API choices, with
// a single effective authentication method. Executable and existing gateway
// overrides remain separate provider configuration.
//
// Reads/writes:
//   - `provider-prefs:<agentId>` in the native settings store
//     (auth method + path overrides; see provider-prefs.ts)
//   - SECRET_ACCOUNTS.{OPENAI,ANTHROPIC}_API_KEY in the macOS
//     keychain (apps/desktop/src/renderer/platform/secrets.ts)
//   - Live agent registry via the bridge (`AGENT_LIST_AGENTS`)
//
// The auth-method preference is consumed at session spawn time —
// see use-agent-session.tsx for the read path. CLI vs API key is
// purely an env-injection difference; the engine always spawns
// the same headless subprocess either way.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  Folder,
  Check,
  Play,
  Copy,
  RefreshCw,
} from "lucide-react";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import { openAgentConfig } from "../../platform/app";
import { cn } from "@/renderer/shared/ui/cn";
import { flushAgentPreferences } from "../../platform/agent-preferences";
import { subscribeProviderAuth } from "../../platform/provider-auth-state";
import { AgentIcon } from "../agent/agent-icon";
import { InlineLoginTerminal } from "./inline-login-terminal";
import { ProviderConnectionDialog } from "./provider-connection-dialog";
import {
  connectionLabel,
  connectionMethod,
  rememberConnectionMethod,
  type ConnectionMethod,
} from "./connection-methods";
import { subscribeProviderSettingsTab } from "./settings-navigation";
import { SettingsSection, SettingsField } from "./settings-ui";
import { ProviderInformation } from "./provider-information";
import { SubscriptionConnectionPanel } from "./subscription-connection-panel";
import {
  cancelSubscription,
  changeSubscriptionAccount,
  isSubscriptionProvider,
  readSubscription,
  subscriptionCache,
} from "./subscription-connection";
import { nativeInvoke, useNativeRuntime } from "../../platform/runtime";
import { useCachedRead } from "../../state/use-cached-read";
import { getSetting, setSetting } from "../../platform/settings";
import {
  deleteSecret,
  getSecret,
  setSecret,
  SECRET_ACCOUNTS,
} from "../../platform/secrets";
import {
  invalidateAgentsCache,
  loadAgents,
  refreshAgents,
  useAgentsSnapshot,
} from "../agent/agents-cache";
import { useBridge, useBridgeStatus } from "../../platform/bridge/use-bridge";
import type {
  AgentAgentsListMessage,
  AgentKeyValidatedMessage,
  BridgeRegistryAgent,
} from "../../platform/bridge/messages";
import {
  getProviderPrefs,
  setProviderPrefs,
  subscribeProviderPreferences,
  type ProviderPrefs,
} from "./provider-prefs";

// ──────────────────────────────────────────────────────────
// Per-agent vendor enrichment for the API-key path. The settings
// panel only needs the vendor/env-var/keychain bits (it does not
// need a full auth React surface).
// ──────────────────────────────────────────────────────────

interface ProviderVendorConfig {
  /** Display name, e.g. "Anthropic". */
  vendor: string;
  /** Env var the CLI reads at spawn time. */
  envVar: string;
  /** Keychain slot from SECRET_ACCOUNTS. */
  secretAccount: string;
  /** Where the user gets their key. */
  consoleUrl: string;
  /** Optional gateway base URL env var (Claude only today). */
  gatewayBaseUrlVar?: string;
}

const PROVIDER_VENDOR_CONFIG: Record<string, ProviderVendorConfig> = {
  claude: {
    vendor: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    secretAccount: SECRET_ACCOUNTS.ANTHROPIC_API_KEY,
    consoleUrl: "https://console.anthropic.com/settings/keys",
    gatewayBaseUrlVar: "ANTHROPIC_BASE_URL",
  },
  codex: {
    vendor: "OpenAI",
    envVar: "OPENAI_API_KEY",
    secretAccount: SECRET_ACCOUNTS.OPENAI_API_KEY,
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  // Cursor supports browser subscription sign-in and a manually supplied key.
  cursor: {
    vendor: "Cursor",
    envVar: "CURSOR_API_KEY",
    secretAccount: SECRET_ACCOUNTS.CURSOR_API_KEY,
    consoleUrl: "https://cursor.com/dashboard/api",
  },
};

// Providers with an API-key option alongside subscription sign-in.
const API_KEY_PROVIDERS = new Set(Object.keys(PROVIDER_VENDOR_CONFIG));

// Tab ordering — Claude + Codex first (the two API-key candidates), then Cursor.
const PROVIDER_ORDER = ["claude", "codex", "cursor"] as const;

/** What an empty Executable path resolves to, per agent — mirrors each
 *  adapter's REAL resolution so the hint never implies a $PATH lookup that
 *  doesn't happen:
 *    • claude → the Agent SDK's bundled, pinned claude-code CLI (NOT $PATH).
 *    • codex  → the bundled @openai/codex wrapper, then `codex` on $PATH.
 *  (Cursor runs in-process on the bundled @cursor/sdk and shows no Executable
 *  path field at all.) Keep in sync with claude-sdk/adapter.ts and
 *  codex/binary-resolver.ts. */
function ExecutablePathHint({
  agentId,
  name,
}: {
  agentId: string;
  name: string;
}): React.ReactElement {
  if (agentId === "codex") {
    return (
      <>
        Leave blank to use the bundled Codex, falling back to{" "}
        <span className="bg-bg2-hover text-fg1 rounded-sm px-1.5 py-0.5 text-xs">
          codex
        </span>{" "}
        on your $PATH.
      </>
    );
  }
  return <>Leave blank to use the bundled {name} (recommended).</>;
}

/** Each agent's own native config file — we link out to it (Finder / copy path)
 *  instead of duplicating the agent's settings in our UI. Claude reads tool
 *  permissions / hooks / env from settings.json; Codex reads model / sandbox /
 *  MCP from config.toml. Cursor has no user-editable CLI config (bundled SDK),
 *  so it has no entry. Keep the paths in sync with electron's AGENT_CONFIG_FILES
 *  (ipc/commands/shell.ts). */
const AGENT_CONFIG_FILE: Record<string, { title: string; path: string }> = {
  claude: { title: "Claude settings", path: "~/.claude/settings.json" },
  codex: { title: "Codex config", path: "~/.codex/config.toml" },
};

/** A card linking to an agent's own config file: reveal it in Finder (created
 *  if missing) or copy the path. Renders nothing for agents without an
 *  AGENT_CONFIG_FILE entry (e.g. Cursor). */
function AgentConfigCard({ agentId }: { agentId: string }) {
  const cfg = AGENT_CONFIG_FILE[agentId];
  if (!cfg) return null;
  return (
    <div className="border-border1 flex flex-row items-center justify-between gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <div className="text-fg1 text-[14px] font-medium">{cfg.title}</div>
        <code className="text-fg2 text-xs">{cfg.path}</code>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="gap-1.5">
            <Folder className="size-3.5" aria-hidden="true" />
            Open in
            <ChevronDown className="size-3" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[160px]"
        >
          <DropdownMenuItem onSelect={() => void openAgentConfig(agentId)}>
            <Folder className="text-fg2 size-3.5" />
            <span>Finder</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void (async () => {
                try {
                  await navigator.clipboard.writeText(cfg.path);
                  toast.success("Path copied");
                } catch {
                  /* clipboard unavailable or blocked; non-essential */
                }
              })();
            }}
          >
            <Copy className="text-fg2 size-3.5" />
            <span>Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Top-level panel
// ──────────────────────────────────────────────────────────

const PROVIDERS_ACTIVE_TAB_KEY = "providers:active-tab";

function loadInitialProviderTab(): string {
  const saved = getSetting<string>(PROVIDERS_ACTIVE_TAB_KEY, "claude");
  return (PROVIDER_ORDER as readonly string[]).includes(saved)
    ? saved
    : "claude";
}

export function ProvidersPanel({
  surfaceActive = true,
}: {
  surfaceActive?: boolean;
}) {
  const bridge = useBridge();
  const agents = useAgentsSnapshot();
  // Persisted across reloads — Cmd+R on the Codex tab lands you on
  // Codex, not Claude. Type-guarded on read so a stale id from a
  // removed provider can never break the panel.
  const [activeId, setActiveIdState] = useState<string>(loadInitialProviderTab);
  const setActiveId = (next: string) => {
    setActiveIdState(next);
    setSetting(PROVIDERS_ACTIVE_TAB_KEY, next);
  };

  const listAgents = useCallback(
    async (force?: boolean): Promise<BridgeRegistryAgent[]> => {
      if (!bridge) return [];
      const resp = await bridge.request<AgentAgentsListMessage>(
        { type: "AGENT_LIST_AGENTS", force: force ?? false },
        30_000,
      );
      return resp.agents;
    },
    [bridge],
  );

  // Stash the latest listAgents in a ref so the effects below don't
  // re-bind every time its identity changes (which happened on every
  // bridge state transition + every HMR remount, repeatedly clearing
  // and re-scheduling the mount-time timer so it never fired). The
  // ref lets us read the freshest callback from a single stable
  // mount effect.
  const listAgentsRef = useRef(listAgents);
  useEffect(() => {
    listAgentsRef.current = listAgents;
  }, [listAgents]);

  // Initial load — fires once on mount. The agents-cache already
  // de-dupes concurrent in-flight calls via its module-level
  // `inFlight` promise, so HMR storms / rapid remounts coalesce on
  // their own; no debounce needed here. (An earlier debounce kept
  // getting cancelled by listAgents identity churn before the timer
  // could fire, leaving the panel stuck on "Loading providers".)
  useEffect(() => {
    if (!surfaceActive) return;
    void loadAgents(listAgentsRef.current).catch(() => {
      /* surfaced by the cache via toast */
    });
  }, [surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) return;
    return subscribeProviderAuth(() => {
      void refreshAgents(listAgentsRef.current).catch(() => {});
    });
  }, [surfaceActive]);

  // Window-focus refresh — so coming back from a Terminal sign-in
  // flips the dot without a manual click. Debounced 300 ms so rapid
  // focus/blur (alt-tab churn) doesn't fan out probes. Empty deps so
  // the listener attaches once; we read the latest callback via ref.
  useEffect(() => {
    if (!surfaceActive) return;
    let t: number | null = null;
    const onFocus = () => {
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        invalidateAgentsCache();
        void loadAgents(listAgentsRef.current).catch(() => {});
      }, 300);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      if (t !== null) window.clearTimeout(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [surfaceActive]);

  // Bridge-reconnect refresh. The mount-effect above fires once, and
  // if the bridge isn't connected yet (engine still booting / mid-
  // respawn after an `apps/desktop/src/engine/**` save), `listAgents` rejects and
  // the cache enters its error state with `agents = []` — the panel
  // then renders "Loading providers…" forever because nothing else
  // re-fires the fetch. Mirroring empty-composer's pattern: when the
  // bridge transitions disconnected → connected (initial connect OR
  // engine-restarted handler's forceReconnect), invalidate + reload.
  const bridgeStatus = useBridgeStatus();
  const lastBridgeStatusRef = useRef(bridgeStatus);
  useEffect(() => {
    const prev = lastBridgeStatusRef.current;
    lastBridgeStatusRef.current = bridgeStatus;
    if (!surfaceActive) return;
    if (prev !== "connected" && bridgeStatus === "connected") {
      invalidateAgentsCache();
      void loadAgents(listAgentsRef.current).catch(() => {});
    }
  }, [bridgeStatus, surfaceActive]);

  // ENGINE_READY refresh. The bridge-reconnect effect above fires on the
  // *socket*-connected transition, which after an engine respawn (HMR /
  // watchdog / crash) can land BEFORE the fresh engine can serve
  // AGENT_LIST_AGENTS. That single attempt then fails (request dropped /
  // times out against a not-yet-ready engine), and because bridgeStatus
  // stays "connected" nothing re-fires — the panel sticks on "Loading
  // providers…" until a manual refresh (the exact "all agents just keep
  // loading, then I refreshed the registry and it came back" report).
  // The engine sends ENGINE_READY once it can actually serve requests, on
  // EVERY (re)connect — so reload then. We do NOT invalidate here: if the
  // socket-connect attempt already succeeded the cache is fresh and this
  // is a no-op; if it failed (lastLoadedAt stayed 0) this re-fetches
  // against the now-ready engine and self-heals without user action.
  useEffect(() => {
    if (!surfaceActive || !bridge) return;
    return bridge.on("ENGINE_READY", () => {
      void loadAgents(listAgentsRef.current).catch(() => {});
    });
  }, [bridge, surfaceActive]);

  const ordered = useMemo(() => {
    if (!agents) return [];
    return PROVIDER_ORDER.map((id) => agents.find((a) => a.id === id)).filter(
      (a): a is BridgeRegistryAgent => !!a,
    );
  }, [agents]);

  useEffect(() => subscribeProviderSettingsTab(setActiveIdState), []);

  const active = ordered.find((a) => a.id === activeId) ?? ordered[0];

  // Per-provider Refresh re-runs the engine probe sweep (install / auth /
  // version — and, once wired, the account fetch) for every provider in one
  // round-trip; the snapshot update re-renders the active card.
  const handleRefresh = useCallback(
    () => refreshAgents(listAgents),
    [listAgents],
  );

  return (
    <div className="flex flex-col gap-8">
      {ordered.length === 0 ? (
        <div className="min-h-24" aria-busy="true" />
      ) : (
        <>
          <ProviderTabs
            providers={ordered}
            activeId={active?.id ?? ordered[0].id}
            onSelect={setActiveId}
          />
          {active && (
            <ProviderCard
              key={active.id}
              agent={active}
              surfaceActive={surfaceActive}
              onRefresh={handleRefresh}
            />
          )}
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Tab strip
// ──────────────────────────────────────────────────────────

function ProviderTabs({
  providers,
  activeId,
  onSelect,
}: {
  providers: BridgeRegistryAgent[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  // Underline-tab pattern: parent owns the 1 px baseline; each button
  // contributes a 2 px `border-b` that sits one pixel below its own
  // box (negative margin) so the active foreground stripe visually
  // overlaps the parent baseline. Inactive tabs use a transparent
  // border so the parent's `border-border1` shows through unchanged.
  //
  // Scrollable + hidden scrollbar: the tab count may grow over time
  // (more agents could land later) and at the settings-panel widths
  // users see in practice the row overflows. Without `shrink-0
  // whitespace-nowrap` on each tab the buttons were getting squashed
  // and the two-word names ("Claude Code", "Cursor Agent") wrapped to
  // a second line. Same scrollbar-hide pattern as the chat dropdown
  // agent submenu.
  return (
    <div
      role="tablist"
      className="border-border1 flex flex-row items-center gap-0.5 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {providers.map((agent) => {
        const isActive = activeId === agent.id;
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(agent.id)}
            className={cn(
              "-mb-px inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-none border-x-0 border-t-0 border-b-2 bg-transparent px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out",
              isActive
                ? "border-fg1 text-fg1"
                : "text-fg2 hover:text-fg1 border-transparent",
            )}
          >
            {agent.name}
            {agent.beta && (
              <span className="border-border1 text-fg2 rounded-sm border px-1 py-px text-xs font-medium">
                Beta
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// One provider card
// ──────────────────────────────────────────────────────────

function ProviderCard({
  agent,
  surfaceActive,
  onRefresh,
}: {
  agent: BridgeRegistryAgent;
  /** False while Settings retains this provider form off-screen. */
  surfaceActive: boolean;
  /** Re-runs the engine probe sweep for all providers. Wired to the
   *  per-provider Refresh button in the connection block. */
  onRefresh: () => Promise<unknown>;
}) {
  // For the save-time key validation round-trip (AGENT_VALIDATE_KEY).
  const bridge = useBridge();
  const vendor = PROVIDER_VENDOR_CONFIG[agent.id];
  const supportsApiKey = API_KEY_PROVIDERS.has(agent.id);
  // Authentication capability is separate from executable customization.
  // Cursor uses the bundled SDK host; a custom CLI path has no effect.
  const executableInert = agent.id === "cursor";
  // Whether this agent shows a gateway base-URL override (Claude only today).
  const showGateway = agent.id === "claude" && !!vendor?.gatewayBaseUrlVar;
  // Does the "Provider config" block have at least one control? Cursor (bundled
  // SDK: no spawnable CLI, no gateway, no native config file) has none, so we
  // skip the wrapper entirely rather than render an empty padded container.
  const hasProviderConfig =
    !executableInert || showGateway || !!AGENT_CONFIG_FILE[agent.id];

  const [prefs, setPrefsState] = useState<ProviderPrefs>(() =>
    getProviderPrefs(agent.id),
  );

  const [connectionOpen, setConnectionOpen] = useState(false);
  const [method, setMethod] = useState<ConnectionMethod>(() =>
    connectionMethod(agent.id, getProviderPrefs(agent.id)),
  );
  const [changingMethod, setChangingMethod] = useState(false);
  const [cliOpen, setCliOpen] = useState(false);
  const methodInFlight = useRef(false);
  const connectionVisible = useRef(surfaceActive && connectionOpen);
  connectionVisible.current = surfaceActive && connectionOpen;
  useEffect(
    () => () => {
      connectionVisible.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!surfaceActive) {
      setConnectionOpen(false);
      setCliOpen(false);
    }
  }, [surfaceActive]);

  const [apiKey, setApiKey] = useState("");
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  // Whether a key is actually SAVED in the keychain (drives the "configured"
  // status). Tracked separately from `apiKey` because that holds the input's
  // live value, which diverges from the saved secret while editing.
  const [keyConfigured, setKeyConfigured] = useState(false);
  const native = useNativeRuntime().ready;
  const subscription = useCachedRead(
    subscriptionCache,
    agent.id,
    readSubscription,
    {
      enabled: native && surfaceActive && isSubscriptionProvider(agent.id),
      maxAgeMs: 15_000,
    },
  );
  useEffect(() => {
    if (!native || !surfaceActive || !isSubscriptionProvider(agent.id)) return;
    return subscribeProviderAuth(() => subscriptionCache.invalidate(agent.id));
  }, [agent.id, native, surfaceActive]);
  useEffect(() => {
    const confirmedMethod = subscription.data?.method;
    if (
      !surfaceActive ||
      !confirmedMethod ||
      methodInFlight.current ||
      changingMethod ||
      confirmedMethod === method
    )
      return;
    rememberConnectionMethod(agent.id, confirmedMethod);
    setMethod(confirmedMethod);
    setCliOpen(false);
    const current = getProviderPrefs(agent.id);
    const authMethod = confirmedMethod === "apiKey" ? "apiKey" : "cli";
    if (current.authMethod !== authMethod) {
      const next: ProviderPrefs = { ...current, authMethod };
      setProviderPrefs(agent.id, next);
      setPrefsState(next);
      void flushAgentPreferences().catch(() => {});
    }
  }, [
    agent.id,
    changingMethod,
    method,
    subscription.data?.method,
    surfaceActive,
  ]);
  const connected =
    !changingMethod &&
    (method === "apiKey"
      ? agent.authenticated === true && keyConfigured
      : subscription.data?.state === "connected" &&
        agent.authenticated === true);

  const [binaryPathDraft, setBinaryPathDraft] = useState(
    prefs.binaryPath ?? "",
  );
  const [gatewayDraft, setGatewayDraft] = useState(prefs.gatewayBaseUrl ?? "");
  useEffect(
    () =>
      subscribeProviderPreferences(() => {
        const next = getProviderPrefs(agent.id);
        setBinaryPathDraft((draft) =>
          draft === (prefs.binaryPath ?? "") ? (next.binaryPath ?? "") : draft,
        );
        setGatewayDraft((draft) =>
          draft === (prefs.gatewayBaseUrl ?? "")
            ? (next.gatewayBaseUrl ?? "")
            : draft,
        );
        setPrefsState(next);
        setMethod(connectionMethod(agent.id, next));
      }),
    [agent.id, prefs],
  );

  // Probe the keychain slot for PRESENCE only. The saved key is never
  // hydrated back into the input — that put the plaintext secret in the DOM
  // (readable via DevTools / a shoulder-surf of the password reveal) for no
  // benefit. The input is replace-only: blank until the user types a new key.
  useEffect(() => {
    if (!supportsApiKey || !vendor) {
      setApiKeyLoaded(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const v = await getSecret(vendor.secretAccount);
        if (!cancelled) setKeyConfigured(!!v?.trim());
      } catch {
        /* keychain miss — leave blank */
      } finally {
        if (!cancelled) setApiKeyLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supportsApiKey, vendor]);

  // ── persistence helpers ────────────────────────────────

  const writePrefs = useCallback(
    (patch: Partial<ProviderPrefs>) => {
      const next: ProviderPrefs = { ...getProviderPrefs(agent.id), ...patch };
      setProviderPrefs(agent.id, next);
      setPrefsState(next);
      return next;
    },
    [agent.id],
  );

  const handleAuthMethod = async (nextMethod: ConnectionMethod) => {
    if (methodInFlight.current || nextMethod === method) return;
    methodInFlight.current = true;
    setChangingMethod(true);
    setCliOpen(false);
    try {
      if (isSubscriptionProvider(agent.id)) await cancelSubscription(agent.id);
      if (isSubscriptionProvider(agent.id))
        await changeSubscriptionAccount({
          provider: agent.id,
          action: "select-method",
          method: nextMethod,
        });
      rememberConnectionMethod(agent.id, nextMethod);
      writePrefs({ authMethod: nextMethod === "apiKey" ? "apiKey" : "cli" });
      setMethod(nextMethod);
      await flushAgentPreferences();
      await onRefresh();
    } catch {
      toast.error("Could not change the connection method. Try again.");
    } finally {
      methodInFlight.current = false;
      setChangingMethod(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!vendor) return;
    const trimmed = apiKey.trim();
    if (!trimmed) return; // Save is disabled when blank; Remove deletes.
    setSavingApiKey(true);
    try {
      // Save-time validation: ask the engine to try ONE cheap authenticated
      // call with this key (Cursor → models.list). A definitive rejection
      // (401/403) blocks the save with the provider's own error, so the user
      // learns "bad key" HERE instead of as a failed prompt later. An
      // inconclusive result (no validator for this agent, engine unreachable,
      // network error) saves normally.
      if (bridge) {
        try {
          const resp = await bridge.request<AgentKeyValidatedMessage>(
            { type: "AGENT_VALIDATE_KEY", agentId: agent.id, apiKey: trimmed },
            15_000,
          );
          if (resp.type === "AGENT_KEY_VALIDATED" && resp.ok === false) {
            toast.error(`${vendor.vendor} rejected this API key`, {
              description:
                `The key was not saved. Create a fresh key and paste it again.` +
                (resp.error ? ` (${resp.error})` : ""),
            });
            return;
          }
        } catch {
          /* validation unavailable — save normally */
        }
      }
      await setSecret(vendor.secretAccount, trimmed);
      setKeyConfigured(true);
      setApiKey("");
      toast.success(`${vendor.vendor} API key saved to the keychain`);
      // Re-probe the registry so the agent flips to authenticated/runnable
      // immediately — without this the composer kept gating sends on the
      // STALE snapshot ("Sign in required") until the next window-focus
      // refresh.
      void onRefresh().catch(() => {});
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Keychain save failed");
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleRemoveApiKey = async () => {
    if (!vendor) return;
    setSavingApiKey(true);
    try {
      await deleteSecret(vendor.secretAccount);
      setKeyConfigured(false);
      setApiKey("");
      toast.success(`${vendor.vendor} API key removed from the keychain`);
      void onRefresh().catch(() => {});
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Keychain delete failed",
      );
    } finally {
      setSavingApiKey(false);
    }
  };

  const handleBinaryPathSave = () => {
    const trimmed = binaryPathDraft.trim();
    writePrefs({ binaryPath: trimmed || undefined });
    void flushAgentPreferences()
      .then(() => toast.success("Provider settings saved"))
      .catch(() => {});
  };

  const handleGatewaySave = () => {
    const trimmed = gatewayDraft.trim();
    writePrefs({ gatewayBaseUrl: trimmed || undefined });
    void flushAgentPreferences()
      .then(() => toast.success("Provider settings saved"))
      .catch(() => {});
  };

  const handleCopyInstall = async () => {
    if (!agent.installHint?.command) return;
    try {
      await navigator.clipboard.writeText(agent.installHint.command);
      toast.success("Install command copied");
    } catch {
      toast.error("Could not copy the install command");
    }
  };

  // Run = install + login in one external-Terminal session. We chain
  // them with `&&` so login only fires after a successful install,
  // and so the just-installed binary is already on PATH (the same
  // shell session keeps the npm-global / Homebrew prefix it was
  // initialised with). When the agent has no login command, we send
  // only the install line.
  //
  // Why external Terminal and not an inline spawn: install commands
  // can prompt for sudo and the login flows are interactive (OAuth
  // device codes, paste-token prompts, browser callbacks). The
  // user's real Terminal handles all of that natively; an embedded
  // PTY would have to replicate it.
  const buildLoginLine = (): string | null => {
    if (!agent.authBinary) return null;
    const args = agent.loginArgs ?? [];
    return args.length > 0
      ? `${agent.authBinary} ${args.join(" ")}`
      : agent.authBinary;
  };

  const handleRunInstall = async () => {
    const command = agent.installHint?.command;
    if (!command) return;
    try {
      const loginCommand = buildLoginLine();
      await nativeInvoke("open_install_terminal", {
        command,
        ...(loginCommand ? { loginCommand } : {}),
      });
      toast.info(
        loginCommand
          ? `Opened Terminal — install and sign in to ${agent.name} there.`
          : `Opened Terminal to install ${agent.name}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not open Terminal",
      );
    }
  };

  // ── derived UI state ───────────────────────────────────

  const warmConnection = () => {
    if (
      !surfaceActive ||
      method !== "account" ||
      !isSubscriptionProvider(agent.id)
    )
      return;
    void subscriptionCache
      .load(agent.id, () => readSubscription(agent.id), { maxAgeMs: 15_000 })
      .catch(() => {});
  };

  return (
    <section className="flex flex-col gap-8">
      {/* No logo/name/Connected header — the provider tab above already
          shows the name + icon, and the live "Connected" state now lives on
          the connection block below (CLI mode). */}

      {/* Install row — only when the CLI isn't on PATH. Run opens
          the user's Terminal.app and chains the install + login in
          a single session so the user only context-switches once
          (the alternative — installing inline and then prompting
          for login — was worse because login flows are interactive
          and need a real TTY anyway). When the agent has no login
          command we send only the install line. */}
      {!agent.installed && agent.installHint && (
        <SettingsSection
          title={
            <span className="flex items-center gap-3">
              Install command
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleRunInstall()}
                className="gap-1.5"
              >
                <Play className="size-3.5" aria-hidden="true" />
                Run
              </Button>
            </span>
          }
          action={
            agent.installHint.docsUrl && (
              <a
                href={agent.installHint.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-fg2 hover:text-fg1 inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
              >
                Install docs <ExternalLink className="size-3.5" />
              </a>
            )
          }
        >
          <div className="bg-bg2/60 relative rounded-md px-4 py-3">
            <span className="text-fg1 block pr-9 text-xs break-all">
              {agent.installHint.command}
            </span>
            <Tooltip label="Copy install command">
              <button
                type="button"
                onClick={() => void handleCopyInstall()}
                aria-label="Copy install command"
                className="text-fg2 hover:bg-bg2-hover hover:text-fg1 absolute top-2 right-2 inline-flex size-7 cursor-pointer items-center justify-center rounded-sm transition-colors"
              >
                <Copy className="size-3.5" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        </SettingsSection>
      )}

      {/* All current providers offer account sign-in and pasted API keys. */}
      {supportsApiKey && vendor && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-fg1 flex items-center gap-3 text-sm font-medium">
              <AgentIcon
                agentId={agent.id}
                iconUrl={undefined}
                className="size-5"
              />
              {agent.name}
            </div>
            <Button
              variant="secondary"
              size="lg"
              onPointerEnter={warmConnection}
              onFocus={warmConnection}
              onClick={() => setConnectionOpen(true)}
            >
              {connectionLabel(
                connected,
                prefs,
                agent.id === "claude" ? "Claude" : agent.name,
              )}
              {connected && (
                <Check className="text-green-fg size-4" aria-hidden="true" />
              )}
            </Button>
          </div>
          {isSubscriptionProvider(agent.id) && (
            <ProviderInformation provider={agent.id} connected={connected} method={method} status={subscription.data} surfaceActive={surfaceActive} />
          )}
          <ProviderConnectionDialog
            provider={agent.id}
            name={agent.name}
            open={connectionOpen && surfaceActive}
            onOpenChange={(open) => {
              setConnectionOpen(open);
              if (!open) setCliOpen(false);
            }}
            method={method}
            onMethodChange={(next) => void handleAuthMethod(next)}
            connected={connected}
            busy={changingMethod || savingApiKey}
          >
            {method === "apiKey" ? (
              <div className="flex flex-col gap-2 py-3.5">
                {/* Header: the key label + a "Key" button (opens the vendor
                  console) sit together on one row; the configured/not status
                  sits below with a gap, so the button fits alongside the
                  title. No keychain hint text — the status carries it. */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center gap-2.5">
                    <label
                      htmlFor={`api-key-${agent.id}`}
                      className="text-fg1 text-[14px] font-medium"
                    >
                      {vendor.vendor} API key
                    </label>
                    <Button
                      asChild
                      variant="secondary"
                      size="sm"
                      className="shrink-0 gap-1.5"
                    >
                      <a
                        href={vendor.consoleUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Key
                        <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      </a>
                    </Button>
                  </div>
                  <span className="text-fg2 text-xs">
                    {keyConfigured
                      ? `${vendor.vendor} API key configured`
                      : `No ${vendor.vendor} API key configured`}
                  </span>
                </div>
                <div className="flex flex-row gap-2">
                  <Input
                    id={`api-key-${agent.id}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      !apiKeyLoaded
                        ? "Paste API key"
                        : keyConfigured
                          ? "•••• stored — paste a new key to replace"
                          : "sk-..."
                    }
                    value={apiKey}
                    disabled={!apiKeyLoaded}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="flex-1"
                  />
                  <Button
                    size="lg"
                    onClick={() => void handleSaveApiKey()}
                    disabled={savingApiKey || !apiKeyLoaded || !apiKey.trim()}
                  >
                    {savingApiKey ? "Saving…" : "Save"}
                  </Button>
                  {keyConfigured && (
                    <Button
                      variant="secondary"
                      size="lg"
                      onClick={() => void handleRemoveApiKey()}
                      disabled={savingApiKey || !apiKeyLoaded}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            ) : method === "cli" ? (
              <>
                {cliOpen ? (
                  <InlineLoginTerminal
                    timeoutMs={5 * 60_000}
                    loginProvider={agent.id === "claude" ? "claude" : "codex"}
                    ownerId={agent.id}
                    binary={agent.authBinary ?? agent.id}
                    args={
                      agent.id === "claude"
                        ? ["auth", "login", "--claudeai"]
                        : ["login"]
                    }
                    unsetEnv={[
                      "ANTHROPIC_API_KEY",
                      "ANTHROPIC_AUTH_TOKEN",
                      "CLAUDE_CODE_OAUTH_TOKEN",
                      "OPENAI_API_KEY",
                      "CODEX_API_KEY",
                    ]}
                    onClose={() => {
                      setCliOpen(false);
                      subscription.refresh();
                      void onRefresh().catch(() => {});
                    }}
                  />
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={changingMethod}
                      onClick={() => setCliOpen(true)}
                    >
                      Open terminal
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Refresh ${agent.id === "claude" ? "Claude" : agent.name} subscription`}
                      disabled={subscription.refreshing}
                      onClick={() => {
                        subscription.refresh();
                        void onRefresh().catch(() => {});
                      }}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </>
            ) : isSubscriptionProvider(agent.id) ? (
              <SubscriptionConnectionPanel
                provider={agent.id}
                onChanged={onRefresh}
                surfaceActive={
                  surfaceActive && connectionOpen && !changingMethod
                }
              />
            ) : null}
          </ProviderConnectionDialog>
        </section>
      )}

      {/* Provider config — every option is shown inline for every agent
          (no "Advanced" disclosure). Skipped entirely when the agent exposes
          none (e.g. Cursor) so there's no empty padded container. */}
      {hasProviderConfig && (
        <div className="flex flex-col gap-4 pt-2">
          {/* Bundled-SDK agents (Cursor) have no spawnable CLI, so they show no
            Executable path field at all. */}
          {!executableInert && (
            <SettingsField
              label="Executable path"
              htmlFor={`executable-path-${agent.id}`}
              hint={<ExecutablePathHint agentId={agent.id} name={agent.name} />}
            >
              <div className="flex flex-row gap-2">
                <Input
                  id={`executable-path-${agent.id}`}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="Use the bundled binary"
                  value={binaryPathDraft}
                  onChange={(e) => setBinaryPathDraft(e.target.value)}
                  className="flex-1 text-sm"
                />
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={handleBinaryPathSave}
                  disabled={binaryPathDraft.trim() === (prefs.binaryPath ?? "")}
                >
                  Save
                </Button>
              </div>
            </SettingsField>
          )}

          {showGateway && (
            <SettingsField
              label="Anthropic gateway base URL"
              htmlFor={`gateway-${agent.id}`}
              hint={
                <>
                  Point Claude at a compatible proxy (LiteLLM, corporate
                  gateway). Injected as{" "}
                  <span className="bg-bg2-hover text-fg1 rounded-sm px-1.5 py-0.5 text-xs">
                    {vendor.gatewayBaseUrlVar}
                  </span>
                  .
                </>
              }
            >
              <div className="flex flex-row gap-2">
                <Input
                  id={`gateway-${agent.id}`}
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://api.anthropic.com"
                  value={gatewayDraft}
                  onChange={(e) => setGatewayDraft(e.target.value)}
                  className="flex-1 text-sm"
                />
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={handleGatewaySave}
                  disabled={
                    gatewayDraft.trim() === (prefs.gatewayBaseUrl ?? "")
                  }
                >
                  Save
                </Button>
              </div>
            </SettingsField>
          )}

          {/* Each agent reads its own config natively (Claude: tool permissions /
            hooks / env; Codex: model / sandbox / MCP) — we link out to that
            file instead of duplicating those knobs here. */}
          {AGENT_CONFIG_FILE[agent.id] && (
            <AgentConfigCard agentId={agent.id} />
          )}
        </div>
      )}
    </section>
  );
}

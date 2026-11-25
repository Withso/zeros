import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import { isFeatureEnabled } from "../../config/release-channel";
import {
  ArrowUpRight,
  ChevronDown,
  ExternalLink,
  Check,
  Play,
  Copy,
  RefreshCw,
} from "lucide-react";
import { Button, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { badgeVariants } from "@/renderer/shared/ui/primitives/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/renderer/shared/ui/primitives/tabs";
import { SELECT_CHEVRON, selectTriggerClassName } from "../../shared/ui/primitives/select";
import { OpenAppIcon } from "../agent/open-app-icon";
import {
  FINDER_APP_ID,
  findOpenApp,
  getDetectedOpenApps,
  refreshDetectedOpenApps,
  useDetectedOpenApps,
} from "../../platform/open-apps";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import { openAgentConfig } from "../../platform/app";
import { flushAgentPreferences } from "../../platform/agent-preferences";
import { subscribeProviderAuth } from "../../platform/provider-auth-state";
import { AgentIcon } from "../agent/agent-icon";
import { InlineLoginTerminal } from "./inline-login-terminal";
import { ProviderConnectionDialog } from "./provider-connection-dialog";
import { CloudAgentConnection, CloudProviderConnections } from "./cloud-provider-connections";
import { getActiveOrganizationIdSnapshot, useActiveOrganization, useTeams } from "../team/team-store";
import { usableCloudOrganization } from "../team/personal-cloud";
import {
  connectionLabel,
  connectionMethod,
  rememberConnectionMethod,
  type ConnectionMethod,
} from "./connection-methods";
import { activeSettingsOwner, subscribeProviderSettingsTab } from "./settings-navigation";
import { PlaceLabel, SettingsSection, SettingsField } from "./settings-ui";
import { readScopedSettingsSelection, writeScopedSettingsSelection } from "./settings-scope";
import { TerminalAgentsSection } from "./terminal-agents-section";
import { useExperimentalFeature } from "./experimental-features";
import { ProviderInformation } from "./provider-information";
import { SubscriptionConnectionPanel } from "./subscription-connection-panel";
import {
  cancelSubscription,
  changeSubscriptionAccount,
  isSubscriptionProvider,
} from "./subscription-connection";
import { useSubscriptionStatus, warmSubscriptionStatus } from "./use-subscription-status";
import { nativeInvoke, useNativeRuntime } from "../../platform/runtime";
import { getSetting, setSetting } from "../../platform/settings";
import {
  documentIsVisible,
  useDocumentActive,
} from "../../state/use-document-active";
import {
  deleteSecret,
  hasSecret,
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

interface ProviderVendorConfig {
  vendor: string;
  envVar: string;
  secretAccount: string;
  consoleUrl: string;
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
  cursor: {
    vendor: "Cursor",
    envVar: "CURSOR_API_KEY",
    secretAccount: SECRET_ACCOUNTS.CURSOR_API_KEY,
    consoleUrl: "https://cursor.com/dashboard/api",
  },
};

const API_KEY_PROVIDERS = new Set(Object.keys(PROVIDER_VENDOR_CONFIG));

const PROVIDER_ORDER = ["claude", "codex", "cursor"] as const;

// Match bundled executable selection in claude-sdk/adapter.ts and codex/binary-resolver.ts.
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
        Blank uses the bundled Codex.
      </>
    );
  }
  return <>Blank uses the bundled {name}.</>;
}

// Keep these paths aligned with Electron's AGENT_CONFIG_FILES.
const AGENT_CONFIG_FILE: Record<string, { title: string; path: string }> = {
  claude: { title: "Claude settings", path: "~/.claude/settings.json" },
  codex: { title: "Codex config", path: "~/.codex/config.toml" },
};

function AgentConfigCard({ agentId }: { agentId: string }) {
  const cfg = AGENT_CONFIG_FILE[agentId];
  const finderApp = findOpenApp(useDetectedOpenApps(), FINDER_APP_ID)!;
  // Preload Finder detection if Settings opens before any workspace has warmed it.
  useEffect(() => {
    if (getDetectedOpenApps() === null) void refreshDetectedOpenApps();
  }, []);
  if (!cfg) return null;
  return (
    <div className="border-border1 flex flex-row items-center justify-between gap-3 rounded-lg border px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <div className="text-fg1 text-xs leading-4.5 font-medium">{cfg.title}</div>
        <code className="text-fg2 text-xs">{cfg.path}</code>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={selectTriggerClassName("fit", "text-fg1")}
        >
          Open in
          <ChevronDown className={SELECT_CHEVRON} aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="min-w-[160px]"
        >
          <DropdownMenuItem onSelect={() => void openAgentConfig(agentId)}>
            <OpenAppIcon app={finderApp} />
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

const PROVIDERS_ACTIVE_TAB_KEY = "providers:active-tab";

function loadInitialProviderTab(): string {
  const saved = getSetting<string>(PROVIDERS_ACTIVE_TAB_KEY, "claude");
  return (PROVIDER_ORDER as readonly string[]).includes(saved)
    ? saved
    : "claude";
}

export function ProvidersPanel({
  surfaceActive = true,
  unified = false,
}: {
  surfaceActive?: boolean;
  unified?: boolean;
}) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  if (unified) return <AgentsPanel surfaceActive={surfaceActive} />;
  if (!isFeatureEnabled("cloud-workspaces")) return <LocalProvidersPanel surfaceActive={surfaceActive} />;
  if (!organization && getActiveOrganizationIdSnapshot())
    return <p className="text-fg2 text-xs">Loading organization agent settings…</p>;
  return organization && !organization.isPersonal
    ? <CloudProviderConnections key={`${me?.user.id ?? "pending"}:${organization.id}`} organizationId={organization.id} surfaceActive={surfaceActive} />
    : <LocalProvidersPanel surfaceActive={surfaceActive} />;
}

const CLOUD_AGENT_NAMES: Record<(typeof PROVIDER_ORDER)[number], string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** One tab per agent with its This Mac part and, in a cloud organization, its Cloud part; Terminal Agents follows. */
function AgentsPanel({ surfaceActive }: { surfaceActive: boolean }) {
  const organization = useActiveOrganization();
  const { me } = useTeams();
  const [terminalAgents] = useExperimentalFeature("terminalAgents");
  const [owner] = useState(activeSettingsOwner);
  // The organization's cloud logins, or Personal's own cloud's with Pro.
  const cloudOrganization = usableCloudOrganization(organization);
  const cloudOrganizationId =
    isFeatureEnabled("cloud-workspaces") && cloudOrganization && me
      ? cloudOrganization.id
      : null;
  return (
    <LocalProvidersPanel
      surfaceActive={surfaceActive}
      owner={owner}
      cloud={
        cloudOrganizationId && me
          ? (agentId) => (
              <CloudAgentConnection
                key={`${me.user.id}:${cloudOrganizationId}:${agentId}`}
                organizationId={cloudOrganizationId}
                userId={me.user.id}
                agentId={agentId}
                surfaceActive={surfaceActive}
                title={<PlaceLabel place="cloud" />}
              />
            )
          : undefined
      }
      after={terminalAgents ? <SettingsSection title="Terminal Agents"><TerminalAgentsSection /></SettingsSection> : null}
    />
  );
}

function LocalProvidersPanel({
  surfaceActive,
  owner,
  cloud,
  after,
}: {
  surfaceActive: boolean;
  /** Unified page: the Settings owner whose saved agent tab this is. */
  owner?: string;
  /** Unified page: the agent's cloud part, shown after its This Mac part. */
  cloud?: (agentId: string) => React.ReactNode;
  after?: React.ReactNode;
}) {
  const bridge = useBridge();
  const agents = useAgentsSnapshot();
  const visible = useDocumentActive(surfaceActive);
  const [activeId, setActiveIdState] = useState<string>(() =>
    owner ? readScopedSettingsSelection(owner, "provider", "claude") : loadInitialProviderTab(),
  );
  const setActiveId = (next: string) => {
    setActiveIdState(next);
    if (owner) writeScopedSettingsSelection(owner, "provider", next);
    else setSetting(PROVIDERS_ACTIVE_TAB_KEY, next);
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

  // Follow bridge changes without restarting the focus debounce.
  const listAgentsRef = useRef(listAgents);
  useEffect(() => {
    listAgentsRef.current = listAgents;
  }, [listAgents]);

  // A sibling app may change shared credentials while this panel is hidden.
  useEffect(() => {
    if (!visible) return;
    void refreshAgents(listAgentsRef.current).catch(() => {
      /* surfaced by the cache via toast */
    });
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    return subscribeProviderAuth(() => {
      if (!documentIsVisible()) return;
      void refreshAgents(listAgentsRef.current).catch(() => {});
    });
  }, [visible]);

  // Refresh on focus to catch sign-ins completed in an external terminal.
  useEffect(() => {
    if (!visible) return;
    let t: number | null = null;
    const onFocus = () => {
      if (!documentIsVisible()) return;
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        if (!documentIsVisible()) return;
        invalidateAgentsCache();
        void loadAgents(listAgentsRef.current).catch(() => {});
      }, 300);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      if (t !== null) window.clearTimeout(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [visible]);

  // A mount-time list can fail before the bridge connects; retry when it becomes reachable.
  const bridgeStatus = useBridgeStatus();
  const lastBridgeStatusRef = useRef(bridgeStatus);
  useEffect(() => {
    const prev = lastBridgeStatusRef.current;
    lastBridgeStatusRef.current = bridgeStatus;
    if (!visible) return;
    if (prev !== "connected" && bridgeStatus === "connected") {
      invalidateAgentsCache();
      void loadAgents(listAgentsRef.current).catch(() => {});
    }
  }, [bridgeStatus, visible]);

  // A respawn can connect before listing works; ENGINE_READY retries without invalidating fresh data.
  useEffect(() => {
    if (!visible || !bridge) return;
    return bridge.on("ENGINE_READY", () => {
      if (!documentIsVisible()) return;
      void loadAgents(listAgentsRef.current).catch(() => {});
    });
  }, [bridge, visible]);

  const ordered = useMemo(() => {
    if (!agents) return [];
    return PROVIDER_ORDER.map((id) => agents.find((a) => a.id === id)).filter(
      (a): a is BridgeRegistryAgent => !!a,
    );
  }, [agents]);

  useEffect(() => subscribeProviderSettingsTab(setActiveIdState, owner), [owner]);

  const active = ordered.find((a) => a.id === activeId) ?? ordered[0];
  // A cloud organization lists every agent so its cloud part shows before this Mac's registry loads.
  const tabs: Pick<BridgeRegistryAgent, "id" | "name" | "beta">[] = cloud
    ? PROVIDER_ORDER.map((id) => ordered.find((a) => a.id === id) ?? { id, name: CLOUD_AGENT_NAMES[id] })
    : ordered;
  const activeTab = tabs.find((a) => a.id === activeId) ?? tabs[0];
  const activeAgent = activeTab ? ordered.find((a) => a.id === activeTab.id) : undefined;

  const handleRefresh = useCallback(
    () => refreshAgents(listAgents),
    [listAgents],
  );

  if (owner) {
    return (
      <div className="flex flex-col gap-8">
        {tabs.length === 0 ? (
          <div className="min-h-24" aria-busy="true" />
        ) : (
          <Tabs
            value={activeTab?.id ?? tabs[0].id}
            onValueChange={setActiveId}
            className="flex flex-col gap-8"
          >
            <ProviderTabs providers={tabs} />
            {activeTab && (
              <TabsContent value={activeTab.id} className="mt-0 flex flex-col gap-8">
                <SettingsSection title={<PlaceLabel place="mac" />}>
                  {activeAgent ? (
                    <ProviderCard
                      key={activeAgent.id}
                      agent={activeAgent}
                      surfaceActive={surfaceActive}
                      onRefresh={handleRefresh}
                    />
                  ) : (
                    <div className="min-h-24" aria-busy="true" />
                  )}
                </SettingsSection>
                {cloud?.(activeTab.id)}
              </TabsContent>
            )}
          </Tabs>
        )}
        {after}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {ordered.length === 0 ? (
        <div className="min-h-24" aria-busy="true" />
      ) : (
        <Tabs
          value={active?.id ?? ordered[0].id}
          onValueChange={setActiveId}
          className="flex flex-col gap-8"
        >
          <ProviderTabs providers={ordered} />
          {active && (
            <TabsContent value={active.id} className="mt-0">
              <ProviderCard
                key={active.id}
                agent={active}
                surfaceActive={surfaceActive}
                onRefresh={handleRefresh}
              />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  );
}

function ProviderTabs({
  providers,
}: {
  providers: Pick<BridgeRegistryAgent, "id" | "name" | "beta">[];
}) {
  return (
    <TabsList aria-label="Agents" className="max-w-full self-start overflow-x-auto [scrollbar-width:none]">
      {providers.map((agent) => (
        <TabsTrigger key={agent.id} value={agent.id} className="shrink-0">
          {agent.name}
          {agent.beta && (
            <span className={badgeVariants({ variant: "outline" })}>Beta</span>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function ProviderCard({
  agent,
  surfaceActive,
  onRefresh,
}: {
  agent: BridgeRegistryAgent;
  surfaceActive: boolean;
  onRefresh: () => Promise<unknown>;
}) {
  const bridge = useBridge();
  const vendor = PROVIDER_VENDOR_CONFIG[agent.id];
  const supportsApiKey = API_KEY_PROVIDERS.has(agent.id);
  // Cursor runs in the bundled SDK, so a custom CLI path has no effect.
  const executableInert = agent.id === "cursor";
  const showGateway = agent.id === "claude" && !!vendor?.gatewayBaseUrlVar;
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
  // Saved presence owns the Remove action; the engine also knows about keys
  // inherited from its environment. Unknown storage is not a confirmed miss.
  const [keyConfigured, setKeyConfigured] = useState<boolean>();
  const native = useNativeRuntime().ready;
  const keySurfaceActive = useDocumentActive(surfaceActive);
  const keyAvailable =
    agent.apiKeySource === undefined
      ? keyConfigured === true
      : agent.apiKeySource !== "none";
  const apiKeyStatus =
    agent.apiKeySource === "environment"
      ? `${vendor?.vendor} API key provided by ${vendor?.envVar}`
      : keyConfigured === true || agent.apiKeySource === "saved"
        ? `${vendor?.vendor} API key configured`
        : keyConfigured === false
          ? `No ${vendor?.vendor} API key configured`
          : apiKeyLoaded
            ? `Could not check the saved ${vendor?.vendor} API key`
            : `Checking ${vendor?.vendor} API key…`;
  const subscription = useSubscriptionStatus(agent.id, surfaceActive);
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
      ? agent.authenticated === true && keyAvailable
      : (!subscription.data?.method || subscription.data.method === method) &&
        subscription.data?.state === "connected" &&
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

  // Check presence only; never put a previously saved API key back in the DOM.
  useEffect(() => {
    if (!keySurfaceActive) return;
    if (!supportsApiKey || !vendor) {
      setApiKeyLoaded(true);
      return;
    }
    let cancelled = false;
    let revision = 0;
    const refresh = async () => {
      if (cancelled || !documentIsVisible()) return;
      const requested = ++revision;
      try {
        const configured = await hasSecret(vendor.secretAccount);
        if (!cancelled && requested === revision) setKeyConfigured(configured);
      } catch {
        /* Retain the last confirmed presence while native storage is unavailable. */
      } finally {
        if (!cancelled && requested === revision) setApiKeyLoaded(true);
      }
    };
    void refresh();
    const revalidate = () => void refresh();
    const unsubscribe = subscribeProviderAuth(revalidate);
    window.addEventListener("focus", revalidate);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", revalidate);
    };
  }, [native, supportsApiKey, vendor, keySurfaceActive]);

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
    if (!trimmed) return;
    setSavingApiKey(true);
    try {
      // Reject known invalid keys; keychain saves still work if validation is unavailable.
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
      // Refresh now so the composer doesn't gate sends on the pre-save auth state.
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

  const buildLoginLine = (): string | null => {
    if (!agent.authBinary) return null;
    const args = agent.loginArgs ?? [];
    return args.length > 0
      ? `${agent.authBinary} ${args.join(" ")}`
      : agent.authBinary;
  };

  // Use external Terminal for interactive installs and start login only after install succeeds.
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

  const warmConnection = () => {
    if (
      !surfaceActive ||
      !isSubscriptionProvider(agent.id)
    )
      return;
    warmSubscriptionStatus(agent.id);
  };

  return (
    <section className="flex flex-col gap-8">
      {!agent.installed && agent.installHint && (
        <SettingsSection
          title={
            <span className="flex items-center gap-3">
              Install command
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleRunInstall()}
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
            <span className="text-fg1 block pr-10 text-xs break-all">
              {agent.installHint.command}
            </span>
            <Tooltip label="Copy command">
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
                method,
              )}
              {connected && (
                <Check className="text-green-on-bg size-4" aria-hidden="true" />
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
            connectedIdentity={method !== "apiKey" ? subscription.data?.email : undefined}
            busy={changingMethod || savingApiKey}
          >
            {method === "apiKey" ? (
              <div className="flex flex-col gap-2 py-3.5">
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-row items-center gap-2.5">
                    <label
                      htmlFor={`api-key-${agent.id}`}
                      className="text-fg1 text-xs leading-4.5 font-medium"
                    >
                      {vendor.vendor} API key
                    </label>
                    <Button
                      asChild
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
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
                    {apiKeyStatus}
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
                          : keyAvailable
                            ? "Paste a new key to replace"
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
                    <IconButton
                      size="standard"
                      label={`Refresh ${agent.id === "claude" ? "Claude" : agent.name} subscription`}
                      disabled={subscription.refreshing}
                      onClick={() => {
                        subscription.refresh();
                        void onRefresh().catch(() => {});
                      }}
                    >
                      <RefreshCw className="size-3.5" aria-hidden="true" />
                    </IconButton>
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

      {hasProviderConfig && (
        <div className="flex flex-col gap-4 pt-2">
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
                  Sets{" "}
                  <code className="bg-bg2 text-fg1 rounded-sm px-1.5 py-px font-mono text-3xxs leading-4">
                    {vendor.gatewayBaseUrlVar}
                  </code>
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

          {AGENT_CONFIG_FILE[agent.id] && (
            <AgentConfigCard agentId={agent.id} />
          )}
        </div>
      )}
    </section>
  );
}

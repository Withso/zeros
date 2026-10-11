// Standalone development harness — NOT part of the shipped app.
//
// An isolated repro page for the composer ModelPill dropdown, served by
// `pnpm dev` at
// /apps/desktop/src/renderer/harnesses/harness-model-menu.html. It has its own
// entry point and is never imported by the renderer bundle; it exists so the
// pill's popover can be exercised without booting the whole shell.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import type { AuthContextValue } from "../features/auth/auth-context";
import type { SessionsActions } from "../features/agent/sessions-context";
import type { WorkspaceRegistryAgent } from "../features/agent/workspace-agent-registry";
import type { ComponentType } from "react";

// Seed the module-level caches BEFORE importing the components that read
// them at module load.
const agents = [
  {
    id: "claude",
    name: "Claude Code",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
  {
    id: "codex",
    name: "Codex",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    version: "1.0.0",
    description: "",
    distribution: {},
    installed: true,
    authenticated: true,
  },
];
const query = new URLSearchParams(location.search);
const policyCase = query.get("defaults");
const policyConnections = query.get("connections") ?? ({
  claude: "claude,codex,cursor", codex: "codex", cursor: "cursor",
  saved: "codex", remembered: "claude,codex,cursor",
} as Record<string, string>)[policyCase ?? ""];
const disconnected = query.get("disconnected")?.split(",") ?? [];
const runtimeUpgradeRequired = query.has("runtimeUpgrade");
const cloudRuntime = query.get("cloudRuntime");
const cloudFolder = cloudRuntime || (policyCase && query.get("placement") === "cloud")
  ? "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" : undefined;
const cloudModels = query.has("cloudModels") || runtimeUpgradeRequired || cloudRuntime
  ? agents.map(agent => ({ ...agent, authenticated: !runtimeUpgradeRequired, runtimeUpgradeRequired,
    ...(cloudRuntime ? { installedVersion: cloudRuntime } : {}),
    cloudModels: agent.id === "claude" && !runtimeUpgradeRequired
      ? cloudRuntime ? ["claude-sonnet-5[1m]", "claude-haiku-5-5"] : ["claude-sonnet-5[1m]"] : [] }))
  : undefined;
for (const agent of agents) {
  if (disconnected.includes(agent.id)) agent.authenticated = false;
  if (policyConnections !== undefined) agent.authenticated = policyConnections.split(",").includes(agent.id);
}
localStorage.setItem(
  "zeros.agent.registrySnapshot",
  // A cloud actor's grants deliberately differ from this device's connections.
  JSON.stringify({ agents: policyCase && cloudFolder ? agents.map(agent => ({ ...agent, authenticated: true })) : agents, at: Date.now() }),
);
if (query.has("theme")) document.documentElement.setAttribute("data-theme", query.get("theme")!);

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { ModelPill, PermissionToggle, ComposerConcealedContext } =
    await import("../features/agent/composer-pills");
  const { ComposerAttachmentMenu } =
    await import("../features/agent/composer-attachment-menu");
  const { PromptInputSubmit } =
    await import("../shared/ui/primitives/elements/prompt-input");
  const { resolveModelConfiguration } =
    await import("../features/agent/model-preferences");
  let registryOverride: WorkspaceRegistryAgent[] | undefined = cloudModels;
  const { newChatBornDefaults, hydrateModelsFromSettings } = await import("../features/agent/new-chat-defaults");
  const { getFavoriteSelection, setFavoriteModel } = await import("../features/agent/model-favorites");
  if (policyCase) {
    hydrateModelsFromSettings({ default: null, default_agent: null, model_preferences: [], permission_preferences: [] }, true);
    if (policyCase === "saved") setFavoriteModel("claude", "claude-sonnet-5-5[1m]");
    if (policyCase === "remembered") {
      const { setModelPreference } = await import("../features/agent/model-preferences");
      setModelPreference("claude", "claude-opus-5-5[1m]", { effort: "high" });
    }
  }
  if (cloudFolder || (policyCase && query.get("owner") === "organization")) {
    const { acceptOrganizationSnapshot } = await import("../features/team/team-store");
    const { cloudWorkspaceDetails } = await import("../state/cloud-workspace-catalog");
    const organization = { id: "11111111-1111-4111-8111-111111111111", name: "Fixture organization", slug: "fixture", logo: null,
      isPersonal: false, role: "member" as const, defaultTeamId: "11111111-1111-4111-8111-111111111111",
      workspaceCapabilities: { local: true, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
    acceptOrganizationSnapshot({ user: { id: "44444444-4444-4444-8444-444444444444", email: "fixture@example.test", displayName: "Fixture", staffRole: null },
      organizations: [organization], teams: [organization] });
    // The required-model note is available to a prompter without management
    // reads or waking this sleeping workspace.
    if (cloudFolder) cloudWorkspaceDetails.setData(cloudFolder, { capabilities: { canManage: false }, generation: { number: 1 } } as never);
  }
  const { AuthContext } = await import("../features/auth/auth-context");
  const { ActionsCtx } = await import("../features/agent/sessions-context");
  const auth: AuthContextValue = { status: "unauthenticated", session: null, userId: null, email: null, oauthError: null,
    startBrowserSignIn: async () => ({ ok: false }), clearOAuthError() {}, cancelPendingOAuth() {}, signOut: async () => {}, signOutEverywhere: async () => {} };
  const sessions = { listAgents: async () => agents, updateConfig: () => {} } as unknown as SessionsActions;
  if (policyCase) {
    const { setActiveBridge } = await import("../platform/bridge/active-bridge");
    Object.assign(window, { __ZEROS_NATIVE__: {
      invoke: async (command: string) => command === "auth_get_access_token" ? { access_token: "fixture-only" }
        : command === "auth_get_session_user" ? { sub: "fixture", email: "fixture@example.test", name: "Fixture", provider: "workos" } : null,
      on: () => () => {},
    } });
    setActiveBridge({ status: "connected", onStatusChange: () => () => {}, onMessage: () => () => {}, on: () => () => {},
      request: async ({ type, op }: { type?: string; op?: string }) => {
        if (type === "AGENT_LIST_AGENTS") return { type: "AGENT_AGENTS_LIST", agents: agents.map(agent => ({ ...agent, authenticated: true })) };
        if (op === "project.list") return { result: { projects: [] } };
        if (op === "settings.read") return { result: { doc: {}, exists: true, path: "/fixture/settings.toml" } };
        return { result: { effective: {}, sources: {}, layers: [] } };
      },
    } as unknown as RuntimeClient);
    const { controlPlane, CONTROL_PLANE_URL } = await import("../features/team/control-plane");
    controlPlane.me = async () => { throw new Error("Offline fixture membership refresh"); };
    if (cloudFolder || query.get("owner") === "organization") {
      const { setActiveOrganizationSelection } = await import("../features/team/active-team");
      setActiveOrganizationSelection("11111111-1111-4111-8111-111111111111", false);
    }
    if (cloudFolder) {
      const { modelsForAgent } = await import("../features/agent/model-catalog");
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (CONTROL_PLANE_URL && url.startsWith(CONTROL_PLANE_URL) && url.endsWith("/agent-credentials/prepare")) {
          return Response.json({ delegations: agents.filter(agent => agent.authenticated).map((agent, index) => ({
            id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, "0")}`, ownerUserId: "66666666-6666-4666-8666-666666666666", kind: `${agent.id}-api-key`,
            models: modelsForAgent(agent.id, null).map(model => model.value), expiresAt: "2099-01-01T00:00:00Z", runtimeQualified: true,
          })) });
        }
        return originalFetch(input, init);
      };
      const { warmCloudAgentRegistry } = await import("../features/agent/workspace-agent-registry");
      registryOverride = await warmCloudAgentRegistry(cloudFolder);
    } else {
      const { loadAgents } = await import("../features/agent/agents-cache");
      await loadAgents(async () => agents);
    }
  }
  const liveEfforts = query.get("haikuEfforts");
  const initialize = liveEfforts === null ? null : { protocolVersion: 1, _meta: { models: [{
    value: "claude-haiku-5-5", label: "Haiku", effortLevels: liveEfforts === "none" ? [] : liveEfforts.split(","), supportsFast: false,
  }] } };
  const { pickAgentForNewChat } = await import("../features/settings/default-agent");
  const initialAgent = (policyCase ? pickAgentForNewChat(registryOverride ?? agents) : agents[0]) as WorkspaceRegistryAgent | null;
  const initialAgentId = initialAgent?.id ?? "claude";
  const born = newChatBornDefaults(initialAgentId, initialAgent?.cloudModels);
  const initialModel = query.has("haiku") ? "claude-haiku-5-5" : born.model;
  let SettingsPage: ComponentType | null = null;
  if (policyCase) {
    const { useWorkspaceStore } = await import("../state/workspace-store");
    useWorkspaceStore.setState({ activePage: query.has("settings") ? "settings" : "workspace", lastWorkspaceFolder: cloudFolder ?? "/fixture/workspace",
      newAgentFolder: cloudFolder ?? "/fixture/workspace", activeChatId: null, chats: [] });
    Object.assign(window, { defaultPolicyFixture: { agentId: initialAgentId, born, selection: getFavoriteSelection,
      authenticated: () => (registryOverride ?? agents).map(agent => ({ id: agent.id, authenticated: agent.authenticated })) } });
    if (query.has("settings")) {
      // Models is the existing Local user-preference panel. Keep the active
      // workspace (including its cloud grants) while opening that panel.
      const { setActiveOrganizationSelection } = await import("../features/team/active-team");
      setActiveOrganizationSelection(null, false);
      const { requestUserSettingsSection } = await import("../features/settings/settings-navigation");
      requestUserSettingsSection("models");
      SettingsPage = (await import("../features/settings/settings-page")).SettingsPage;
    }
  }
  const {
    composerOwnsFocus,
    shouldReclaimComposerFocus,
    OPEN_OVERLAY_SELECTOR,
  } = await import("../features/agent/composer-focus");

  function Harness() {
    const [agentId, setAgentId] = React.useState(initialAgentId);
    const [value, setValue] = React.useState<string | null>(initialModel);
    const [configuration, setConfiguration] = React.useState(() =>
      policyCase ? { effort: born.effort, fast: born.fast } : resolveModelConfiguration("claude", initialModel, initialize),
    );
    const [permissionMode, setPermissionMode] = React.useState("default");
    const editorRef = React.useRef<HTMLDivElement | null>(null);

    // Replicate agent-chat.tsx's "composer always focused" guardian VERBATIM,
    // with a contenteditable stand-in for the TipTap editor, so the
    // interaction between the guardian and the model-menu popover is the
    // same as in the app.
    React.useEffect(() => {
      const composerDom = editorRef.current;
      if (!composerDom) return;
      const onClick = (e: MouseEvent) => {
        if (e.detail === 0) return;
        const target = e.target as Element | null;
        const paneRoot = composerDom.closest("[data-pane-root]");
        const interactionInsidePane =
          !!paneRoot && !!target && paneRoot.contains(target);
        if (!interactionInsidePane) return;
        setTimeout(() => {
          const selection = window.getSelection();
          if (
            shouldReclaimComposerFocus({
              owns: composerOwnsFocus({
                chatId: null,
                activeChatId: null,
                composerConcealed: false,
              }),
              interactionInsidePane,
              composerHasFocus: composerDom.contains(document.activeElement),
              hasTextSelection:
                !!selection &&
                selection.rangeCount > 0 &&
                !selection.isCollapsed,
              hasOpenOverlay: !!document.querySelector(OPEN_OVERLAY_SELECTOR),
              activeElement: document.activeElement,
              paneRoot,
            })
          ) {
            composerDom.focus();
          }
        });
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    }, []);

    return (
      <AuthContext.Provider value={auth}><ActionsCtx.Provider value={sessions}>
      <TooltipProvider delayDuration={500} skipDelayDuration={0}>
        <ComposerConcealedContext.Provider value={false}>
          {SettingsPage ? <div id="default-model-settings" className="bg-bg1 text-fg1 flex h-screen flex-col"><SettingsPage /></div> :
          <div
            data-pane-root
            data-default-model-scenario={policyCase ?? undefined}
            className="bg-bg1 flex h-screen flex-col justify-end gap-3 p-10"
          >
            <div
              ref={editorRef}
              contentEditable
              data-testid="fake-editor"
              suppressContentEditableWarning
              className="border-border2 text-fg1 min-h-10 border p-2"
            >
              type here
            </div>
            <div
              data-testid="responsive-chat-host"
              className="[container-type:inline-size] w-[500px] [container-name:agent-chat]"
            >
              <div
                data-testid="pill-host"
                data-permission-feedback-boundary=""
                className="flex w-full min-w-0 flex-nowrap items-center gap-1"
              >
                <ComposerAttachmentMenu
                  concealed={false}
                  onAttachFiles={() => {}}
                  onAttachTranscript={() => {}}
                  onLinkWorkspace={() => {}}
                  onIntent={() => {}}
                />
                <ModelPill
                  agents={registryOverride}
                  agentId={agentId}
                  initialize={initialize}
                  workspaceFolder={cloudFolder}
                  value={value}
                  effort={configuration.effort}
                  fast={configuration.fast}
                  onConfigure={setConfiguration}
                  onChange={(next) => {
                    setValue(next);
                    setConfiguration(
                      resolveModelConfiguration(agentId, next, initialize),
                    );
                    // Load-bearing, NOT debug noise: scripts/ui-smoke-composer.mjs
                    // reads the page's console and asserts on this exact prefix to
                    // prove a row click actually reaches onChange. A click that
                    // merely closed the menu without selecting would otherwise
                    // pass. Delete this line and `pnpm test:ui-smoke` goes red.
                    console.log("[harness] onChange", next);
                  }}
                  onSelectAgentModel={policyCase ? (next) => {
                    setAgentId(next.agentId);
                    setValue(next.model);
                    setConfiguration(resolveModelConfiguration(next.agentId, next.model, null));
                  } : () => {}}
                  redirectCrossAgent={!policyCase}
                />
                <PermissionToggle
                  agentId={agentId}
                  model={value}
                  currentModeId={permissionMode}
                  onSelectMode={setPermissionMode}
                />
                <PromptInputSubmit
                  data-testid="composer-send"
                  data-composer-toolbar-actions=""
                  className="ml-auto"
                />
              </div>
            </div>
          </div>}
        </ComposerConcealedContext.Provider>
      </TooltipProvider>
      </ActionsCtx.Provider></AuthContext.Provider>
    );
  }

  createRoot(document.getElementById("root")!).render(<Harness />);
}

void main();

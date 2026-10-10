// Production transcript and Settings surfaces; all transport/auth data is
// synthetic and offline. No provider process or inference is started here.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { createRoot } from "react-dom/client";
import { ClaudeRuntimeUiFixture } from "./claude-runtime-ui-fixture";
import { TooltipProvider, Button } from "../shared/ui/primitives";
import { AuthContext, type AuthContextValue } from "../features/auth/auth-context";
import { ActionsCtx, type SessionsActions } from "../features/agent/sessions-context";
import { useWorkspaceStore } from "../state/workspace-store";
import type { ChatThread } from "../state/store";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { RuntimeClient } from "../platform/bridge/ws-client";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { setActiveOrganizationSelection } from "../features/team/active-team";
import { controlPlane } from "../features/team/control-plane";
import { requestUserSettingsSection } from "../features/settings/settings-navigation";
import { envForChatSettings } from "../features/agent/model-catalog";
import { pendingAgentPreferences } from "../platform/agent-preferences";
import { loadAgents } from "../features/agent/agents-cache";
import type { RendererContext } from "../features/agent/renderers/types";

const query = new URLSearchParams(location.search);
const organizationId = "11111111-1111-4111-8111-111111111111";
const cloudFolder = `cloud://${organizationId}/22222222-2222-4222-8222-222222222222`;
const folder = query.get("placement") === "cloud" ? cloudFolder : "/fixture/workspace";
const agents = [{ id: "claude", name: "Claude Code", description: "", version: "2.1.293", distribution: {}, installed: true, authenticated: true }];
const updates: Array<{ chatId: string; env: Record<string, string> }> = [];
const calls: Array<{ op: string }> = [];
Object.assign(window, { __ZEROS_NATIVE__: { invoke: async () => null, on: () => () => {} } });
setActiveBridge({
  status: "connected", onStatusChange: () => () => {}, onMessage: () => () => {}, on: () => () => {},
  request: async ({ op }: { op: string }) => {
    calls.push({ op });
    let result: unknown = {};
    if (op === "project.list") result = { projects: [] };
    if (op === "settings.resolve") result = { effective: { browser: { codex_enabled: false, claude_enabled: false } }, sources: {}, layers: [] };
    if (op === "settings.read") result = { doc: {}, exists: true, path: "/fixture/settings.toml" };
    return { result };
  },
} as unknown as RuntimeClient);
if (query.get("owner") === "organization") {
  const organization = { id: organizationId, name: "Fixture organization", slug: "fixture", logo: null, isPersonal: false,
    role: "owner" as const, defaultTeamId: organizationId, workspaceCapabilities: { local: true, cloud: true },
    teamCapabilities: { multiple: false as const, canCreate: false as const } };
  acceptOrganizationSnapshot({ user: { id: "44444444-4444-4444-8444-444444444444", email: "fixture@example.test", displayName: "Fixture", staffRole: null },
    organizations: [organization], teams: [organization] });
  setActiveOrganizationSelection(organizationId, false);
}
controlPlane.me = async () => { throw new Error("Offline fixture membership refresh"); };
useWorkspaceStore.setState({ activePage: "dashboard", chats: [{ id: "claude-ui-chat", agentId: "claude", folder } as ChatThread] });
await loadAgents(async () => agents);
const sessions = {
  listAgents: async () => agents,
  updateConfig: (chatId: string) => {
    updates.push({ chatId, env: envForChatSettings({ agentId: "claude", initialize: null, model: "claude-haiku-5-5", effort: "medium" }) });
  },
} as unknown as SessionsActions;
const auth: AuthContextValue = { status: "unauthenticated", session: null, userId: null, email: null, oauthError: null,
  startBrowserSignIn: async () => ({ ok: false }), clearOAuthError() {}, cancelPendingOAuth() {}, signOut: async () => {}, signOutEverywhere: async () => {} };
const openSettings = (section: string) => {
  requestUserSettingsSection(section);
  useWorkspaceStore.getState().dispatch({ type: "SET_ACTIVE_PAGE", page: "settings" });
};
const ctx: RendererContext = { isStreaming: false, lastMessageId: null, activeTurnStartedAt: 1, chatId: "claude-ui-chat",
  editBaselines: new Map(), pendingPermission: null, pendingQuestionToolCallIds: new Set(), subagentChildren: new Map(), setMode: null,
  respondToQuestion() {}, respondToPermission() {}, recordPolicy() {}, editAndResubmit() {}, retrySafetyReview: async () => {},
  openBrowserSettings: () => openSettings("browser-use"),
};
Object.assign(window, { claudeRuntimeUi: { updates, calls, preferences: () => [...pendingAgentPreferences().values()],
  openSettings, folder } });
if (query.has("settings")) openSettings(query.get("settings")!);
const { SettingsPage } = await import("../features/settings/settings-page");

function Harness() {
  const activePage = useWorkspaceStore(state => state.activePage);
  return (
    <AuthContext.Provider value={auth}>
      <ActionsCtx.Provider value={sessions}>
        <TooltipProvider>
          {activePage === "settings" ? <div id="claude-runtime-settings" className="bg-bg1 text-fg1 flex h-screen flex-col"><SettingsPage /></div> : (
            <main data-zeros-root="" className="bg-bg1 text-fg1 mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
              <Button onClick={() => openSettings("models")}>Claude provider settings</Button>
              <ClaudeRuntimeUiFixture ctx={ctx} connected={agents[0].authenticated} />
            </main>
          )}
        </TooltipProvider>
      </ActionsCtx.Provider>
    </AuthContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);

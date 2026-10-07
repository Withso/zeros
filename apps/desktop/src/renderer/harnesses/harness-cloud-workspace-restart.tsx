// Real Setup header/frame, Sidebar row and Restart action; synthetic runtime/API.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { acceptOrganizationSnapshot } from "../features/team/team-store";
import { useSessionsStore } from "../features/agent/sessions-store";
import type { AgentSessionState } from "../features/agent/use-agent-session";
import { cloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { CloudWorkspaceDocument } from "../platform/cloud-workspaces";
import type { Workspace } from "../platform/git";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { BridgeMessage } from "../platform/bridge/messages";
import type { ConnectionStatus } from "../platform/bridge/ws-client";
import { acceptCloudWorkspaceDocument, getCloudWorkspaceRows, subscribeCloudWorkspaces } from "../state/cloud-workspace-catalog";
import { cloudWorkspaceRestartPhase } from "../state/cloud-workspace-restart-status";
import { useWorkspaceStore } from "../state/workspace-store";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { Surface } from "../shared/ui/layout/surface";
import { Toaster } from "../shared/ui/primitives/elements/toast";
import { SidebarWorkspaceRow } from "../shell/sidebar-workspace-row";
import { TerminalWorkbenchLayout } from "../shell/terminal/terminal-workbench-layout";
import { WorkbenchTabFrame } from "../shell/workbench/tab-status";
import { SetupView } from "../shell/workbench/tabs/setup-tab";
import { publishTerminalTabIndicators } from "../shell/terminal/terminal-tab-indicators";
import { useTerminalStore } from "../shell/terminal/terminal-store";
import { defaultTabs } from "../shell/workbench/tab-model";
import { CloudWorkspaceDetailsContent } from "../shell/conversation/cloud-workspace-details";
import { CloudWorkspaceStatusRow } from "../shell/conversation/cloud-workspace-restart-controls";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = cloudWorkspaceKey(target);
let document: CloudWorkspaceDocument = {
  id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId, createdBy: target.organizationId,
  name: "Workspace UI", placement: "cloud", status: "ready", version: 1, error: null, deletedAt: null,
  createdAt: "2026-09-26T10:00:00Z", updatedAt: "2026-09-26T10:00:01Z",
  capabilities: { canWrite: true, canManage: false, canStart: false, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "project", revision: "main" },
  generation: { number: 1, architecture: "x86_64", observedState: "running", lastObservedAt: null,
    resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
};
const organization = { id: target.organizationId, slug: "fixture", name: "Example organization", logo: null,
  isPersonal: false, role: "admin" as const, defaultTeamId: target.organizationId,
  workspaceCapabilities: { local: false, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } };
acceptOrganizationSnapshot({ user: { id: target.organizationId, email: "fixture@example.test", displayName: "Fixture", staffRole: null },
  organizations: [organization], teams: [organization] });
acceptCloudWorkspaceDocument(document);
const initialRow = getCloudWorkspaceRows()[0];
window.__ZEROS_NATIVE__ = {
  async invoke<T>(command: string): Promise<T> {
    if (command === "auth_get_access_token") return { access_token: "fixture-session" } as T;
    if (command === "auth_get_session_user") return { sub: target.organizationId, accountId: target.organizationId, email: "fixture@example.test", name: "Fixture", provider: "workos" } as T;
    throw new Error(`Unexpected Restart fixture native command: ${command}`);
  },
  on: () => () => {},
};
class FixtureBridge extends WorkspaceRuntimeClient {
  connection: ConnectionStatus = "connected";
  listeners = new Set<() => void>();
  admissions = 0;
  holdConnect = false;
  releaseConnect = () => {};
  constructor() { super({ open: async () => { throw new Error("Synthetic admission only"); }, workspaces: () => [] }); }
  override statusForWorkspace() { return this.connection; }
  override onWorkspaceStatusChange(_folder: string, listener: () => void) {
    this.listeners.add(listener); listener();
    return () => { this.listeners.delete(listener); };
  }
  setConnection(connection: ConnectionStatus) {
    this.connection = connection;
    for (const listener of this.listeners) listener();
  }
  override async warmWorkspace() {
    this.admissions++;
    if (this.holdConnect) await new Promise<void>(resolve => { this.releaseConnect = resolve; });
    this.setConnection("connected");
  }
  override async request<T extends BridgeMessage = BridgeMessage>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
    const op = (message as { op?: string }).op;
    if (op === "workspace.setupInfo") return { type: "WORKSPACE_RESPONSE", result: {
      hasCommand: true, command: "pnpm install", state: "passed", log: "Dependencies installed.\r\nWorkspace setup complete.\r\n", truncated: false,
    } } as unknown as T;
    return { type: "WORKSPACE_RESPONSE", result: { files: [], additions: 0, deletions: 0 } } as unknown as T;
  }
}
const bridge = new FixtureBridge();
setActiveBridge(bridge);
useWorkspaceStore.setState({ activePage: "workspace", chats: [{ id: "restart-chat", folder, agentId: "claude", agentName: "Claude", title: "Fixture",
  model: null, effort: "high", permissionMode: "auto", createdAt: 0, updatedAt: 0 }] });
function publish(patch: Partial<CloudWorkspaceDocument>) {
  document = { ...document, ...patch, version: document.version + 1,
    updatedAt: new Date(Date.UTC(2026, 8, 26, 10) + (document.version + 1) * 1000).toISOString() };
  acceptCloudWorkspaceDocument(document);
  return document;
}
Object.assign(window, { cloudRestartFixture: {
  get document() { return document; }, publish, bridge,
  get restartPhase() { return cloudWorkspaceRestartPhase(folder); },
  work(kind: "idle" | "agent" | "queued" | "dispatching" | "script" | "terminal" | "preview") {
    useSessionsStore.getState().removeSession("restart-chat");
    useTerminalStore.setState({ sessions: [] });
    publishTerminalTabIndicators(folder, {});
    useWorkspaceStore.setState({ workbenchByScope: {} });
    if (["agent", "queued", "dispatching"].includes(kind)) useSessionsStore.getState().setSession("restart-chat", {
      cwd: folder, agentId: "claude", status: kind === "agent" ? "streaming" : "ready", activeTurnStartedAt: kind === "agent" ? 1 : null,
      lastStopReason: null, pendingPermission: null, pendingQuestions: [], backgroundTasks: [], workflows: [], waitingForBackgroundTasks: false,
      messages: kind === "agent" ? [] : [{ kind: "text", role: "user", text: "Fixture", queued: true, ...(kind === "dispatching" ? { queuedDelivery: "sending" } : {}) }],
      boundaryPorts: null, backgroundActivity: null,
    } as unknown as AgentSessionState);
    if (kind === "script") publishTerminalTabIndicators(folder, { setup: { running: false, exited: false, dot: "running" } });
    if (kind === "terminal") useTerminalStore.getState().createSession(folder, null, undefined, "restart-terminal");
    if (kind === "preview") useWorkspaceStore.setState({ workbenchByScope: { [folder]: { ...defaultTabs(),
      tabs: [{ id: "preview", type: "browser", title: "Preview", url: "http://localhost:3000" }] } } });
  },
} });
const noop = () => {};
const setupTab = { id: "setup", type: "terminal" as const, title: "Setup", terminalId: "setup", terminalSidebarVisible: false };
function Harness() {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState("cloud");
  const rows = useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspaceRows);
  const cloud = placement === "cloud";
  const workspace: Workspace = cloud ? rows[0] ?? initialRow : { ...initialRow, id: "/fixture/local", path: "/fixture/local", repoRoot: "/fixture/local",
    placement: "local", organizationId: placement === "personal" ? null : target.organizationId };
  return <TooltipProvider>
    <Toaster />
    <main className="bg-bg0 text-fg1 min-h-screen p-6">
      <div className="mb-4 flex gap-2">
        <Button onClick={() => setPlacement("cloud")}>Cloud fixture</Button>
        <Button onClick={() => setPlacement("personal")}>Local Personal fixture</Button>
        <Button onClick={() => setPlacement("organization")}>Local organization fixture</Button>
      </div>
      <div className="flex h-[440px] gap-4">
        <Surface kind="sidebar" className="w-60 shrink-0 rounded-lg p-2">
          <SidebarWorkspaceRow workspace={workspace} active chatIds={["restart-chat"]} project={null} mixedRepositories={false} grouped={false}
            onSelect={noop} onPrefetch={noop} onArchive={noop} />
        </Surface>
        {cloud && <section aria-label="Cloud workspace details" className="border-border1 bg-bg1 w-[360px] shrink-0 overflow-y-auto rounded-lg border p-3">
          <CloudWorkspaceDetailsContent workspace={document} creator="Fixture"
            status={<CloudWorkspaceStatusRow folder={workspace.path} active inline />} />
        </section>}
        <section aria-label="Setup tab" className="border-border1 bg-bg1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <WorkbenchTabFrame folder={workspace.path} tab={setupTab} active>
            <TerminalWorkbenchLayout folder={workspace.path} tab={setupTab} active bodyRef={setBody} entries={[]}
              onSelect={noop} onClose={noop} onAdd={noop} onConfigure={noop} onConfigureIntent={noop} onRun={noop} onRunSetup={noop}
              setupRunDisabled onStop={noop} onOpenPreview={noop} onDock={noop} onToggleSidebar={noop} />
            {body && createPortal(<SetupView workspace={workspace} visible onBusyChange={noop} />, body)}
          </WorkbenchTabFrame>
        </section>
      </div>
    </main>
  </TooltipProvider>;
}
createRoot(globalThis.document.getElementById("root")!).render(<Harness />);

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import type { WorkspaceAvailability } from "../workbench/tab-status-model";
import type { AgentSessionState } from "../../features/agent/use-agent-session";
const state = vi.hoisted(() => ({ enabled: true, workspace: undefined as CloudWorkspaceDocument | undefined,
  availability: { cloud: true, state: "ready", connection: "connected", since: 0 } as WorkspaceAvailability }));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => state.enabled, isInternalFeatureActive: () => state.enabled }));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 0, subscribeCloudWorkspaces: () => () => {},
  cloudWorkspaceDocument: () => state.workspace,
  canReadCloudWorkspace: (doc: CloudWorkspaceDocument | undefined) => !!doc && doc.deletedAt === null && !["deleting", "deleted"].includes(doc.status),
}));
vi.mock("../../state/workbench-availability", () => ({ useWorkbenchAvailability: () => ({ availability: state.availability }) }));
import { CloudWorkspaceStatusRow } from "../conversation/cloud-workspace-restart-controls";
import { cloudWorkspaceHasRunningWork } from "../conversation/cloud-workspace-running-work";
import { TooltipProvider } from "../../shared/ui/primitives";

const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  state.enabled = true;
  state.workspace = { id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", placement: "cloud",
    status: "ready", deletedAt: null, capabilities: { canWrite: true }, generation: { number: 1 } } as CloudWorkspaceDocument;
  state.availability = { cloud: true, state: "ready", connection: "connected", since: Date.now() };
});
function render(path = folder) { return renderToStaticMarkup(createElement(TooltipProvider, { children: createElement(CloudWorkspaceStatusRow, { folder: path, active: true }) })); }
describe("cloud Restart status controls", () => {
  it.each(["/local/personal", "/local/organization"])("does not add controls or status to %s", path => {
    expect(render(path)).toBe("");
  });
  it.each(["archived", "archiving", "deleting", "deleted"])("hides the controls for %s", status => {
    state.workspace!.status = status;
    expect(render()).toBe("");
  });
  it("keeps permission-denied Restart visible and disabled with an explanatory tooltip", () => {
    state.workspace!.capabilities.canWrite = false;
    const html = render();
    expect(html).toContain('aria-label="Restart workspace" disabled=""');
    expect(html).toContain("Running");
  });
  it("requires the staff feature gate and the exact cloud owner", () => {
    state.enabled = false;
    expect(render()).toBe("");
    state.enabled = true;
    expect(render(folder.replace("22222222", "33333333"))).toBe("");
  });
  it.each([["ready", "Running"], ["busy", "Running"], ["waking", "Starting"], ["setting_up", "Starting"],
    ["stopped", "Sleeping"], ["stopping", "Stopping"], ["failed", "Needs attention"]])("renders %s through shared availability", (status, label) => {
    state.workspace!.status = status;
    state.availability.state = status;
    const html = render();
    expect(html).toContain(label);
    expect(html.includes("bg-green-primary")).toBe(label === "Running");
  });
  it("shows Restarting throughout the stop/wake gap and preserves the calm transport thresholds", () => {
    state.availability = { ...state.availability, restarting: true, connection: "disconnected", since: 0 };
    expect(render()).toContain("Restarting…");
    state.availability = { ...state.availability, restarting: false, since: Date.now() - 5_000 };
    expect(render()).toContain("Running");
    state.availability.since = Date.now() - 50_000;
    expect(render()).toContain("Needs attention");
  });
});

describe("restart running-work confirmation", () => {
  function snapshot() { return { chats: [{ id: "chat", folder }], sessions: {} as Record<string, AgentSessionState>, pendingTurns: {} as Record<string, string>,
    terminals: [] as { folder: string; alive: boolean }[], tabs: [] as import("../workbench/tab-model").WorkbenchTab[], scriptsRunning: false }; }
  function session(patch: Partial<AgentSessionState>): AgentSessionState {
    return { cwd: folder, agentId: "claude", status: "ready", activeTurnStartedAt: null, messages: [], boundaryPorts: null,
      lastStopReason: null, backgroundActivity: null, backgroundTasks: [], workflows: [], ...patch } as AgentSessionState;
  }
  it("allows one click with no running work or only a completed transcript", () => {
    const observed = snapshot(); observed.sessions.chat = session({});
    observed.terminals = [{ folder, alive: false }];
    observed.tabs = [{ id: "external", type: "browser", title: "Docs", url: "https://example.test" }];
    expect(cloudWorkspaceHasRunningWork(folder, observed)).toBe(false);
  });
  it.each(["streaming", "warming", "pending", "queued", "dispatching", "script", "terminal", "preview"])("confirms observed %s work", kind => {
    const observed = snapshot();
    observed.sessions.chat = session({});
    if (kind === "streaming" || kind === "warming") { observed.sessions.chat.status = kind; observed.sessions.chat.activeTurnStartedAt = 1; }
    if (kind === "pending") observed.pendingTurns.chat = "turn";
    if (kind === "queued" || kind === "dispatching") observed.sessions.chat.messages = [{ kind: "text", role: "user", text: "Fixture",
      ...(kind === "queued" ? { queued: true } : { queuedDelivery: "sending" }) } as import("@zeros/protocol/agent-messages").AgentMessage];
    if (kind === "script") observed.scriptsRunning = true;
    if (kind === "terminal") observed.terminals = [{ folder: `${folder}/src`, alive: true }];
    if (kind === "preview") observed.tabs = [{ id: "preview", type: "browser", title: "Preview", url: "http://localhost:3000" }];
    expect(cloudWorkspaceHasRunningWork(folder, observed)).toBe(true);
  });
  it("does not prompt for another workspace, owner or placement's work", () => {
    const observed = snapshot();
    const other = folder.replace("11111111", "33333333");
    observed.chats = [{ id: "other", folder: other }];
    observed.sessions.other = session({ cwd: other, status: "streaming" });
    observed.pendingTurns.other = "turn";
    observed.terminals = [{ folder: other, alive: true }, { folder: "/local", alive: true }];
    expect(cloudWorkspaceHasRunningWork(folder, observed)).toBe(false);
    expect(cloudWorkspaceHasRunningWork("/local/personal", observed)).toBe(false);
    expect(cloudWorkspaceHasRunningWork("/local/organization", observed)).toBe(false);
  });
});

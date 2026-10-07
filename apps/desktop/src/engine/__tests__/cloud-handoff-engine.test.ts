import { describe, expect, it, vi } from "vitest";
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
import { ZerosEngine } from "../zeros-engine";

function fixture() {
  const state = {
    running: true, cloudWorker: {}, cloudRuntimeAuthorityStopping: false, cloudRuntimeCheckpointQuiescing: false,
    cloudRuntimeHandoffFenced: false, cloudHandoffRequests: 0,
    residentTerminals: { healthy: () => true, busy: () => false, hasRecentInput: () => true },
    activePromptContexts: new Map(), promptSessions: new Set(), retiringCloudExecutions: new Set(),
    pendingPermissionRequests: new Map(), pendingQuestionRequests: new Map(),
    cloudWorkspaceMutations: new Set(), globalDesignAuthorityStarts: new Set(), workspaceProcessStarts: new Map(),
    setup: { hasRepositoryCodeAuthority: () => false }, runs: { hasRepositoryCodeAuthority: () => false },
    cloudCommands: { handoffDrained: () => true }, cloudGoals: { active: () => false },
    cloudActions: { hasActiveWork: () => false }, pty: { list: () => [] },
    activePrompts: new Set(), sessionLoadResponses: new Map(), sessionAgent: new Map(),
    cloud: { handoffBusy: () => false, setHandoffFenced: vi.fn() }, residentGithubBrokers: new Map(),
    activityHeartbeat: { track: (operation: () => unknown) => operation() }, dispatchMessage: vi.fn(async () => {}),
  };
  Object.setPrototypeOf(state, ZerosEngine.prototype);
  return state as typeof state & { cloudHandoffBusy(): boolean;
    setCloudHandoffFence(fenced: boolean): void; handleMessage(message: unknown, client: unknown): Promise<void> };
}
describe("cloud resident handoff admission", () => {
  it("allows a live resident terminal but blocks legacy PTYs, actions, mutations and active service streams", () => {
    const state = fixture();
    expect(state.cloudHandoffBusy()).toBe(false);
    for (const map of [state.activePromptContexts, state.pendingPermissionRequests, state.pendingQuestionRequests]) {
      map.set("pending", {}); expect(state.cloudHandoffBusy()).toBe(true); map.clear();
    }
    state.cloudWorkspaceMutations.add(Promise.resolve()); expect(state.cloudHandoffBusy()).toBe(true);
    state.cloudWorkspaceMutations.clear();
    state.cloud.handoffBusy = () => true; expect(state.cloudHandoffBusy()).toBe(true);
    state.cloud.handoffBusy = () => false;
    state.cloudActions.hasActiveWork = () => true; expect(state.cloudHandoffBusy()).toBe(true);
    state.cloudActions.hasActiveWork = () => false;
    state.pty.list = () => [{}] as never[]; expect(state.cloudHandoffBusy()).toBe(true);
  });
  it("counts a request admitted before the fence and refuses later requests without dispatching them", async () => {
    const state = fixture(), client = { close: vi.fn() };
    let finish!: () => void;
    state.dispatchMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const admitted = state.handleMessage({ type: "WORKSPACE_REQUEST" }, client);
    expect(state.cloudHandoffRequests).toBe(1); expect(state.cloudHandoffBusy()).toBe(true);
    state.setCloudHandoffFence(true);
    await state.handleMessage({ type: "PTY_CREATE" }, client);
    expect(state.dispatchMessage).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledWith(1012, "Runtime update");
    finish(); await admitted;
    expect(state.cloudHandoffRequests).toBe(0);
  });
  it("leaves Local and organization-local message dispatch outside the cloud barrier", async () => {
    const state = fixture(), client = { close: vi.fn() };
    state.cloudWorker = null as unknown as object; state.cloudRuntimeHandoffFenced = true;
    await state.handleMessage({ type: "WORKSPACE_REQUEST" }, client);
    expect(state.dispatchMessage).toHaveBeenCalledOnce(); expect(client.close).not.toHaveBeenCalled();
    expect(state.cloudHandoffRequests).toBe(0);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";
import { useSendToActiveChat } from "../use-send-to-active-chat";

const folder =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const fixture = vi.hoisted(() => ({
  cloudComputerV2: false,
  prepareForSend: vi.fn<() => Promise<void> | null>(() => null),
  bridge: null as unknown as WorkspaceRuntimeClient,
  chats: [] as unknown[],
  sendPrompt: vi.fn(async () => {}),
  error: vi.fn(),
}));
vi.mock("../../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => fixture.cloudComputerV2 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("../../../platform/bridge/use-bridge", () => ({
  useBridge: () => fixture.bridge,
}));
vi.mock("../../../features/agent/sessions-hooks", () => ({
  useAgentSessions: () => ({
    getSession: () => ({
      agentId: "codex",
      sessionId: "execution",
      transcriptState: "resident",
    }),
    sendPrompt: fixture.sendPrompt,
    prepareForSend: fixture.prepareForSend,
  }),
}));
vi.mock("../../../state/store", () => ({
  useActiveChatId: () => "chat",
  useWorkspaceStore: { getState: () => ({ chats: fixture.chats }) },
  recordWorkspaceActivity: () => {},
}));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: fixture.error },
}));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.cloudComputerV2 = false;
  fixture.prepareForSend.mockReturnValue(null);
  fixture.chats = [{ id: "chat", folder, agentId: "codex", kind: "chat" }];
  fixture.bridge = Object.create(WorkspaceRuntimeClient.prototype, {
    status: { value: "disconnected", writable: true },
    statusForWorkspace: { value: vi.fn(() => "connected"), writable: true },
  });
});
describe("PR action connection ownership", () => {
  it("prepares an explicitly submitted cloud message before requiring its runtime connection", async () => {
    fixture.cloudComputerV2 = true;
    vi.mocked(fixture.bridge.statusForWorkspace).mockReturnValue("disconnected");
    let ready!: () => void;
    fixture.prepareForSend.mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
    expect(useSendToActiveChat(folder)({ text: "Create a PR" })).toBe(true);
    expect(fixture.prepareForSend).toHaveBeenCalledExactlyOnceWith("chat");
    expect(fixture.sendPrompt).not.toHaveBeenCalled();
    vi.mocked(fixture.bridge.statusForWorkspace).mockReturnValue("connected");
    ready();
    await vi.waitFor(() => expect(fixture.sendPrompt).toHaveBeenCalledOnce());
    expect(fixture.error).not.toHaveBeenCalled();
  });
  it("sends through a connected cloud workspace while the local engine is disconnected", async () => {
    expect(useSendToActiveChat(folder)({ text: "Create a PR" })).toBe(true);
    await vi.waitFor(() => expect(fixture.sendPrompt).toHaveBeenCalledOnce());
    expect(fixture.bridge.statusForWorkspace).toHaveBeenCalledWith(folder);
    expect(fixture.error).not.toHaveBeenCalled();
  });
  it("refuses a disconnected cloud destination even when the local engine is connected", () => {
    Object.defineProperty(fixture.bridge, "status", { value: "connected" });
    vi.mocked(fixture.bridge.statusForWorkspace).mockReturnValue(
      "disconnected",
    );
    expect(useSendToActiveChat(folder)({ text: "Create a PR" })).toBe(false);
    expect(fixture.sendPrompt).not.toHaveBeenCalled();
    expect(fixture.error).toHaveBeenCalledOnce();
  });
});

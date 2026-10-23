import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ summaries: vi.fn(async () => [{ chatId: "prior", summary: "Earlier work", createdAt: 1, lastMessageAt: 1 }]) }));
vi.mock("../../../platform/bridge/workspace-bridge", async (original) => ({
  ...(await original<typeof import("../../../platform/bridge/workspace-bridge")>()),
  bridgeChatSummaries: bridge.summaries,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => ({ status: "connected" }) }));
import { listChatSummariesForFolder } from "../agent-history-client";

beforeEach(() => bridge.summaries.mockClear());
describe("prior chat summaries placement", () => {
  it("reads a Local folder's prior chats from the engine", async () => {
    await expect(listChatSummariesForFolder({ folder: "/Users/me/project" })).resolves.toHaveLength(1);
    expect(bridge.summaries).toHaveBeenCalledOnce();
  });
  it("reads a running cloud workspace's prior chats from its worker", async () => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    await expect(listChatSummariesForFolder({ folder })).resolves.toHaveLength(1);
    expect(bridge.summaries).toHaveBeenCalledWith(expect.anything(), folder, undefined);
  });
  it("offers none, without an error, while a cloud workspace is stopped", async () => {
    bridge.summaries.mockRejectedValueOnce(new Error("The cloud workspace is stopped"));
    await expect(listChatSummariesForFolder({ folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" })).resolves.toEqual([]);
  });
  it("keeps Local summary failures visible", async () => {
    bridge.summaries.mockRejectedValueOnce(new Error("Local engine unavailable"));
    await expect(listChatSummariesForFolder({ folder: "/Users/me/project" })).rejects.toThrow("Local engine unavailable");
  });
});

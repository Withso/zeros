import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  client: { executionIdentity: { kind: "local" }, request: vi.fn() },
  resolve: vi.fn(async () => "workspace-a"),
  write: vi.fn(async () => ({ bytes: 1 })),
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => state.client,
}));
vi.mock("../../../platform/bridge/workspace-id-resolver", () => ({
  resolveBridgeWorkspaceIdForCwd: state.resolve,
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  bridgeAttachmentWrite: state.write,
}));
vi.mock("../../../platform/context-graph", () => ({
  notifyContextGraphChanged: vi.fn(),
}));
import { createContextAttachmentWriter } from "../agent-history-client";

it("pins the destination once and refuses another runtime between chunks", async () => {
  const write = createContextAttachmentWriter("/repo");
  const args = {
    cwd: "/repo",
    attachmentId: "att-1",
    filename: "a.txt",
    mimeType: "text/plain",
    base64: "",
  };
  await write(args);
  await write(args);
  expect(state.resolve).toHaveBeenCalledTimes(1);
  state.client.executionIdentity = {
    kind: "cloud",
    organizationId: "org",
    workspaceId: "other",
    generation: 1,
  } as never;
  await expect(write(args)).rejects.toThrow(/workspace changed/);
  expect(state.write).toHaveBeenCalledTimes(2);
});

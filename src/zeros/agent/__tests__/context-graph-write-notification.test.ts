import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  notifyContextGraphChanged: vi.fn(),
}));

vi.mock("../../../native/runtime", () => ({
  nativeInvoke: mocks.nativeInvoke,
}));
vi.mock("../../../native/context-graph", () => ({
  notifyContextGraphChanged: mocks.notifyContextGraphChanged,
}));
vi.mock("../../bridge/active-bridge", () => ({
  getActiveBridge: vi.fn(() => ({})),
}));
vi.mock("../../bridge/workspace-bridge", () => ({
  bridgeChatList: vi.fn(),
  bridgeChatSnapshot: vi.fn(),
  bridgeChatDelete: vi.fn(),
  bridgeChatBulkUpsert: vi.fn(),
  bridgeMessageWindow: vi.fn(),
  bridgeMessageWindowOlder: vi.fn(),
  bridgeMessageClear: vi.fn(),
  bridgeMessageTruncateFrom: vi.fn(),
  bridgeDbHead: vi.fn(),
  bridgeDbPull: vi.fn(),
  bridgeChatSummaries: vi.fn(),
}));

import { writeContextAttachment } from "../agent-history-client";

const writeArgs = {
  cwd: "/repo/worktree",
  attachmentId: "att-1",
  base64: "aGVsbG8=",
  mimeType: "text/plain",
  filename: "notes.txt",
};

describe("writeContextAttachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not invalidate git surfaces for an idempotent safety-net write", async () => {
    mocks.nativeInvoke.mockResolvedValue({
      absolutePath: "/repo/worktree/.context-graph/local/notes.txt",
      relativePath: ".context-graph/local/notes.txt",
      mimeType: "text/plain",
      bytes: 5,
      skipped: true,
    });

    await writeContextAttachment(writeArgs);

    expect(mocks.notifyContextGraphChanged).not.toHaveBeenCalled();
  });

  it("notifies graph and Files subscribers after a real write", async () => {
    mocks.nativeInvoke.mockResolvedValue({
      absolutePath: "/repo/worktree/.context-graph/local/notes.txt",
      relativePath: ".context-graph/local/notes.txt",
      mimeType: "text/plain",
      bytes: 5,
    });

    await writeContextAttachment(writeArgs);

    expect(mocks.notifyContextGraphChanged).toHaveBeenCalledWith(
      "/repo/worktree",
    );
  });
});

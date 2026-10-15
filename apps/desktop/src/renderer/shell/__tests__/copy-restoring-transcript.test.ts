import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../../platform/bridge/active-bridge";
import { cloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { bridgeMessageWindowOlder } from "../../platform/bridge/workspace-bridge";
import type { CloudHistoryRestoreMetadata } from "../../platform/cloud-transcript-cache-contract";
import { copyChatTranscript } from "../copy-chat-transcript";

const output = vi.hoisted(() => ({
  copy: vi.fn(async () => true),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: output.toast }));
vi.mock("../../shared/lib/clipboard", () => ({ copyToClipboardWithFallback: output.copy }));

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const chat = cloudScopedId(target, "chat");
const metadata: CloudHistoryRestoreMetadata = {
  projection: { ...target, generation: 1, engineInstanceId: "33333333-3333-4333-8333-333333333333",
    bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
    fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1,
    version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1", mirroredSequence: 20, sealedSequence: null, complete: false },
  historyHeads: [{ conversationId: "chat", originWriterEpoch: "55555555-5555-4555-8555-555555555555",
    source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "edit" },
    restoreRevision: 3, recordSequence: null, eventSequence: null, manifestSha256: null,
    deleted: false, incompleteReason: "capture_unavailable" }],
};
const clients: WorkspaceRuntimeClient[] = [];
function fixture(value = metadata) {
  const open = vi.fn(async () => { throw new Error("A transcript read must not wake the workspace"); });
  const client = new WorkspaceRuntimeClient({ open, workspaces: () => [], canAccess: () => true,
    readHistory: async () => ({ messages: [], ...value }) });
  clients.push(client); setActiveBridge(client);
  return { client, open };
}
afterEach(() => {
  setActiveBridge(null);
  for (const client of clients.splice(0)) client.dispose();
  vi.clearAllMocks();
});

describe("Copy transcript while the current projection is incomplete", () => {
  it.each(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain", "missing"] as const)(
    "reports catching up for %s instead of claiming the conversation is empty", async reason => {
      const { open } = fixture({ ...metadata, historyHeads: reason === "missing" ? [] : [{ ...metadata.historyHeads[0], incompleteReason: reason }] });
      await copyChatTranscript(chat, "full", {});
      expect(output.toast.info).toHaveBeenCalledWith(expect.stringMatching(/catching up/i));
      expect(output.toast.info).not.toHaveBeenCalledWith("This chat has no messages yet.");
      expect(output.copy).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("does not treat an incomplete older page as proof that the full transcript was copied", async () => {
    const { client, open } = fixture();
    await expect(bridgeMessageWindowOlder(client, chat, 1000, "new-prompt")).rejects.toMatchObject({ code: "cloud_history_incomplete" });
    expect(open).not.toHaveBeenCalled();
  });

  it("still reports an authenticated deletion as known empty", async () => {
    fixture({ ...metadata, historyHeads: [{ ...metadata.historyHeads[0], deleted: true,
      source: { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "delete" } }] });
    await copyChatTranscript(chat, "full", {});
    expect(output.toast.info).toHaveBeenCalledWith("This chat has no messages yet.");
    expect(output.copy).not.toHaveBeenCalled();
  });
});

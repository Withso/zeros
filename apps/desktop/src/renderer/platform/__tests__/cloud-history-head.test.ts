import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloudScopedId } from "../bridge/cloud-workspace-key";

const h = vi.hoisted(() => ({ request: vi.fn(), generation: 0, install: vi.fn() }));
vi.mock("../cloud-workspaces", () => ({ cloudAccountRequest: h.request }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => h.generation }));
vi.mock("../cloud-transcript-cache", () => ({ captureCloudTranscriptConfirmation: () => null,
  forgetCloudTranscriptChat: vi.fn(), installCloudHistoryRestoreMetadata: h.install,
  captureCloudHistoryRestoreRead: () => null, assertCloudHistoryRestoreResult: vi.fn() }));
import { readCloudWorkspaceHistory } from "../cloud-history";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const binding = { ...target, generation: 2, engineInstanceId: "33333333-3333-4333-8333-333333333333",
  bootId: "44444444-4444-4444-8444-444444444444", writerEpoch: "55555555-5555-4555-8555-555555555555",
  fundingOwnerUserId: "66666666-6666-4666-8666-666666666666", fundingOwnerEpoch: 1 };
const projection = { ...binding, version: 1, mode: "boot-owner-v1", fundingScope: "workspace-roles-v1",
  mirroredSequence: 20, sealedSequence: 20, complete: true };
const source = { kind: "mutation", mutationId: "77777777-7777-4777-8777-777777777777", operation: "repair" };
const head = { conversationId: "chat", originWriterEpoch: binding.writerEpoch, source,
  restoreRevision: 5, deleted: false, recordSequence: 10, eventSequence: 9,
  manifestSha256: "a".repeat(64), incompleteReason: null };
const message = { msgId: "reply", kind: "text", createdAt: 1,
  payload: JSON.stringify({ id: "reply", kind: "text", role: "agent", text: "confirmed", createdAt: 1 }) };
const page = (extra: Record<string, unknown> = {}) => ({ ...target, revision: 20, messages: [message], projection,
  historyHeads: [head], ...extra });
const read = () => readCloudWorkspaceHistory(target, "messages.window", { chatId: cloudScopedId(target, "chat") });
beforeEach(() => { h.request.mockReset(); h.install.mockReset(); h.generation = 0; });
function response(value: unknown) {
  h.request.mockImplementationOnce(async (_path, schema) => schema.parse(value));
}

describe("stopped local-writer restore authority", () => {
  it("preserves the exact binding, full source and known restore heads instead of stripping them", async () => {
    response(page());
    expect(await read()).toEqual({ messages: [message], revision: 20, projection, historyHeads: [head] });
    expect(h.install).toHaveBeenCalledWith(target, { projection, historyHeads: [head] }, ["chat"], null);
  });
  it.each(["capture_unavailable", "capture_conflict", "history_limit", "recovery_uncertain"])(
    "publishes a newer %s fence while withholding an older transcript", async incompleteReason => {
      const incomplete = { ...head, restoreRevision: 6, recordSequence: null, manifestSha256: null, incompleteReason };
      const metadata = { projection: { ...projection, complete: false, sealedSequence: null }, historyHeads: [incomplete] };
      response(page(metadata));
      expect(await read()).toEqual({ messages: [], revision: 20, ...metadata });
      expect(h.install).toHaveBeenCalledWith(target, metadata, ["chat"], null);
    });
  it("keeps an authoritative deletion head even when its chat is filtered from the result", async () => {
    const deleted = { ...head, deleted: true, source: { ...source, operation: "delete" } };
    response({ ...target, revision: 20, chats: [], chatDeletions: [], nextCursor: null,
      projection, historyHeads: [deleted] });
    const result = await readCloudWorkspaceHistory(target, "chats.list", {});
    expect(result).toMatchObject({ chats: [], chatDeletions: [cloudScopedId(target, "chat")], projection, historyHeads: [deleted] });
  });
  it("keeps missing current-head coverage unknown and never treats the returned old rows as current", async () => {
    const metadata = { projection: { ...projection, complete: false, sealedSequence: null }, historyHeads: [] };
    response(page(metadata));
    expect(await read()).toEqual({ messages: [], revision: 20, ...metadata });
  });
  it.each([
    { projection: { ...projection, workspaceId: binding.organizationId } },
    { historyHeads: [head, head] },
    { historyHeads: [{ ...head, conversationId: "foreign" }] },
    { historyHeads: [{ ...head, source: { ...source, operation: null } }] },
    { historyHeads: [{ ...head, source: { ...source, accessToken: "synthetic-private" } }] },
    { projection: { ...projection, sealedSequence: null } },
    { historyHeads: [] },
    { projection: undefined },
  ])("refuses contradictory or incomplete complete-page metadata %# before publishing it", async extra => {
    response(page(extra));
    await expect(read()).rejects.toThrow();
    expect(h.install).not.toHaveBeenCalled();
  });
  it("preserves the exact legacy result when the runtime has not negotiated local writer metadata", async () => {
    response({ ...target, revision: 20, messages: [message] });
    expect(await read()).toEqual({ messages: [message], revision: 20 });
    expect(h.install).not.toHaveBeenCalled();
  });
});

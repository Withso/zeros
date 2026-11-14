import { afterEach, describe, expect, it } from "vitest";
import { decodeNativeCloudTranscriptWindow, cloudTranscriptCache } from "../../../state/local-transcript-cache";
import { presentCachedTranscript } from "../local-transcript-presentation";
import { projectCloudPromptSession, cloudPromptHasLegacyActivity } from "../cloud-prompt-presentation";
import type { CloudCachePending, CloudCacheRange } from "../../../../../shared/cloud-chat-cache";
import { BLANK, useSessionsStore } from "../sessions-store";

const owner = JSON.stringify(["https://api.example.test", "viewer-a"]);
const workspaceId = "22222222-2222-4222-8222-222222222222", organizationId = "11111111-1111-4111-8111-111111111111";
const chatId = `cloud:${organizationId}:${workspaceId}:chat`, cwd = `cloud://${organizationId}/${workspaceId}`;
const message = { id: "native", kind: "text" as const, role: "user" as const, text: "Native prompt", createdAt: 1 };
const range: CloudCacheRange = { revision: 8, messageCount: 1, fromIndex: 0, toIndex: 1,
  rows: [{ index: 0, msgId: message.id, kind: "text", payload: JSON.stringify(message), createdAt: 1 }] };
const pending: CloudCachePending = { queueRevision: 5, epoch: "2", items: [{
  receipt: { workspaceId, chatId: "chat", userMessageId: "queued", sequence: "1", epoch: "2", acceptedAt: "2026-11-12T12:00:00.000Z", workspaceState: "stopped" },
  state: "queued", cancelRequested: false,
  payload: { chatId: "chat", userMessageId: "queued", agentId: "codex", prompt: [{ type: "text", text: "Saved queued prompt" }], startedAt: 2,
    bubble: { retryText: "do not grant Retry", autoAction: "test-action" } },
}] };
afterEach(() => { useSessionsStore.getState().removeSession(chatId); cloudTranscriptCache.resetForTesting(); });

describe("native cached history and own receipt presentation", () => {
  it("keeps native rows exact and carries saved receipts outside the canonical transcript", () => {
    const window = decodeNativeCloudTranscriptWindow({ range, pending }, owner, 3)!;
    expect(window?.messages).toEqual([message]);
    expect(window?.cloudCache).toMatchObject({ owner, epoch: 3, revision: 8, receiptRows: [{ id: "queued", text: "Saved queued prompt" }] });
    const row = window.cloudCache!.receiptRows![0];
    expect(row.queued).toBeUndefined(); expect(row.recoveryFailure).toBeUndefined(); expect(row.retryText).toBeUndefined(); expect(row.autoAction).toBeUndefined();
  });

  it("paints receipts provisionally without granting queue, Stop, retry or turn authority", () => {
    cloudTranscriptCache.bindOwner(owner, false);
    useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd, transcriptState: "loading" });
    const window = decodeNativeCloudTranscriptWindow({ range, pending }, owner, 3)!;
    expect(presentCachedTranscript(chatId, window)).toBe(true);
    const saved = useSessionsStore.getState().sessions[chatId];
    const shown = projectCloudPromptSession(saved);
    expect(saved.messages).toEqual([message]);
    expect(shown.messages.map(row => row.id)).toEqual(["native", "queued"]);
    expect(shown.transcriptState).toBe("loading");
    expect(shown.transcriptPresentation?.source).toBe("cache");
    expect(shown.cloudOutbox).toBeUndefined(); expect(shown.cloudStop).toBeUndefined(); expect(shown.foregroundTurnId).toBe(BLANK.foregroundTurnId);
    expect(shown.activeTurnStartedAt).toBeNull(); expect(shown.status).toBe(BLANK.status);
    expect(cloudPromptHasLegacyActivity(shown)).toBe(false);
    expect(projectCloudPromptSession(saved)).toBe(shown);
  });

  it("a receipt-only cached window that loses its last receipt presents the confirmed empty state", () => {
    cloudTranscriptCache.bindOwner(owner, false);
    useSessionsStore.getState().setSession(chatId, { ...BLANK, cwd, transcriptState: "loading" });
    const empty = { ...range, messageCount: 0, fromIndex: 0, toIndex: 0, rows: [] };
    expect(presentCachedTranscript(chatId, decodeNativeCloudTranscriptWindow({ range: empty, pending }, owner, 3)!)).toBe(true);
    // Receipts present: not the confirmed empty state.
    expect(useSessionsStore.getState().sessions[chatId].transcriptPresentation?.empty).toBeUndefined();
    const drained = { ...pending, queueRevision: 6, items: [] };
    expect(presentCachedTranscript(chatId, decodeNativeCloudTranscriptWindow({ range: empty, pending: drained }, owner, 3)!)).toBe(true);
    const slot = useSessionsStore.getState().sessions[chatId];
    expect(slot.hasTranscript).toBe(false);
    expect(slot.transcriptPresentation?.empty).toBe(true);
  });

  it("allows a receipt-only cached view without fabricating a native history row", () => {
    cloudTranscriptCache.bindOwner(owner, false);
    const empty = { ...range, messageCount: 0, fromIndex: 0, toIndex: 0, rows: [] };
    const window = decodeNativeCloudTranscriptWindow({ range: empty, pending }, owner, 3)!;
    expect(presentCachedTranscript(chatId, window)).toBe(true);
    const saved = useSessionsStore.getState().sessions[chatId];
    expect(saved.messages).toEqual([]);
    expect(projectCloudPromptSession(saved).messages.map(row => row.id)).toEqual(["queued"]);
    expect(saved.transcriptState).toBe("loading");
  });

  it("lets live receipt state and resident history replace the cached projection", () => {
    const window = decodeNativeCloudTranscriptWindow({ range, pending }, owner, 3)!;
    const slot = { ...BLANK, cwd, messages: [message], transcriptState: "loading" as const,
      transcriptPresentation: { source: "cache" as const, cloudCache: window.cloudCache } };
    expect(projectCloudPromptSession({ ...slot, transcriptState: "resident", transcriptPresentation: null }).messages).toEqual([message]);
    expect(projectCloudPromptSession({ ...slot, cloudOutbox: { rows: [], states: {}, pendingCount: 0, waiting: false } }).messages).toEqual([message]);
    expect(projectCloudPromptSession({ ...slot, cwd: "/fixture/local" }).messages).toEqual([message]);
  });

  it("rejects malformed native rows and does not duplicate or revive retired receipts", () => {
    expect(decodeNativeCloudTranscriptWindow({ range: { ...range, rows: [{ ...range.rows[0], payload: "{" }] }, pending }, owner, 3)).toBeNull();
    expect(decodeNativeCloudTranscriptWindow({ range: { ...range, rows: [{ ...range.rows[0], msgId: "wrong" }] }, pending }, owner, 3)).toBeNull();
    const retired = decodeNativeCloudTranscriptWindow({ range: { ...range, historyState: { revision: 2, beforeEpoch: "3" } }, pending }, owner, 3);
    expect(retired?.cloudCache?.receiptRows ?? []).toEqual([]);
    const duplicate = { ...pending, items: [{ ...pending.items[0], receipt: { ...pending.items[0].receipt, userMessageId: "native" },
      payload: { ...pending.items[0].payload!, userMessageId: "native" } }] };
    expect(decodeNativeCloudTranscriptWindow({ range, pending: duplicate }, owner, 3)?.cloudCache?.receiptRows ?? []).toEqual([]);
  });

  it("keeps the preceding prompt and bounds receipt presentation without changing native history", () => {
    const receipts = Array.from({ length: 204 }, (_, index) => ({ ...pending.items[0],
      receipt: { ...pending.items[0].receipt, userMessageId: `saved-${index}`, sequence: String(index + 1) },
      payload: { ...pending.items[0].payload!, userMessageId: `saved-${index}` },
    }));
    const opening = { ...message, id: "saved-203" };
    const window = decodeNativeCloudTranscriptWindow({ range: { ...range, historyState: { revision: 2, beforeEpoch: "2" },
      turnOpening: { msgId: opening.id, kind: opening.kind, payload: JSON.stringify(opening), createdAt: opening.createdAt } },
      pending: { ...pending, items: receipts } }, owner, 3)!;
    expect(window.leadingPrompt).toEqual(opening);
    expect(window.messages).toEqual([message]);
    expect(window.cloudCache?.revision).toBe(8);
    expect(window.historyState?.revision).toBe(2);
    expect(window.cloudCache?.receiptRows).toHaveLength(200);
    expect(window.cloudCache?.receiptRows?.some(row => row.id === opening.id)).toBe(false);
    expect(decodeNativeCloudTranscriptWindow({ range, pending: { ...pending, items: [{ ...pending.items[0], state: "completed" }] } }, owner, 3)?.cloudCache?.receiptRows ?? []).toEqual([]);
  });

  it("refreshes receipt presentation when the canonical cached messages are unchanged", () => {
    cloudTranscriptCache.bindOwner(owner, false);
    const first = decodeNativeCloudTranscriptWindow({ range, pending: null }, owner, 3)!;
    expect(presentCachedTranscript(chatId, first)).toBe(true);
    const second = decodeNativeCloudTranscriptWindow({ range, pending }, owner, 3)!;
    second.messages = first.messages;
    expect(presentCachedTranscript(chatId, second)).toBe(true);
    const slot = useSessionsStore.getState().sessions[chatId];
    expect(slot.messages).toBe(first.messages);
    expect(projectCloudPromptSession(slot).messages.map(row => row.id)).toEqual(["native", "queued"]);
  });
});

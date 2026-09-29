import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  invalidateTranscriptRequest,
  isCurrentTranscriptRequest,
  releaseTranscriptRequest,
  shouldEvictTranscriptPayload,
  canApplyTranscriptRead,
} from "../transcript-retention";
import { BLANK, useSessionsStore } from "../sessions-store";

const pins = (
  over: Partial<Parameters<typeof shouldEvictTranscriptPayload>[0]> = {},
) => ({
  retained: false,
  sending: false,
  queued: false,
  queueHeld: false,
  ensuring: false,
  ...over,
});

describe("transcript retention safety", () => {
  it("rejects a read overtaken by a complete live turn, even when the chat is ready again", () => {
    useSessionsStore.getState().clearAll();
    const before = { ...BLANK, status: "ready" as const, transcriptState: "resident" as const,
      executionId: "conversation:cloud-chat", sessionId: "conversation:cloud-chat" };
    useSessionsStore.getState().setSession("chat", before);
    const snapshot = useSessionsStore.getState().sessions.chat!;
    useSessionsStore.getState().patchSession("chat", { status: "streaming" });
    useSessionsStore.getState().patchSession("chat", { status: "ready", messages: [{
      id: "new-answer", kind: "text", role: "agent", text: "Complete live answer", createdAt: 1,
    }] });
    expect(canApplyTranscriptRead(snapshot, useSessionsStore.getState().sessions.chat)).toBe(false);
    expect(canApplyTranscriptRead(snapshot, { ...snapshot, error: null })).toBe(true);
    expect(canApplyTranscriptRead(snapshot, { ...snapshot, executionId: "new-execution" })).toBe(false);
    expect(canApplyTranscriptRead(snapshot, { ...snapshot, status: "streaming" })).toBe(false);
    expect(canApplyTranscriptRead(snapshot, { ...snapshot, transcriptState: "cold" })).toBe(false);
    expect(canApplyTranscriptRead(snapshot, undefined)).toBe(false);
    useSessionsStore.getState().clearAll();
  });
  it("never evicts one of the deck's retained chat payloads", () => {
    expect(shouldEvictTranscriptPayload(pins({ retained: true }))).toBe(false);
  });

  it("pins local operations that still read or mutate transcript objects", () => {
    expect(shouldEvictTranscriptPayload(pins({ sending: true }))).toBe(false);
    expect(shouldEvictTranscriptPayload(pins({ queued: true }))).toBe(false);
    expect(
      shouldEvictTranscriptPayload(pins({ queued: true, queueHeld: true })),
    ).toBe(false);
    expect(shouldEvictTranscriptPayload(pins({ ensuring: true }))).toBe(false);
  });

  it("evicts an unretained, unpinned payload even when its live session continues", () => {
    expect(shouldEvictTranscriptPayload(pins())).toBe(true);
  });

  it("invalidates a late exact-chat read without disturbing another chat or its replacement", () => {
    const oldA = Promise.resolve();
    const newA = Promise.resolve();
    const requestB = Promise.resolve();
    const requests = new Map([
      ["chat-a", oldA],
      ["chat-b", requestB],
    ]);

    invalidateTranscriptRequest(requests, "chat-a");
    expect(isCurrentTranscriptRequest(requests, "chat-a", oldA)).toBe(false);
    expect(isCurrentTranscriptRequest(requests, "chat-b", requestB)).toBe(true);

    requests.set("chat-a", newA);
    releaseTranscriptRequest(requests, "chat-a", oldA);
    expect(isCurrentTranscriptRequest(requests, "chat-a", newA)).toBe(true);
    releaseTranscriptRequest(requests, "chat-a", newA);
    expect(requests.has("chat-a")).toBe(false);
  });

  it("clears the retained deck only on unmount, not on context identity churn", () => {
    const source = readFileSync(
      resolve(process.cwd(), "apps/desktop/src/renderer/shell/conversation/chat-deck.tsx"),
      "utf8",
    );
    expect(source).toContain("setRetainedChatIdsRef");
    expect(source).toMatch(
      /useEffect\(\(\) => \(\) => setRetainedChatIdsRef\.current\(\[\]\), \[\]\)/,
    );
    expect(source).not.toContain(
      "useEffect(() => () => sessions.setRetainedChatIds([]), [sessions])",
    );
  });
});

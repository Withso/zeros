import { describe, expect, it } from "vitest";

import {
  invalidateTranscriptRequest,
  isCurrentTranscriptRequest,
  releaseTranscriptRequest,
  shouldEvictTranscriptPayload,
} from "../transcript-retention";

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
});

import { describe, expect, it, vi } from "vitest";
import { CloudLatencySpans } from "../cloud-latency";

describe("bounded cloud latency diagnostics", () => {
  it("uses a monotonic clock and emits only span, random operation id and elapsed time", () => {
    let now = 10;
    const emit = vi.fn();
    const spans = new CloudLatencySpans(emit, () => now);
    spans.begin("private-owner", "intent_history_visible", "private-chat");
    now = 32;
    spans.finish("private-owner", "intent_history_visible", "private-chat");
    expect(emit).toHaveBeenCalledWith({ span: "intent_history_visible", duration_ms: 22, operation_id: expect.any(String) });
    expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
    spans.finish("private-owner", "intent_history_visible", "private-chat");
    expect(emit).toHaveBeenCalledOnce();
  });
  it("never completes another chat/account/generation and cancels retired owners", () => {
    const emit = vi.fn(); const spans = new CloudLatencySpans(emit, () => 1);
    spans.begin("account-a:g1", "click_transcript_paint", "chat-a");
    spans.finish("account-a:g2", "click_transcript_paint", "chat-a");
    spans.finish("account-b:g1", "click_transcript_paint", "chat-a");
    spans.finish("account-a:g1", "click_transcript_paint", "chat-b");
    spans.pruneOwners(() => false);
    spans.finish("account-a:g1", "click_transcript_paint", "chat-a");
    expect(emit).not.toHaveBeenCalled();
  });
  it("bounds pending spans and samples, expires abandoned intents, and clears sign-out data", () => {
    let now = 0; const spans = new CloudLatencySpans(() => {}, () => now);
    for (let i = 0; i < 200; i++) spans.begin(`owner-${i}`, "intent_history_visible");
    expect(spans.pendingCount).toBe(128);
    now = 120_001;
    spans.finish("owner-199", "intent_history_visible");
    expect(spans.snapshot()).toEqual([]);
    for (let i = 0; i < 200; i++) {
      spans.begin("owner", "submit_first_text", "chat");
      now++;
      spans.finish("owner", "submit_first_text", "chat");
    }
    expect(spans.snapshot()).toHaveLength(128);
    spans.clear();
    expect(spans.pendingCount).toBe(0);
    expect(spans.snapshot()).toEqual([]);
  });
  it("preserves the first intent/submit anchor through duplicate events, but restarts a click", () => {
    let now = 1; const spans = new CloudLatencySpans(() => {}, () => now);
    const first = spans.begin("owner", "submit_first_text", "chat", true);
    now = 5;
    expect(spans.begin("owner", "submit_first_text", "chat", true)).toBe(first);
    spans.finish("owner", "submit_first_text", "chat");
    expect(spans.snapshot()[0].duration_ms).toBe(4);
    spans.begin("owner", "click_transcript_paint"); now = 10;
    spans.begin("owner", "click_transcript_paint"); now = 11;
    spans.finish("owner", "click_transcript_paint");
    expect(spans.snapshot()[1].duration_ms).toBe(1);
  });
});

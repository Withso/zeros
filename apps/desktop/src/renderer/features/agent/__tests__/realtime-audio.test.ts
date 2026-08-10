import { describe, expect, it, vi } from "vitest";

import {
  float32ToPcm16Base64,
  pcm16Base64ToChannels,
} from "../realtime-audio";
import {
  clearAllCodexRealtimeState,
  publishCodexRealtimeUpdate,
  realtimeStatusSnapshot,
  subscribeCodexRealtimeAudio,
} from "../realtime-voice-state";
import { collectRealtimeVoices } from "../realtime-voice-control";

describe("Codex realtime audio", () => {
  it("round-trips bounded interleaved PCM16 channels", () => {
    const encoded = float32ToPcm16Base64([
      new Float32Array([-1, 0, 1]),
      new Float32Array([0.5, -0.5, 0]),
    ]);
    const decoded = pcm16Base64ToChannels(encoded.data, 2);
    expect(encoded).toMatchObject({ samplesPerChannel: 3, numChannels: 2 });
    expect([...decoded[0]!]).toEqual(
      expect.arrayContaining([expect.closeTo(-1, 3), expect.closeTo(0, 3), expect.closeTo(1, 3)]),
    );
    expect(decoded[1]![0]).toBeCloseTo(0.5, 3);
    expect(decoded[1]![1]).toBeCloseTo(-0.5, 3);
  });

  it("keeps lifecycle state while delivering audio only to live subscribers", () => {
    clearAllCodexRealtimeState();
    const audio = vi.fn();
    const unsubscribe = subscribeCodexRealtimeAudio("chat-1", audio);
    publishCodexRealtimeUpdate("chat-1", {
      sessionUpdate: "realtime_status",
      threadId: "thread-1",
      status: "active",
    });
    publishCodexRealtimeUpdate("chat-1", {
      sessionUpdate: "realtime_audio",
      threadId: "thread-1",
      data: "AQI=",
      sampleRate: 24_000,
      numChannels: 1,
    });
    expect(realtimeStatusSnapshot("chat-1")).toMatchObject({ status: "active" });
    expect(audio).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("prefers the v2 voice catalog and removes malformed duplicates", () => {
    expect(
      collectRealtimeVoices({
        voices: { v1: ["echo"], v2: ["alloy", "alloy", 42, "marin"] },
      }),
    ).toEqual(["alloy", "marin"]);
  });
});

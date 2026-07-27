import { describe, expect, it } from "vitest";

import type { AgentMessage, AgentTextMessage } from "../use-agent-session";
import type { Turn } from "../turn-container";
import { stabilizeTurns } from "../stable-turns";

function text(id: string, value: string): AgentTextMessage {
  return {
    id,
    kind: "text",
    role: "agent",
    text: value,
    createdAt: 1,
  } as AgentTextMessage;
}

describe("stabilizeTurns", () => {
  it("reuses every unchanged historical turn and only replaces the streamed tail", () => {
    const prompt = text("prompt", "question");
    const settled = text("settled", "answer");
    const streaming = text("streaming", "a");
    const previous: Turn[] = [
      { userPrompt: prompt, events: [settled] },
      { userPrompt: null, events: [streaming] },
    ];
    const next: Turn[] = [
      { userPrompt: prompt, events: [settled] },
      {
        userPrompt: null,
        events: [text("streaming", "answer growing") as AgentMessage],
      },
    ];

    const stable = stabilizeTurns(previous, next);
    expect(stable[0]).toBe(previous[0]);
    expect(stable[1]).toBe(next[1]);
  });

  it("returns the prior array when grouping produced no semantic changes", () => {
    const event = text("event", "same");
    const previous: Turn[] = [{ userPrompt: null, events: [event] }];
    expect(
      stabilizeTurns(previous, [{ userPrompt: null, events: [event] }]),
    ).toBe(previous);
  });
});

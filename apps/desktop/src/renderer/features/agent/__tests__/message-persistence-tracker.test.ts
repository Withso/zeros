import { describe, expect, it } from "vitest";

import { messageSnapshotsEqual } from "../message-persistence-tracker";
import type { AgentMessage } from "../use-agent-session";

const message = (id: string, text = id): AgentMessage => ({
  id,
  kind: "text",
  role: "agent",
  text,
  createdAt: 1,
});

describe("message snapshot equality", () => {
  it("detects a cross-device edit that preserves message count and ids", () => {
    expect(
      messageSnapshotsEqual(
        [message("same-id", "before")],
        [message("same-id", "after")],
      ),
    ).toBe(false);
  });
});

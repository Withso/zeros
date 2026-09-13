import { expect, it } from "vitest";
import { synthesizeReplayPrompt } from "../replay";
import type { AgentTextMessage } from "../use-agent-session";

it("replays delivered conversation without silently submitting a queued message", () => {
  const message: AgentTextMessage = {
    id: "hi",
    kind: "text",
    role: "user",
    text: "hi",
    createdAt: 1,
  };
  const result = synthesizeReplayPrompt([
    message,
    { ...message, id: "queued", text: "delete the project", queued: true },
  ]);
  expect(result.text).toContain("<user>hi</user>");
  expect(result.text).not.toContain("delete the project");
  expect(result.messageCount).toBe(1);
});

import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage } from "../agent-messages";
import type { SessionNotification } from "../agent-events";

describe("persisted wake-up notices", () => {
  const notice: SessionNotification = { sessionId: "s", update: { sessionUpdate: "wakeup_notice", noticeId: "native-prompt", source: "loop_wakeup", reason: "Deployment still provisioning", scheduledFor: 1_800_000_000_000 } };
  it("folds an optional typed notice into readable commentary without a user or tool row", () => {
    const messages = applyUpdate([], notice);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "text", role: "agent", phase: "commentary", wakeupNotice: { source: "loop_wakeup", reason: "Deployment still provisioning", scheduledFor: 1_800_000_000_000 } });
    expect(messages[0]).toHaveProperty("text", expect.stringContaining("Deployment still provisioning"));
    expect(applyUpdate(messages, notice)).toBe(messages);
    expect(applyUpdate(JSON.parse(JSON.stringify(messages)), notice)).toEqual(messages);
  });
  it("preserves legacy snapshots and keeps adjacent assistant chunks separate", () => {
    const old: AgentMessage[] = [{ id: "old", kind: "text", role: "agent", text: "The deployment is pending.", createdAt: 1 }];
    const messages = applyUpdate(old, notice);
    const result = applyUpdate(messages, { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", messageId: "next", content: { type: "text", text: "Checking now." } } });
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(old[0]);
    expect(result[1]).toHaveProperty("wakeupNotice");
    expect(result[2]).toHaveProperty("text", "Checking now.");
  });
  it("uses plain generic fallback text when no job could be matched", () => {
    for (const [source, text] of [["loop_wakeup", "Woke up on schedule"], ["schedule_wakeup", "Scheduled task started"]] as const) {
      const messages = applyUpdate([], { sessionId: "s", update: { sessionUpdate: "wakeup_notice", noticeId: source, source } });
      expect(messages[0]).toMatchObject({ text, phase: "commentary" });
    }
  });
});

import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage, type AgentToolMessage } from "@zeros/protocol/agent-messages";
import { isTransientConnectionNotice, isUsageNotice, usageStatusChanges } from "../transcript-notices";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { latestAuthenticationRecoveryTurn } from "../auth-prompt-recovery";

const warning = "Claude is nearing its usage limit.";
const recovered = "Claude usage is available again.";
const notice = (id: string, type: string, message = warning): AgentMessage => ({
  id, kind: "error_notice", severity: "warning", recoverable: true,
  code: `claude-rate-limit:${type}`, message, createdAt: 1,
});
const shown = (events: AgentMessage[]) =>
  [...usageStatusChanges(events)].map(([id, row]) => [id, row.message]);

describe("transcript provider status", () => {
  it("recognizes legacy feedback by its persisted native messageId, not the renderer row id", () => {
    const messages = applyUpdate([], { sessionId: "legacy", update: {
      sessionUpdate: "agent_message_chunk", messageId: "claude-feedback-native", phase: "commentary",
      content: { type: "text", text: warning },
    } });
    expect(shown(messages)).toEqual([[messages[0].id, warning]]);
    // Legacy feedback renders as provider status, never assistant prose.
    expect(usageStatusChanges(messages).get(messages[0].id)).toMatchObject({ kind: "error_notice", code: "claude-rate-limit:legacy" });
    expect(latestAuthenticationRecoveryTurn([{ events: messages }])).toBe(-1);
  });

  it("shows each status change where it arrived and hides repeated identical receipts", () => {
    const hourly = notice("hourly", "five_hour");
    const events = [hourly, notice("hourly-again", "five_hour"), notice("hourly-third", "five_hour")];
    expect(shown(events)).toEqual([["hourly", warning]]);
    // An unchanged row keeps its native record identity for memoized rendering.
    expect(usageStatusChanges(events).get("hourly")).toBe(hourly);
    const restored = notice("hourly-recovered", "five_hour", recovered);
    expect(shown([...events, restored, notice("hourly-late", "five_hour")])).toEqual([
      ["hourly", warning], ["hourly-recovered", recovered], ["hourly-late", warning],
    ]);
  });

  it("keeps another budget's warning when one limit recovers, without duplicate identical rows", () => {
    const events = [notice("hourly", "five_hour"), notice("weekly", "seven_day"), notice("recovered", "five_hour", recovered)];
    expect(shown(events)).toEqual([["hourly", warning]]);
    expect(shown([...events, notice("weekly-recovered", "seven_day", recovered)])).toEqual([
      ["hourly", warning], ["weekly-recovered", recovered],
    ]);
  });

  it("states the remaining budget's warning at the recovery that revealed it", () => {
    const blocked = "Claude has reached its usage limit. Wait for the limit to reset before retrying.";
    const changes = usageStatusChanges([notice("hourly", "five_hour", blocked), notice("weekly", "seven_day"),
      notice("hourly-recovered", "five_hour", recovered)]);
    expect([...changes].map(([id, row]) => [id, row.message])).toEqual([["hourly", blocked], ["hourly-recovered", warning]]);
    expect(changes.get("hourly-recovered")).toMatchObject({ id: "hourly-recovered", code: "claude-rate-limit:seven_day" });
  });

  it("does not turn quoted model prose or child feedback into the parent's usage status", () => {
    const prose: AgentMessage = { id: "model-quote", kind: "text", role: "agent", text: warning, createdAt: 1 };
    const child = { ...notice("child", "five_hour"), parentToolId: "agent" };
    expect(isUsageNotice(prose)).toBe(false);
    expect(isUsageNotice(child)).toBe(false);
    expect(usageStatusChanges([prose, child]).size).toBe(0);
  });

  it("does not resolve sign-in from saved transport or routine wait bookkeeping", () => {
    const connection: AgentToolMessage = {
      id: "connection", kind: "tool", toolCallId: "connection", toolKind: "other",
      title: "Environment connected", status: "completed", createdAt: 1, updatedAt: 1,
      rawOutput: { environment: "native", state: "connected" },
    };
    const sleep: AgentToolMessage = {
      id: "wait", kind: "tool", toolCallId: "wait", nativeToolCallId: "native-wait", toolKind: "other",
      title: "Sleep", status: "completed", createdAt: 2, updatedAt: 3,
      rawInput: { type: "sleep", id: "native-wait", durationMs: 1000 },
      rawOutput: { type: "sleep", id: "native-wait", durationMs: 1000 },
    };
    expect(latestAuthenticationRecoveryTurn([{ events: [connection] }, { events: [sleep] }])).toBe(-1);
  });

  it.each(["/local/personal", "/local/organization", "cloud://organization/workspace"])(
    "requires actual parent output in the exact %s conversation before resolving authentication",
    folder => {
      const prompt: AgentMessage = { id: "same-prompt-id", kind: "text", role: "user", text: folder, createdAt: 1 };
      const failed: AgentMessage = { id: "auth", kind: "text", role: "agent", text: "Failed to authenticate: OAuth session expired", createdAt: 2 };
      const continued: AgentMessage = { ...prompt, id: "continue", text: "Continue", createdAt: 3 };
      const reply: AgentMessage = { id: "reply", kind: "text", role: "agent", text: "Checking the source.", createdAt: 4 };
      const idle = groupMessagesIntoTurns([prompt, failed, continued, notice("usage", "five_hour"), { ...reply, parentToolId: "child" }]);
      const recovered = groupMessagesIntoTurns([prompt, failed, continued, reply]);
      expect(latestAuthenticationRecoveryTurn(idle)).toBe(-1);
      expect(latestAuthenticationRecoveryTurn(recovered)).toBe(1);
      // Returning to an unrecovered conversation cannot reuse the other result.
      expect(latestAuthenticationRecoveryTurn(idle)).toBe(-1);
    },
  );
});

describe("transient connection notices", () => {
  const reconnect = (noticeId: string, code?: string) => applyUpdate([], { sessionId: "s", update: {
    sessionUpdate: "error_notice", noticeId, severity: "error", recoverable: true,
    message: "Connection lost — reconnecting…", ...(code ? { code } : {}),
  } })[0]!;

  it("treats reconnect progress as live status, not a lasting banner", () => {
    expect(isTransientConnectionNotice(reconnect("cursor-neterr-1", "connection_lost"))).toBe(true);
    expect(isTransientConnectionNotice(reconnect("retry-1", "api_retry"))).toBe(true);
    // Rows saved before the code existed keep their engine identity.
    expect(isTransientConnectionNotice(reconnect("cursor-neterr-legacy"))).toBe(true);
    expect(isTransientConnectionNotice(reconnect("claude-neterr-legacy"))).toBe(true);
  });

  it("keeps actionable warnings and failures as they are", () => {
    expect(isTransientConnectionNotice(reconnect("mcp-oauth-1", "mcp_oauth_failed"))).toBe(false);
    expect(isTransientConnectionNotice(notice("hourly", "five_hour"))).toBe(false);
    const child = reconnect("cursor-neterr-2", "connection_lost");
    expect(isTransientConnectionNotice({ ...child, parentToolId: "agent" } as AgentMessage)).toBe(false);
  });
});

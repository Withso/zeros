import { describe, it, expect } from "vitest";
import {
  applyUpdate,
  type AgentMessage,
  type AgentTextMessage,
  type AgentToolMessage,
} from "../agent-messages";
import type { SessionNotification } from "../agent-events";

// The live renderer and persist-on-emit engine share applyUpdate to fold
// streaming chunks into AgentMessages.
// These guard the streaming contract so the two can never drift.

function agentChunk(text: string, messageId?: string): SessionNotification {
  return {
    sessionId: "s",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  } as unknown as SessionNotification;
}

function userChunk(text: string, messageId?: string): SessionNotification {
  return {
    sessionId: "s",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  } as unknown as SessionNotification;
}

describe("applyUpdate — shared agent-message coalescer", () => {
  it("merges streaming chunks with the same messageId into one growing message", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, agentChunk("Hel", "m1"));
    msgs = applyUpdate(msgs, agentChunk("lo", "m1"));
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as AgentTextMessage).text).toBe("Hello");
  });

  it("starts a new message when the messageId differs (next turn)", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, agentChunk("first", "m1"));
    msgs = applyUpdate(msgs, agentChunk("second", "m2"));
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as AgentTextMessage).text).toBe("first");
    expect((msgs[1] as AgentTextMessage).text).toBe("second");
  });

  it("folds tool_call + tool_call_update onto a single tool message", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        status: "pending",
      },
    } as unknown as SessionNotification);
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      },
    } as unknown as SessionNotification);
    const tool = msgs.find((m) => m.kind === "tool") as
      | AgentToolMessage
      | undefined;
    expect(tool).toBeTruthy();
    expect(tool!.status).toBe("completed");
    expect(tool!.title).toBe("Read");
  });

  it("keeps the first terminal timestamp stable across late tool metadata", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "AskUserQuestion",
        status: "in_progress",
        at: 10,
      },
    } as unknown as SessionNotification);
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { vendor: "result" },
        at: 20,
      },
    } as unknown as SessionNotification);
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawOutput: { zerosQuestion: { outcome: "answered" } },
        at: 30,
      },
    } as unknown as SessionNotification);

    const tool = msgs[0] as AgentToolMessage;
    expect(tool.updatedAt).toBe(30);
    expect(tool.settledAt).toBe(20);
  });

  it("does not mutate the input array (pure reducer)", () => {
    const before: AgentMessage[] = [];
    const after = applyUpdate(before, agentChunk("x", "m1"));
    expect(before).toHaveLength(0);
    expect(after).toHaveLength(1);
  });

  // The engine keystone (persistUserPrompt) folds the prompt with NO messageId,
  // mirroring the renderer's speculative bubble; these guard that contract.
  it("coalesces a multi-block user prompt into one bubble", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, userChunk("part one ", undefined));
    msgs = applyUpdate(msgs, userChunk("part two", undefined));
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as AgentTextMessage).role).toBe("user");
    expect((msgs[0] as AgentTextMessage).text).toBe("part one part two");
  });

  it("an echoed user turn ADOPTS the speculative bubble (no duplicate)", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, userChunk("hello", undefined)); // synthetic (engine/renderer)
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as AgentTextMessage).messageId).toBeUndefined();
    msgs = applyUpdate(msgs, userChunk("hello", "u1")); // adapter echo, with id
    expect(msgs).toHaveLength(1); // adopted, not a second bubble
    expect((msgs[0] as AgentTextMessage).messageId).toBe("u1");
    expect((msgs[0] as AgentTextMessage).text).toBe("hello");
  });

  it("does not fold ephemeral safety retry ids into durable messages", () => {
    const before: AgentMessage[] = [];
    const after = applyUpdate(before, {
      sessionId: "s",
      update: {
        sessionUpdate: "safety_review_retry_available",
        toolCallId: "review-1",
        retryId: "opaque-retry",
      },
    });
    expect(after).toBe(before);
  });

  it("coalesces a duration-only thinking completion onto the existing row", () => {
    let msgs: AgentMessage[] = [];
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "checking" },
        messageId: "thought-1",
      },
    });
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "" },
        messageId: "thought-1",
        durationMs: 2_400,
      },
    });

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      kind: "text",
      role: "thought",
      text: "checking",
      durationMs: 2_400,
    });
  });
});

// Question-record durability (2026-07-04): the renderer stamps a resolution
// record (`zerosQuestion`) onto the AskUserQuestion tool message's rawOutput,
// and the vendor's tool_result lands milliseconds later — the update must not
// wipe the stamp. nativeToolCallId is what correlates the timeline row to the
// blocking QuestionRequest (which carries the VENDOR's id, not our uuid).
describe("applyUpdate — question tool-call identity + stamp durability", () => {
  it("copies nativeToolCallId from tool_call onto the message", () => {
    const msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "uuid-1",
        nativeToolCallId: "toolu_9",
        title: "AskUserQuestion",
        kind: "question",
        status: "in_progress",
      },
    } as unknown as SessionNotification);
    const tool = msgs[0] as AgentToolMessage;
    expect(tool.toolCallId).toBe("uuid-1");
    expect(tool.nativeToolCallId).toBe("toolu_9");
  });

  it("preserves the zerosQuestion stamp when a tool_result replaces rawOutput", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "AskUserQuestion",
        kind: "question",
        status: "in_progress",
      },
    } as unknown as SessionNotification);
    // Renderer stamps the resolution (out-of-band mutation, same shape the
    // sessions store writes).
    msgs = msgs.map((m) =>
      m.kind === "tool"
        ? {
            ...m,
            rawOutput: {
              zerosQuestion: { outcome: "answered", summary: "Redux" },
            },
          }
        : m,
    );
    // The vendor's tool_result lands right after — with its own rawOutput.
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { vendor: "result body" },
      },
    } as unknown as SessionNotification);
    const out = (msgs[0] as AgentToolMessage).rawOutput as Record<
      string,
      unknown
    >;
    expect(out.vendor).toBe("result body");
    expect((out.zerosQuestion as { outcome?: string }).outcome).toBe(
      "answered",
    );
  });

  it("keeps a NON-object vendor rawOutput alongside the stamp", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "AskUserQuestion",
        kind: "question",
        status: "in_progress",
      },
    } as unknown as SessionNotification);
    msgs = msgs.map((m) =>
      m.kind === "tool"
        ? { ...m, rawOutput: { zerosQuestion: { outcome: "skipped" } } }
        : m,
    );
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "plain text result",
      },
    } as unknown as SessionNotification);
    const out = (msgs[0] as AgentToolMessage).rawOutput as Record<
      string,
      unknown
    >;
    expect(out.output).toBe("plain text result");
    expect((out.zerosQuestion as { outcome?: string }).outcome).toBe("skipped");
  });

  it("a stamp-ONLY update overlays the existing vendor output (adapter settle after tool_result)", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "AskUserQuestion",
        kind: "question",
        status: "in_progress",
      },
    } as unknown as SessionNotification);
    // Vendor tool_result lands first…
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { vendor: "result body" },
      },
    } as unknown as SessionNotification);
    // …then the adapter's synthetic stamp update arrives late.
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawOutput: { zerosQuestion: { outcome: "answered", summary: "B" } },
      },
    } as unknown as SessionNotification);
    const out = (msgs[0] as AgentToolMessage).rawOutput as Record<
      string,
      unknown
    >;
    expect(out.vendor).toBe("result body");
    expect((out.zerosQuestion as { outcome?: string }).outcome).toBe(
      "answered",
    );
  });

  it("replaces rawOutput normally when no stamp exists (unchanged contract)", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        status: "in_progress",
        rawOutput: { old: true },
      },
    } as unknown as SessionNotification);
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { fresh: true },
      },
    } as unknown as SessionNotification);
    const out = (msgs[0] as AgentToolMessage).rawOutput as Record<
      string,
      unknown
    >;
    expect(out.fresh).toBe(true);
    expect(out.old).toBeUndefined();
  });
});

// error_notice (2026-07-04): adapter-level transient notices (Codex retry
// attempts, transport warnings) fold into ONE compact row per event — never
// appended into the agent's prose. Replays dedupe on noticeId.
describe("applyUpdate — error_notice rows", () => {
  it("appends one AgentErrorNoticeMessage per notice, deduped on noticeId", () => {
    let msgs = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "error_notice",
        noticeId: "t1-error-0",
        severity: "error",
        message: "Codex: Reconnecting… 2/5",
        recoverable: true,
      },
    } as unknown as SessionNotification);
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "error_notice",
        noticeId: "t1-error-1",
        severity: "error",
        message: "Codex: Reconnecting… 3/5",
      },
    } as unknown as SessionNotification);
    // Replayed duplicate of the first — must not duplicate the row.
    msgs = applyUpdate(msgs, {
      sessionId: "s",
      update: {
        sessionUpdate: "error_notice",
        noticeId: "t1-error-0",
        severity: "error",
        message: "Codex: Reconnecting… 2/5",
      },
    } as unknown as SessionNotification);
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.kind === "error_notice")).toBe(true);
    expect((msgs[0] as { message: string }).message).toContain("2/5");
    expect((msgs[0] as { recoverable: boolean }).recoverable).toBe(true);
    expect((msgs[1] as { message: string }).message).toContain("3/5");
  });

  it("ignores a notice with no id or message (defensive)", () => {
    const out = applyUpdate([], {
      sessionId: "s",
      update: {
        sessionUpdate: "error_notice",
        noticeId: "",
        severity: "warning",
        message: "",
      },
    } as unknown as SessionNotification);
    expect(out).toHaveLength(0);
  });
});

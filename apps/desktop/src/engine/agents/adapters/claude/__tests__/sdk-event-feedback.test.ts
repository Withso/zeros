import { describe, expect, it } from "vitest";
import { ClaudeStreamTranslator } from "../translator";
import type { SessionNotification } from "../../../types";

function setup() {
  const events: SessionNotification["update"][] = [];
  const t = new ClaudeStreamTranslator({
    sessionId: "session",
    emit: (n) => events.push(n.update),
  });
  const text = () =>
    events.filter((e) => e.sessionUpdate === "agent_message_chunk");
  return { t, events, text };
}
const system = (
  subtype: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "system",
  subtype,
  session_id: "native-session",
  uuid: `${subtype}-frame`,
  ...fields,
});
const tool = (id: string, parent?: string) => ({
  type: "assistant",
  parent_tool_use_id: parent ?? null,
  message: {
    content: [
      { type: "tool_use", id, name: "Bash", input: { command: "pwd" } },
    ],
  },
});

describe("Claude SDK lifecycle and feedback events", () => {
  it.each([
    system("informational", {
      level: "warning",
      content: "A hook prevented continuation.",
      prevent_continuation: true,
    }),
    system("notification", {
      key: "configuration",
      priority: "high",
      text: "Configuration needs attention.",
    }),
    system("model_refusal_no_fallback", {
      content: "The model declined this response.",
      original_model: "claude-opus-5",
      request_id: null,
    }),
  ])("preserves $subtype as one replay-safe inbetween message", (frame) => {
    const { t, events, text } = setup();
    t.feed(frame);
    t.feed(frame);
    expect(text()).toHaveLength(1);
    expect(text()[0]).toMatchObject({
      phase: "commentary",
      content: { type: "text", text: frame.content ?? frame.text },
    });
    expect(events.some((e) => e.sessionUpdate === "tool_call")).toBe(false);
    expect(t.sawResult).toBe(false);
  });

  it("updates a keyed notification in place without replacing another turn's notice", () => {
    const { t, text } = setup();
    t.beginTurn();
    t.feed(
      system("notification", {
        uuid: "n1",
        key: "download",
        priority: "medium",
        text: "Downloading…",
      }),
    );
    t.feed(
      system("notification", {
        uuid: "n2",
        key: "download",
        priority: "medium",
        text: "Download finished.",
      }),
    );
    expect(text()).toHaveLength(2);
    expect(text()[1]).toMatchObject({
      messageId: text()[0].messageId,
      textMode: "replace",
    });
    t.feed({ type: "result", uuid: "r1", subtype: "success" });
    t.beginTurn();
    t.feed(
      system("notification", {
        uuid: "n3",
        key: "download",
        priority: "medium",
        text: "Downloading…",
      }),
    );
    expect(text().at(-1)?.messageId).not.toBe(text()[0].messageId);
    const count = text().length;
    t.feed(
      system("notification", {
        uuid: "n1",
        key: "download",
        priority: "medium",
        text: "Downloading…",
      }),
    );
    expect(text()).toHaveLength(count);
  });

  it("shows hook failures once without dumping routine hook stdout or making a tool", () => {
    const { t, events, text } = setup();
    t.feed(
      system("hook_started", {
        hook_id: "hook",
        hook_name: "Validate",
        hook_event: "Stop",
      }),
    );
    t.feed(
      system("hook_progress", {
        hook_id: "hook",
        stdout: "raw diagnostic",
        output: "raw diagnostic",
      }),
    );
    expect(text()).toHaveLength(0);
    const failed = system("hook_response", {
      hook_id: "hook",
      hook_name: "Validate",
      hook_event: "Stop",
      outcome: "error",
      exit_code: 1,
      output: "Validation failed.",
      stdout: "",
      stderr: "",
    });
    t.feed(failed);
    t.feed(failed);
    expect(text()).toHaveLength(1);
    expect(text()[0].content).toMatchObject({
      text: expect.stringContaining("Validation failed."),
    });
    expect(events.some((e) => e.sessionUpdate === "tool_call")).toBe(false);
  });

  it("keeps a native denial inside the owning child without deciding the tool outcome", () => {
    const { t, events, text } = setup();
    t.feed(tool("child-tool", "parent"));
    const denied = system("permission_denied", {
      tool_use_id: "child-tool",
      tool_name: "Bash",
      agent_id: "child",
      message: "Permission denied by a rule.",
    });
    t.feed(denied);
    t.feed(denied);
    t.feed(tool("parent"));
    const parent = events.find(
      (e) => e.sessionUpdate === "tool_call" && e.nativeToolCallId === "parent",
    );
    expect(text()).toHaveLength(1);
    expect(
      events.some(
        (e) =>
          e.sessionUpdate === "message_parent_update" &&
          e.parentToolId === (parent as { toolCallId: string }).toolCallId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.sessionUpdate === "tool_call_update" && e.status === "failed",
      ),
    ).toBe(false);
  });

  it("does not guess a child owner from a reused native tool ID", () => {
    const { t, text } = setup();
    t.feed(tool("same", "a"));
    t.feed(tool("same", "b"));
    t.feed(
      system("permission_denied", {
        tool_use_id: "same",
        agent_id: "unknown-child",
        message: "Denied",
      }),
    );
    expect(text()).toHaveLength(0);
  });

  it("uses an explicit root scope instead of borrowing the only known child's tool", () => {
    const { t, text } = setup();
    t.feed(tool("same", "child"));
    t.feed({
      type: "tool_progress",
      uuid: "root-retry",
      tool_use_id: "same",
      parent_tool_use_id: null,
      subagent_retry: { agent_id: "root-agent", attempt: 1 },
    });
    expect(text()).toHaveLength(0);
    t.feed(tool("same"));
    expect(text()).toHaveLength(1);
    expect(text()[0].parentToolId).toBe(t.toolCallIdFor("same"));
  });

  it("does not publish deferred feedback after Stop or for a completed tool", () => {
    const { t, text } = setup();
    t.feed(
      system("permission_denied", { tool_use_id: "unseen", message: "Denied" }),
    );
    t.endActivity();
    t.beginTurn();
    t.feed(tool("unseen"));
    expect(text()).toHaveLength(0);
    t.feed({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "unseen", content: "Done" },
        ],
      },
    });
    t.feed({
      type: "tool_progress",
      uuid: "late-retry",
      tool_use_id: "unseen",
      parent_tool_use_id: null,
      subagent_retry: { agent_id: "agent", attempt: 1 },
    });
    expect(text()).toHaveLength(0);
  });

  it("keeps subagent retry feedback in its Agent group without restarting its parent", () => {
    const { t, events, text } = setup();
    t.beginTurn();
    t.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "agent",
            name: "Agent",
            input: { description: "Inspect" },
          },
        ],
      },
    });
    const parent = events.find((e) => e.sessionUpdate === "tool_call") as {
      toolCallId: string;
    };
    t.feed(system("session_state_changed", { state: "idle" }));
    t.feed({
      type: "tool_progress",
      uuid: "retry-1",
      tool_use_id: "agent",
      tool_name: "Agent",
      parent_tool_use_id: null,
      elapsed_time_seconds: 5,
      subagent_retry: {
        agent_id: "child",
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1000,
        error_status: 503,
        error_category: "server_error",
      },
    });
    expect(text()).toHaveLength(1);
    expect(text()[0]).toMatchObject({
      parentToolId: parent.toolCallId,
      phase: "commentary",
    });
    expect(
      events
        .filter((e) => e.sessionUpdate === "background_tasks_update")
        .at(-1),
    ).toMatchObject({ activity: { state: "idle" } });
  });

  it("does not narrate a late retry after the native task has finished", () => {
    const { t, text } = setup();
    t.feed({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "agent",
            name: "Agent",
            input: { description: "Inspect" },
          },
        ],
      },
    });
    t.feed(
      system("task_started", {
        task_id: "child",
        tool_use_id: "agent",
        description: "Inspect",
        task_type: "local_agent",
      }),
    );
    t.feed({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "agent", content: "Launched" },
        ],
      },
      tool_use_result: { status: "async_launched", agentId: "child" },
    });
    t.feed(
      system("task_notification", {
        task_id: "child",
        tool_use_id: "agent",
        status: "completed",
        output_file: "",
        summary: "Done",
      }),
    );
    const before = text().length;
    t.feed({
      type: "tool_progress",
      uuid: "late-child-retry",
      tool_use_id: "agent",
      parent_tool_use_id: null,
      subagent_retry: { agent_id: "child", attempt: 1 },
    });
    expect(text()).toHaveLength(before);
  });

  it("does not open another parent retry burst for request state or telemetry", () => {
    const { t, events } = setup();
    const retry = system("api_retry", { max_retries: 3, error_status: 503 });
    t.feed(retry);
    t.feed(system("status", { status: "requesting" }));
    t.feed({ type: "tool_progress", tool_use_id: "unknown", heartbeat: true });
    t.feed({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed" },
    });
    t.feed(retry);
    expect(
      events.filter((e) => e.sessionUpdate === "error_notice"),
    ).toHaveLength(1);
  });

  it("shows authentication progress without publishing raw authentication material or proving success", () => {
    const { t, events, text } = setup();
    t.feed({
      type: "auth_status",
      uuid: "auth-1",
      isAuthenticating: true,
      output: ["private callback fixture"],
    });
    t.feed({
      type: "auth_status",
      uuid: "auth-2",
      isAuthenticating: false,
      error: "private callback fixture",
      output: [],
    });
    expect(text()).toHaveLength(2);
    expect(text()[1]).toMatchObject({
      messageId: text()[0].messageId,
      textMode: "replace",
    });
    expect(JSON.stringify(events)).not.toContain("private callback fixture");
    expect(t.sawResult).toBe(false);
  });

  it("shows actionable rate-limit transitions once without classifying the whole turn as failed", () => {
    const { t, text } = setup();
    const frame = {
      type: "rate_limit_event",
      uuid: "limit-1",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
      },
    };
    t.feed(frame);
    t.feed({ ...frame, uuid: "limit-2" });
    expect(text()).toHaveLength(1);
    t.feed({
      ...frame,
      uuid: "limit-3",
      rate_limit_info: { ...frame.rate_limit_info, status: "rejected" },
    });
    expect(text()).toHaveLength(2);
    expect(t.sawResult).toBe(false);
  });

  it("does not advise stopping when subscription usage is exhausted but extra usage remains available", () => {
    const { t, text } = setup();
    t.feed({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", overageStatus: "allowed" },
    });
    expect(text()[0].content).toMatchObject({
      text: "Claude has reached its included usage limit. Extra usage is available.",
    });
    expect(t.sawResult).toBe(false);
  });

  it("keeps plugin installation failure separate from the overall completion", () => {
    const { t, text } = setup();
    t.feed(system("plugin_install", { uuid: "p1", status: "started" }));
    t.feed(
      system("plugin_install", {
        uuid: "p2",
        status: "failed",
        name: "Fixture plugin",
        error: "Package unavailable.",
      }),
    );
    t.feed(system("plugin_install", { uuid: "p3", status: "completed" }));
    expect(text()).toHaveLength(3);
    expect(text()[1].messageId).not.toBe(text()[2].messageId);
    expect(text()[1].content).toMatchObject({
      text: expect.stringContaining("Package unavailable."),
    });
  });

  it("bounds provider feedback and ignores malformed payloads", () => {
    const { t, text } = setup();
    t.feed(
      system("informational", {
        level: "warning",
        content: "x".repeat(100_000),
      }),
    );
    expect(text()).toHaveLength(1);
    expect(JSON.stringify(text()[0]).length).toBeLessThan(20_000);
    t.feed(system("informational", { uuid: "bad", content: { text: "bad" } }));
    expect(text()).toHaveLength(1);
  });

  it("rejects feedback with the wrong envelope and retains a valid refusal explanation", () => {
    const { t, text } = setup();
    t.feed({
      type: "informational",
      content: "Not an SDK informational event",
    });
    expect(text()).toHaveLength(0);
    t.feed(
      system("model_refusal_no_fallback", {
        content: {},
        api_refusal_explanation: "The request was declined.",
      }),
    );
    expect(text()[0].content).toMatchObject({
      text: "The request was declined.",
    });
  });

  it("keeps file persistence and external request feedback bounded, private, and nonterminal", () => {
    const { t, events, text } = setup();
    t.feed(system("files_persisted", { files: [], failed: [] }));
    expect(text()).toHaveLength(0);
    t.feed(
      system("files_persisted", {
        uuid: "failed-files",
        failed: [
          { filename: "private fixture path", error: "private fixture" },
        ],
      }),
    );
    t.feed(
      system("mirror_error", {
        error: "private fixture",
        key: { projectKey: "private fixture" },
      }),
    );
    t.feed(
      system("elicitation_complete", {
        mcp_server_name: "Workspace tools",
        elicitation_id: "request",
      }),
    );
    expect(text()).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain("private fixture");
    expect(t.sawResult).toBe(false);
    expect(events.some((e) => e.sessionUpdate === "tool_call")).toBe(false);
  });

  it.each(["result", "stop"])(
    "does not call unfinished compaction successful at %s",
    (ending) => {
      const { t, events } = setup();
      t.feed(system("status", { status: "compacting" }));
      if (ending === "result")
        t.feed({
          type: "result",
          uuid: "r",
          subtype: "error_during_execution",
          is_error: true,
        });
      else t.endActivity();
      expect(
        events.filter((e) => e.sessionUpdate === "tool_call_update").at(-1),
      ).toMatchObject({ status: "failed", title: "Compaction incomplete" });
      expect(
        events.some(
          (e) =>
            e.sessionUpdate === "tool_call_update" &&
            e.title === "Context compacted",
        ),
      ).toBe(false);
    },
  );

  it("does not replay a compaction boundary or let a late boundary revive stopped work", () => {
    const { t, events } = setup();
    const boundary = system("compact_boundary", {
      compact_metadata: { trigger: "auto", pre_tokens: 500 },
    });
    t.feed(boundary);
    t.feed(boundary);
    expect(events.filter((e) => e.sessionUpdate === "tool_call")).toHaveLength(
      1,
    );
    t.endActivity();
    t.feed({ ...boundary, uuid: "late" });
    expect(events.filter((e) => e.sessionUpdate === "tool_call")).toHaveLength(
      1,
    );
  });
});

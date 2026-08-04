// Tests for CodexAppServerTranslator — the spine of the new
// conversational adapter. Every notification the runtime fans out
// flows through this class; a regression here shows up as missing
// chat bubbles or stuck tool cards.
//
// Tests are shape-based, not snapshot-based — they assert the
// notification kind + the load-bearing fields and ignore generated
// ids / timestamps so the suite survives reasonable refactors.

import { describe, it, expect, beforeEach } from "vitest";

import { CodexAppServerTranslator } from "../app-server-translator";
import type { SessionNotification } from "../../../types";

function collect(): {
  emitted: SessionNotification[];
  unknown: Array<{ method: string; params: unknown }>;
  emit: (n: SessionNotification) => void;
  onUnknown: (method: string, params: unknown) => void;
} {
  const emitted: SessionNotification[] = [];
  const unknown: Array<{ method: string; params: unknown }> = [];
  return {
    emitted,
    unknown,
    emit: (n) => emitted.push(n),
    onUnknown: (method, params) => unknown.push({ method, params }),
  };
}

function build(): {
  t: CodexAppServerTranslator;
  out: ReturnType<typeof collect>;
} {
  const out = collect();
  const t = new CodexAppServerTranslator({
    sessionId: "test-session",
    emit: out.emit,
    onUnknown: out.onUnknown,
  });
  return { t, out };
}

describe("CodexAppServerTranslator", () => {
  let env: ReturnType<typeof build>;
  beforeEach(() => {
    env = build();
  });

  describe("thread lifecycle", () => {
    it("captures threadId from thread/started", () => {
      env.t.handle("thread/started", { thread: { id: "thr_abc123" } });
      expect(env.t.codexThreadId).toBe("thr_abc123");
      // Spec lifecycle events that aren't user-facing don't emit
      // anything visible to the chat.
      expect(env.out.emitted).toHaveLength(0);
    });

    it("treats turn/started as a no-op", () => {
      env.t.handle("turn/started", { threadId: "t1", turn: { id: "u1" } });
      expect(env.out.emitted).toHaveLength(0);
    });

    it("accepts aggregate diff and plan notifications without unknown-event noise", () => {
      env.t.handle("turn/diff/updated", {
        threadId: "t1",
        turnId: "u1",
        diff: "diff --git a/a.ts b/a.ts",
      });
      env.t.handle("turn/plan/updated", {
        threadId: "t1",
        turnId: "u1",
        explanation: null,
        plan: [{ step: "Fix it", status: "inProgress" }],
      });

      expect(env.out.unknown).toEqual([]);
      expect(env.out.emitted).toEqual([]);
    });

    it("turn/completed with status=completed sets stopReason=end_turn", () => {
      env.t.handle("turn/completed", {
        threadId: "t1",
        turn: { id: "u1", status: "completed" },
      });
      expect(env.t.sawTurnTerminal).toBe(true);
      expect(env.t.stopReason).toBe("end_turn");
    });

    it("turn/completed with status=interrupted sets stopReason=cancelled", () => {
      // Generated TurnStatus has no "cancelled" — a user abort is
      // "interrupted". (Was asserted with a fabricated "cancelled".)
      env.t.handle("turn/completed", {
        threadId: "t1",
        turn: { id: "u1", status: "interrupted" },
      });
      expect(env.t.sawTurnTerminal).toBe(true);
      expect(env.t.stopReason).toBe("cancelled");
    });

    it("turn/completed failed + codexErrorInfo=contextWindowExceeded → max_turn_requests", () => {
      env.t.handle("turn/completed", {
        threadId: "t1",
        turn: {
          id: "u1",
          status: "failed",
          error: { codexErrorInfo: "contextWindowExceeded" },
        },
      });
      expect(env.t.stopReason).toBe("max_turn_requests");
    });

    it("turn/completed failed + codexErrorInfo=unauthorized flags an auth failure", () => {
      env.t.handle("turn/completed", {
        threadId: "t1",
        turn: {
          id: "u1",
          status: "failed",
          error: { codexErrorInfo: "unauthorized" },
        },
      });
      // Generated TurnError carries the identity in codexErrorInfo, not a
      // non-existent `.code`; auth/quota is surfaced via authQuotaFailure.
      expect(env.t.authQuotaFailure).toContain("unauthorized");
    });

    it("startTurn() resets terminal + tool-call state without clearing threadId", () => {
      env.t.handle("thread/started", { thread: { id: "thr1" } });
      env.t.handle("turn/completed", {
        threadId: "t1",
        turn: { id: "u1", status: "completed" },
      });
      expect(env.t.sawTurnTerminal).toBe(true);
      env.t.startTurn();
      expect(env.t.sawTurnTerminal).toBe(false);
      expect(env.t.stopReason).toBe("end_turn");
      expect(env.t.codexThreadId).toBe("thr1");
    });
  });

  describe("agent message streaming", () => {
    it("agentMessage delta emits chunks with accumulated text", () => {
      env.t.handle("item/started", {
        item: { type: "agentMessage", id: "msg-1", text: "" },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "u1",
        itemId: "msg-1",
        delta: "Hello",
      });
      env.t.handle("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "u1",
        itemId: "msg-1",
        delta: " world",
      });

      const chunks = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      );
      expect(chunks).toHaveLength(2);
      const c0 = chunks[0].update as { content: { text: string } };
      const c1 = chunks[1].update as { content: { text: string } };
      expect(c0.content.text).toBe("Hello");
      expect(c1.content.text).toBe(" world");
    });

    it("reasoning textDelta emits agent_thought_chunk (not agent_message_chunk)", () => {
      env.t.handle("item/started", {
        item: { type: "reasoning", id: "rsn-1" },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/reasoning/textDelta", {
        threadId: "t1",
        turnId: "u1",
        itemId: "rsn-1",
        delta: "Thinking…",
      });
      const thoughts = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "agent_thought_chunk",
      );
      expect(thoughts).toHaveLength(1);
      // No agent_message_chunk should have been emitted from a
      // reasoning item.
      const messages = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      );
      expect(messages).toHaveLength(0);
    });

    it("item/completed with full text emits only the new suffix (dedup by length)", () => {
      env.t.handle("item/started", {
        item: { type: "agentMessage", id: "msg-2", text: "First" },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      // The "First" came in started. Now completed sends the full
      // accumulated text — should NOT re-emit "First".
      env.t.handle("item/completed", {
        item: { type: "agentMessage", id: "msg-2", text: "First and second" },
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 100,
      });
      const chunks = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "agent_message_chunk",
      );
      expect(chunks).toHaveLength(2);
      const c0 = chunks[0].update as { content: { text: string } };
      const c1 = chunks[1].update as { content: { text: string } };
      expect(c0.content.text).toBe("First");
      expect(c1.content.text).toBe(" and second");
    });
  });

  describe("tool-call lifecycle", () => {
    it("commandExecution: started → tool_call(execute, in_progress), completed exit 0 → completed", () => {
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "ls -la",
          cwd: "/tmp",
          exitCode: 0,
          aggregatedOutput: "file1\nfile2\n",
        },
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 100,
      });

      const calls = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const updates = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      expect(calls).toHaveLength(1);
      expect(updates).toHaveLength(1);
      const call = calls[0].update as {
        kind: string;
        status: string;
        title: string;
      };
      expect(call.kind).toBe("execute");
      expect(call.status).toBe("in_progress");
      expect(call.title).toMatch(/ls -la/);
      const update = updates[0].update as { status: string };
      expect(update.status).toBe("completed");
    });

    it("commandExecution exit != 0 → failed", () => {
      env.t.handle("item/started", {
        item: { type: "commandExecution", id: "cmd-2", command: "false" },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-2",
          command: "false",
          exitCode: 1,
        },
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 100,
      });
      const update = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      expect(update).toBeTruthy();
      expect((update!.update as { status: string }).status).toBe("failed");
    });

    it("commandExecution with a single read action → tool_call(read) + N-line content", () => {
      // Codex attaches `commandActions` (its own command parse) to every shell
      // item. A lone `sed`/`cat` should render as a Read card, not Bash —
      // parity with the Claude adapter's cards.
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-read",
          command: "sed -n '1,3p' README.md",
          commandActions: [
            {
              type: "read",
              command: "sed -n '1,3p' README.md",
              name: "README.md",
              path: "/repo/README.md",
            },
          ],
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const u = call!.update as {
        kind: string;
        title: string;
        rawInput: { file_path?: string };
      };
      expect(u.kind).toBe("read");
      expect(u.title).toMatch(/README\.md/);
      expect(u.rawInput.file_path).toBe("README.md");

      // Completion surfaces the output as a content block (drives the renderer's
      // "N lines" count) rather than only the {exitCode, output} rawOutput.
      env.t.handle("item/completed", {
        item: {
          type: "commandExecution",
          id: "cmd-read",
          command: "sed -n '1,3p' README.md",
          exitCode: 0,
          aggregatedOutput: "line1\nline2\nline3",
        },
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 100,
      });
      const upd = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      const content = (
        upd!.update as { content?: Array<{ content: { text: string } }> }
      ).content;
      expect(content?.[0]?.content.text).toBe("line1\nline2\nline3");
    });

    it("commandExecution with a search action → tool_call(search)", () => {
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-grep",
          command: "rg foo src",
          commandActions: [
            {
              type: "search",
              command: "rg foo src",
              query: "foo",
              path: "src",
            },
          ],
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const u = call!.update as { kind: string; rawInput: { query?: string } };
      expect(u.kind).toBe("search");
      expect(u.rawInput.query).toBe("foo");
    });

    it("commandExecution with a listFiles action → tool_call(list)", () => {
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-ls",
          command: "ls frontend",
          commandActions: [
            { type: "listFiles", command: "ls frontend", path: "frontend" },
          ],
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const u = call!.update as { kind: string; rawInput: { path?: string } };
      expect(u.kind).toBe("list");
      expect(u.rawInput.path).toBe("frontend");
    });

    it("compound command with an unknown fragment stays a Bash (execute) card", () => {
      // `pwd && rg --files`: pwd parses as unknown → no clean single action, so
      // it must remain a generic Bash row.
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-mixed",
          command: "pwd && rg --files",
          commandActions: [
            { type: "unknown", command: "pwd" },
            { type: "search", command: "rg --files", query: null, path: null },
          ],
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect((call!.update as { kind: string }).kind).toBe("execute");
    });

    it("commandExecution with no commandActions falls back to a Bash (execute) card", () => {
      // Backward-compat: older codex builds (or non-parsed commands) omit
      // commandActions entirely.
      env.t.handle("item/started", {
        item: {
          type: "commandExecution",
          id: "cmd-plain",
          command: "make build",
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const u = call!.update as { kind: string; title: string };
      expect(u.kind).toBe("execute");
      expect(u.title).toMatch(/make build/);
    });

    it("imageView emits a Read image tool with the image path", () => {
      env.t.handle("item/started", {
        item: {
          type: "imageView",
          id: "image-view-1",
          path: "/tmp/footer-diff-hover.png",
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });

      const call = env.out.emitted.find(
        (notification) => notification.update.sessionUpdate === "tool_call",
      );
      expect(call?.update).toMatchObject({
        title: "Read image",
        kind: "read",
        rawInput: { path: "/tmp/footer-diff-hover.png" },
      });
    });

    it("fileChange emits tool_call(edit) with mergeKey when path is present", () => {
      env.t.handle("item/started", {
        item: {
          type: "fileChange",
          id: "fc-1",
          changes: [{ path: "src/app.ts" }, { path: "src/lib.ts" }],
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect(call).toBeTruthy();
      const u = call!.update as {
        kind: string;
        mergeKey?: string;
        title: string;
      };
      expect(u.kind).toBe("edit");
      // mergeKey uses the first changed path so consecutive edits to
      // the same file collapse into one card.
      expect(u.mergeKey).toBe("edit:src/app.ts");
      expect(u.title).toMatch(/src\/app\.ts/);
    });

    it("mcpToolCall with error completes as failed", () => {
      env.t.handle("item/started", {
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "zeros",
          tool: "get_variant",
          arguments: { id: "v1" },
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/completed", {
        item: {
          type: "mcpToolCall",
          id: "mcp-1",
          server: "zeros",
          tool: "get_variant",
          arguments: { id: "v1" },
          error: { code: "not_found", message: "no variant" },
        },
        threadId: "t1",
        turnId: "u1",
        completedAtMs: 100,
      });
      const update = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      expect((update!.update as { status: string }).status).toBe("failed");
    });

    it("unknown item type still emits a generic tool_call so the UI shows it", () => {
      env.t.handle("item/started", {
        item: { type: "futureToolKind", id: "x-1" },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect(call).toBeTruthy();
      expect((call!.update as { kind: string }).kind).toBe("other");
    });

    it("request_user_input emits a question tool row even without item/started", () => {
      const params = {
        threadId: "t1",
        turnId: "u1",
        itemId: "ask-1",
        questions: [
          {
            id: "q0",
            header: "Choose",
            question: "Which button fix?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Behavior", description: "API and state" }],
          },
        ],
      };

      const toolCallId = env.t.emitUserInputToolCall(params);

      expect(toolCallId).toBeTruthy();
      expect(env.t.toolCallIdFor("ask-1")).toBe(toolCallId);
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect(call).toBeTruthy();
      const update = call!.update as {
        kind: string;
        nativeToolCallId?: string;
        rawInput?: unknown;
      };
      expect(update.kind).toBe("question");
      expect(update.nativeToolCallId).toBe("ask-1");
      expect(update.rawInput).toEqual(params);
    });

    it("request_user_input row is updated, not duplicated, if item/started arrives later", () => {
      env.t.emitUserInputToolCall({
        threadId: "t1",
        turnId: "u1",
        itemId: "ask-1",
        questions: [{ id: "q0", question: "Pick one" }],
      });

      env.t.handle("item/started", {
        item: {
          type: "dynamicToolCall",
          id: "ask-1",
          toolName: "request_user_input",
          arguments: { questions: [{ question: "Pick one" }] },
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });

      const calls = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      const updates = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      expect(calls).toHaveLength(1);
      expect(updates).toHaveLength(1);
      expect((updates[0].update as { toolCallId?: string }).toolCallId).toBe(
        (calls[0].update as { toolCallId?: string }).toolCallId,
      );
    });
  });

  describe("collab agent tool calls (codex multi-agent)", () => {
    it("spawnAgent emits kind=subagent with the prompt in rawInput", () => {
      env.t.handle("item/started", {
        item: {
          type: "collabAgentToolCall",
          id: "collab-1",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: "parent-thread",
          receiverThreadIds: [],
          prompt: "Survey the repository structure and report back.",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect(call).toBeTruthy();
      const update = call!.update as {
        kind: string;
        title: string;
        rawInput?: { prompt?: string };
      };
      expect(update.kind).toBe("subagent");
      // Title stays in the subagent-matcher vocabulary so the SubagentCard
      // recognizes the row and headers it with the prompt excerpt.
      expect(update.title).toBe("spawnAgent");
      expect(update.rawInput?.prompt).toBe(
        "Survey the repository structure and report back.",
      );
    });

    it("wait emits a human row title, and completion carries agentsStates", () => {
      env.t.handle("item/started", {
        item: {
          type: "collabAgentToolCall",
          id: "collab-2",
          tool: "wait",
          status: "inProgress",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["019f2e0c-f63c-7183-ae41-41ab54638eaa"],
          prompt: null,
          agentsStates: {},
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      const call = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      );
      expect((call!.update as { kind: string }).kind).toBe("other");
      expect((call!.update as { title: string }).title).toBe(
        "Waiting for agent 019f2e0c",
      );

      env.t.handle("item/completed", {
        item: {
          type: "collabAgentToolCall",
          id: "collab-2",
          tool: "wait",
          status: "completed",
          senderThreadId: "parent-thread",
          receiverThreadIds: ["019f2e0c-f63c-7183-ae41-41ab54638eaa"],
          prompt: null,
          agentsStates: {
            "019f2e0c-f63c-7183-ae41-41ab54638eaa": {
              status: "completed",
              message: "Repo map: …",
            },
          },
        },
        threadId: "t1",
        turnId: "u1",
      });
      const done = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      const doneUpdate = done!.update as {
        status: string;
        rawOutput?: unknown;
      };
      expect(doneUpdate.status).toBe("completed");
      expect(doneUpdate.rawOutput).toMatchObject({
        "019f2e0c-f63c-7183-ae41-41ab54638eaa": { status: "completed" },
      });
    });

    it("a failed collab call completes as failed", () => {
      env.t.handle("item/started", {
        item: {
          type: "collabAgentToolCall",
          id: "collab-3",
          tool: "closeAgent",
          status: "inProgress",
        },
        threadId: "t1",
        turnId: "u1",
        startedAtMs: 0,
      });
      env.t.handle("item/completed", {
        item: {
          type: "collabAgentToolCall",
          id: "collab-3",
          tool: "closeAgent",
          status: "failed",
        },
        threadId: "t1",
        turnId: "u1",
      });
      const done = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      );
      expect((done!.update as { status: string }).status).toBe("failed");
    });

    it("thread/status/changed is a known no-op (no unknown-notification log)", () => {
      env.t.handle("thread/status/changed", {
        threadId: "t1",
        status: "running",
      });
      expect(env.out.unknown).toHaveLength(0);
      expect(env.out.emitted).toHaveLength(0);
    });
  });

  describe("error + advisory notices", () => {
    // 2026-07-04: errors/advisories emit `error_notice` rows (one compact
    // timeline row per event), NOT agent_message_chunk prose — a retry burst
    // used to render as one run-on "⚠ Codex error: …⚠ Codex error: …" blob.
    it("error notification marks terminal + emits an error_notice row", () => {
      env.t.handle("error", {
        threadId: "t1",
        turnId: "u1",
        willRetry: false,
        error: {
          code: "invalid_request_error",
          message: JSON.stringify({
            error: { message: "model X is unavailable" },
          }),
        },
      });
      expect(env.t.sawTurnTerminal).toBe(true);
      const notice = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notice).toBeTruthy();
      const upd = notice!.update as {
        severity: string;
        message: string;
        noticeId: string;
      };
      expect(upd.severity).toBe("error");
      // The translator should have unwrapped the JSON-in-JSON envelope.
      expect(upd.message).toMatch(/model X is unavailable/);
      expect(upd.noticeId).toBeTruthy();
    });

    it("each error gets its OWN notice row (no run-on blob)", () => {
      env.t.handle("error", {
        error: { message: "Reconnecting… 2/5" },
      });
      env.t.handle("error", {
        error: { message: "Reconnecting… 3/5" },
      });
      const notices = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notices).toHaveLength(2);
      const ids = notices.map(
        (n) => (n.update as { noticeId: string }).noticeId,
      );
      expect(new Set(ids).size).toBe(2);
    });

    // 2026-07-10: retryable (willRetry:true) errors are no longer silent —
    // they surface ONE api_retry notice per burst (the renderer shows it as
    // the shimmering "Reconnecting agent" row while live), matching the
    // Claude translator's system/api_retry handling. Still never terminal.
    it("willRetry emits ONE api_retry notice per burst, never terminal", () => {
      env.t.handle("error", {
        willRetry: true,
        error: { message: "Reconnecting… 2/5" },
      });
      env.t.handle("error", {
        willRetry: true,
        error: { message: "Reconnecting… 3/5" },
      });
      expect(env.t.sawTurnTerminal).toBe(false);
      const notices = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notices).toHaveLength(1);
      const upd = notices[0].update as {
        severity: string;
        recoverable?: boolean;
        code?: string;
        message: string;
      };
      expect(upd.severity).toBe("warning");
      expect(upd.recoverable).toBe(true);
      // The renderer keys its live "Reconnecting agent" shimmer on this code.
      expect(upd.code).toBe("api_retry");
      expect(upd.message).toMatch(/retrying/i);
    });

    it("a new retry burst after item progress gets its own notice row", () => {
      env.t.handle("error", {
        willRetry: true,
        error: { message: "Reconnecting… 2/5" },
      });
      // The retried call got through — an item streams.
      env.t.handle("item/started", {
        item: { id: "i-1", type: "agentMessage", text: "" },
      });
      // A second blip later in the same turn.
      env.t.handle("error", {
        willRetry: true,
        error: { message: "Reconnecting… 2/5" },
      });
      const notices = env.out.emitted.filter(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notices).toHaveLength(2);
      const ids = notices.map(
        (n) => (n.update as { noticeId: string }).noticeId,
      );
      expect(new Set(ids).size).toBe(2);
    });

    it("filters the benign WebSocket-to-HTTPS fallback advisory", () => {
      env.t.handle("warning", {
        message:
          "Falling back from WebSockets to HTTPS transport. request timed out.",
      });
      expect(
        env.out.emitted.some((n) => n.update.sessionUpdate === "error_notice"),
      ).toBe(false);
    });

    it("keeps actionable warnings as warning-tier notice rows", () => {
      env.t.handle("warning", {
        message: "The selected model is deprecated",
      });
      const notice = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notice).toBeTruthy();
      const upd = notice!.update as { severity: string; message: string };
      expect(upd.severity).toBe("warning");
      expect(upd.message).toMatch(/deprecated/);
    });

    it("deprecationNotice surfaces a warning-tier notice row", () => {
      env.t.handle("deprecationNotice", {
        message: "feature codex_hooks renamed to hooks",
      });
      const notice = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "error_notice",
      );
      expect(notice).toBeTruthy();
      const upd = notice!.update as { severity: string; message: string };
      expect(upd.severity).toBe("warning");
      expect(upd.message).toMatch(/Deprecation/);
    });
  });

  describe("context compaction → two-state tool row", () => {
    // §3.5 design rev 2: "Compacting.." while the item runs → "Context
    // compacted" + Done chip when it settles. Kind `compaction` routes the
    // renderer to CompactionRecordCard.
    it("item/started renders 'Compacting..' with kind compaction", () => {
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-1" },
        threadId: "t1",
        turnId: "u1",
      });
      const started = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      )!.update as { title: string; kind: string; status: string };
      expect(started.title).toBe("Compacting..");
      expect(started.kind).toBe("compaction");
      expect(started.status).toBe("in_progress");
    });

    it("item/completed relabels the SAME row to 'Context compacted'", () => {
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-1" },
        threadId: "t1",
        turnId: "u1",
      });
      env.t.handle("item/completed", {
        item: { type: "contextCompaction", id: "cc-1" },
        threadId: "t1",
        turnId: "u1",
      });
      const started = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call",
      )!.update as { toolCallId: string };
      const settled = env.out.emitted.find(
        (n) => n.update.sessionUpdate === "tool_call_update",
      )!.update as { toolCallId: string; title?: string; status: string };
      expect(settled.toolCallId).toBe(started.toolCallId); // same row
      expect(settled.title).toBe("Context compacted");
      expect(settled.status).toBe("completed");
    });

    // 2026-07-12 user spec: user-initiated compaction (Compact now /
    // /compact → adapter arms expectManualCompaction before the RPC)
    // renders STANDALONE; codex's own auto-compactions stay grouped.
    it("stamps rawInput.trigger 'auto' by default and 'manual' after expectManualCompaction", () => {
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-auto" },
        threadId: "t1",
        turnId: "u1",
      });
      env.t.expectManualCompaction();
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-manual" },
        threadId: "t1",
        turnId: "u1",
      });
      const rows = env.out.emitted
        .filter((n) => n.update.sessionUpdate === "tool_call")
        .map((n) => n.update as { rawInput?: { trigger?: string } });
      expect(rows.map((r) => r.rawInput?.trigger)).toEqual(["auto", "manual"]);
    });

    it("the manual flag is one-shot (a later compaction reverts to auto), and disarm cancels it", () => {
      env.t.expectManualCompaction();
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-1" },
        threadId: "t1",
        turnId: "u1",
      });
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-2" },
        threadId: "t1",
        turnId: "u1",
      });
      env.t.expectManualCompaction();
      env.t.disarmManualCompaction(); // rejected RPC path
      env.t.handle("item/started", {
        item: { type: "contextCompaction", id: "cc-3" },
        threadId: "t1",
        turnId: "u1",
      });
      const rows = env.out.emitted
        .filter((n) => n.update.sessionUpdate === "tool_call")
        .map((n) => n.update as { rawInput?: { trigger?: string } });
      expect(rows.map((r) => r.rawInput?.trigger)).toEqual([
        "manual",
        "auto",
        "auto",
      ]);
    });
  });

  describe("token usage → usage_update (context gauge)", () => {
    // §3.5 Task B: `used` must be the CURRENT WINDOW FILL (last call's full
    // prompt + its output), not the lifetime thread total — the total only
    // ever climbs, so the gauge would read ~90% on a freshly-compacted,
    // mostly-empty window.
    it("emits window fill (last.input+output), not the cumulative total", () => {
      env.t.handle("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: {
            totalTokens: 178_340,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 0,
            inputTokens: 44_000,
            cachedInputTokens: 40_000,
            outputTokens: 2_200,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_000,
        },
      });
      expect(env.out.emitted).toHaveLength(1);
      const upd = env.out.emitted[0].update as {
        sessionUpdate: string;
        size: number;
        used: number;
      };
      expect(upd.sessionUpdate).toBe("usage_update");
      expect(upd.used).toBe(46_200); // 44k prompt + 2.2k output — NOT 178,340
      expect(upd.size).toBe(258_000);
    });

    it("uses last.totalTokens for the post-compaction re-report (input/output are 0)", () => {
      // Wire-verified (codex 0.144.1): after thread/compact/start the
      // update carries the NEW window fill only in last.totalTokens —
      // input/output are 0 because no inference ran. Summing the parts
      // made the gauge read a false ZERO right after compacting.
      env.t.handle("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: {
            totalTokens: 28_803,
            inputTokens: 28_680,
            cachedInputTokens: 24_064,
            outputTokens: 123,
            reasoningOutputTokens: 17,
          },
          last: {
            totalTokens: 4_298,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 353_400,
        },
      });
      const upd = env.out.emitted[0].update as { used: number; size: number };
      expect(upd.used).toBe(4_298); // the compacted fill — not 0, not 28,803
      expect(upd.size).toBe(353_400);
    });

    it("the reading DROPS across a compaction (next call's prompt shrinks)", () => {
      const fill = (inputTokens: number) => ({
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: {
            totalTokens: 999_999,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 0,
            inputTokens,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_000,
        },
      });
      env.t.handle("thread/tokenUsage/updated", fill(238_000)); // near-full
      env.t.handle("thread/tokenUsage/updated", fill(46_000)); // post-compaction
      const reads = env.out.emitted.map(
        (n) => (n.update as { used: number }).used,
      );
      expect(reads).toEqual([238_000, 46_000]);
    });

    it("falls back to the cumulative total when `last` is absent", () => {
      env.t.handle("thread/tokenUsage/updated", {
        threadId: "t1",
        turnId: "u1",
        tokenUsage: {
          total: { totalTokens: 12_345 },
          modelContextWindow: null,
        },
      });
      const upd = env.out.emitted[0].update as { used: number; size: number };
      expect(upd.used).toBe(12_345);
      expect(upd.size).toBe(0);
    });
  });

  describe("forward compatibility", () => {
    it("dispatches account/* notifications without surfacing them as bubbles", () => {
      env.t.handle("account/updated", {
        authMode: "chatgpt",
        planType: "plus",
      });
      env.t.handle("account/rateLimits/updated", { snapshots: [] });
      // The translator deliberately swallows account events — the
      // adapter owns the auth/usage UI, not the chat stream.
      expect(env.out.emitted).toHaveLength(0);
    });

    it("calls onUnknown for methods the translator doesn't model", () => {
      env.t.handle("remoteControl/status/changed", {
        status: "disabled",
      });
      expect(env.out.unknown).toHaveLength(1);
      expect(env.out.unknown[0].method).toBe("remoteControl/status/changed");
    });
  });
});

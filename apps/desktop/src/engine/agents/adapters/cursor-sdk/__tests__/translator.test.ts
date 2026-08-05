// Tests for the @cursor/sdk SDKMessage → SessionNotification translator
// Pure translation logic — no SDK or credential required.

import { describe, it, expect } from "vitest";
import { CursorSdkTranslator } from "../translator";
import type { SessionNotification } from "../../../types";
import type { ParsedSubagentTranscript } from "../subagent-transcript";

function capture() {
  const out: SessionNotification[] = [];
  const t = new CursorSdkTranslator({
    sessionId: "s1",
    emit: (n) => out.push(n),
  });
  return { t, out };
}
const updates = (out: SessionNotification[]) => out.map((n) => n.update);

describe("CursorSdkTranslator", () => {
  it("maps assistant text blocks to agent_message_chunk (coalesced id)", () => {
    const { t, out } = capture();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    const u = updates(out);
    expect(u).toHaveLength(2);
    expect(u[0]).toMatchObject({ sessionUpdate: "agent_message_chunk" });
    // Both chunks share one synthesized messageId so the UI coalesces them.
    expect((u[0] as { messageId: string }).messageId).toBe(
      (u[1] as { messageId: string }).messageId,
    );
  });

  it("maps thinking to agent_thought_chunk", () => {
    const { t, out } = capture();
    t.feed({ type: "thinking", text: "pondering" });
    expect(updates(out)[0]).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
    });
  });

  it("opens an in_progress card on tool_call running, then completes it", () => {
    const { t, out } = capture();
    t.feed({
      type: "tool_call",
      call_id: "c1",
      name: "readToolCall",
      status: "running",
      args: { path: "a.ts" },
    });
    t.feed({
      type: "tool_call",
      call_id: "c1",
      name: "readToolCall",
      status: "completed",
      result: { success: {} },
    });
    const u = updates(out);
    expect(u[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "read",
      status: "in_progress",
    });
    expect(u[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    // Same toolCallId across the two so the card updates in place.
    expect((u[0] as { toolCallId: string }).toolCallId).toBe(
      (u[1] as { toolCallId: string }).toolCallId,
    );
  });

  it("maps error status to a failed tool card", () => {
    const { t, out } = capture();
    t.feed({
      type: "tool_call",
      call_id: "c2",
      name: "shellToolCall",
      status: "running",
      args: { command: "ls" },
    });
    t.feed({
      type: "tool_call",
      call_id: "c2",
      name: "shellToolCall",
      status: "error",
      result: { error: "boom" },
    });
    const u = updates(out);
    expect(u[0]).toMatchObject({ kind: "execute", status: "in_progress" });
    expect(u[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "failed",
    });
  });

  it("does not double-open when assistant tool_use precedes the tool_call message", () => {
    const { t, out } = capture();
    t.feed({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "c3",
            name: "editToolCall",
            input: { path: "x.ts" },
          },
        ],
      },
    });
    t.feed({
      type: "tool_call",
      call_id: "c3",
      name: "editToolCall",
      status: "running",
      args: { path: "x.ts" },
    });
    const opens = updates(out).filter((u) => u.sessionUpdate === "tool_call");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ kind: "edit", mergeKey: "edit:x.ts" });
  });

  it("tracks stop reasons from status messages", () => {
    const a = capture();
    a.t.feed({ type: "status", status: "FINISHED" });
    expect(a.t.sawTerminal).toBe(true);
    expect(a.t.stopReason).toBe("end_turn");

    const b = capture();
    b.t.feed({ type: "status", status: "CANCELLED" });
    expect(b.t.stopReason).toBe("cancelled");
  });

  it("flags an in-band ERROR/EXPIRED status via sawError (so the adapter can fail the turn)", () => {
    const a = capture();
    expect(a.t.sawError).toBe(false);
    a.t.feed({ type: "status", status: "ERROR" });
    expect(a.t.sawTerminal).toBe(true);
    expect(a.t.sawError).toBe(true);

    const b = capture();
    b.t.feed({ type: "status", status: "EXPIRED" });
    expect(b.t.sawError).toBe(true);

    // A normal finish must NOT flag an error.
    const c = capture();
    c.t.feed({ type: "status", status: "FINISHED" });
    expect(c.t.sawError).toBe(false);
  });

  it("captures the ERROR/EXPIRED status message as errorDetail", () => {
    const a = capture();
    a.t.feed({
      type: "status",
      status: "ERROR",
      message: "Rate limit exceeded",
    });
    expect(a.t.sawError).toBe(true);
    expect(a.t.errorDetail).toBe("Rate limit exceeded");

    const b = capture();
    b.t.feed({ type: "status", status: "EXPIRED", message: "Session expired" });
    expect(b.t.errorDetail).toBe("Session expired");
  });

  it("leaves errorDetail null when the ERROR status carries no message", () => {
    const { t } = capture();
    t.feed({ type: "status", status: "ERROR" });
    expect(t.sawError).toBe(true);
    expect(t.errorDetail).toBeNull();
  });

  it("ignores user echoes and tolerates unknown message types", () => {
    const { t, out } = capture();
    t.feed({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    t.feed({ type: "bogus_future_type" });
    expect(out).toHaveLength(0);
  });

  // ── Subagent (`task` tool) internals ─────────────────────────
  // Cursor runs subagents as a black box: no live stream, `conversationSteps`
  // empty in local mode — the child's tool calls live in its on-disk transcript
  // (read via the injected loadSubagentTranscript). The translator DEFERS the
  // read to flushSubagents() (after the run ends, so the file is flushed) and
  // emits the steps as parentToolId-tagged children + the report as the answer.

  /** Updates tagged as children of `parentId` (tool calls / text / thinking). */
  const childrenOf = (out: SessionNotification[], parentId: string) =>
    updates(out).filter(
      (u) => (u as { parentToolId?: string }).parentToolId === parentId,
    );
  /** The report surfaced as the parent task card's answer (a content-bearing
   *  tool_call_update on the parent toolCallId). */
  const answerOf = (
    out: SessionNotification[],
    parentId: string,
  ): string | undefined => {
    const withContent = updates(out).find(
      (u) =>
        u.sessionUpdate === "tool_call_update" &&
        (u as { toolCallId?: string }).toolCallId === parentId &&
        (u as { content?: unknown }).content,
    ) as { content?: Array<{ content: { text: string } }> } | undefined;
    return withContent?.content?.[0]?.content.text;
  };

  /** Run a `task` subagent via the conversationSteps fallback (no transcript
   *  reader), flushing afterwards as the adapter does. */
  const subagentRun = (
    steps: unknown[],
    extraValue: Record<string, unknown> = {},
  ) => {
    const { t, out } = capture();
    t.feed({
      type: "tool_call",
      call_id: "t1",
      name: "task",
      status: "running",
      args: {
        description: "Explore",
        prompt: "do it",
        subagentType: { kind: "explore" },
      },
    });
    t.feed({
      type: "tool_call",
      call_id: "t1",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: {
          isBackground: false,
          backgroundReason: "agentRequest",
          conversationSteps: steps,
          ...extraValue,
        },
      },
    });
    t.flushSubagents();
    return {
      out,
      parentId: (updates(out)[0] as { toolCallId: string }).toolCallId,
    };
  };

  it("lifts a subagent's conversationSteps into parentToolId-tagged children", () => {
    const { out, parentId } = subagentRun([
      { type: "thinkingMessage", message: { text: "Let me look" } },
      {
        type: "toolCall",
        message: {
          type: "read",
          args: { path: "a.ts" },
          result: {
            status: "success",
            value: { content: "l1\nl2", totalLines: 2 },
          },
        },
      },
      {
        type: "toolCall",
        message: {
          type: "shell",
          args: { command: "ls" },
          result: {
            status: "success",
            value: {
              exitCode: 0,
              signal: "",
              stdout: "a.ts",
              stderr: "",
              executionTime: 5,
            },
          },
        },
      },
      { type: "toolCall", message: { type: "grep", args: { pattern: "foo" } } },
      { type: "assistantMessage", message: { text: "Here is the summary." } },
    ]);
    const u = updates(out);
    expect(u[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "task",
      status: "in_progress",
    });
    expect(u[1]).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    const children = childrenOf(out, parentId);
    expect(children).toHaveLength(4); // thinking + read + shell + grep (trailing answer held back)
    expect(children[0]).toMatchObject({ sessionUpdate: "agent_thought_chunk" });
    expect(children[1]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "read",
    });
    expect(children[2]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "execute",
    });
    expect(children[3]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "search",
    });
  });

  it("surfaces the trailing assistant message as the card's answer (not duplicated as a child)", () => {
    const { out, parentId } = subagentRun([
      { type: "toolCall", message: { type: "read", args: { path: "a.ts" } } },
      { type: "assistantMessage", message: { text: "Final answer." } },
    ]);
    expect(answerOf(out, parentId)).toBe("Final answer.");
    // The answer must NOT also appear as an agent_message_chunk child.
    expect(
      childrenOf(out, parentId).some(
        (c) => c.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(false);
  });

  it("falls back to resultSuffix when the subagent has no assistant message", () => {
    const { out, parentId } = subagentRun(
      [{ type: "toolCall", message: { type: "read", args: { path: "a.ts" } } }],
      { resultSuffix: "Done exploring." },
    );
    expect(answerOf(out, parentId)).toBe("Done exploring.");
  });

  it("maps a subagent edit step to an edit card with a diff", () => {
    const { out, parentId } = subagentRun([
      {
        type: "toolCall",
        message: {
          type: "edit",
          args: { path: "x.ts" },
          result: {
            status: "success",
            value: {
              diffString: "@@ -1 +1 @@\n-a\n+b",
              linesAdded: 1,
              linesRemoved: 1,
            },
          },
        },
      },
    ]);
    const child = childrenOf(out, parentId)[0] as {
      kind: string;
      rawInput: { path: string; diff: string };
    };
    expect(child).toMatchObject({ sessionUpdate: "tool_call", kind: "edit" });
    expect(child.rawInput.path).toBe("x.ts");
    expect(child.rawInput.diff).toContain("@@");
  });

  it("does not emit children for the legacy {success} result shape (backward compat)", () => {
    const { out, parentId } = (() => {
      const { t, out } = capture();
      t.feed({
        type: "tool_call",
        call_id: "t2",
        name: "task",
        status: "running",
        args: { description: "x", prompt: "y" },
      });
      t.feed({
        type: "tool_call",
        call_id: "t2",
        name: "task",
        status: "completed",
        result: { success: { text: "old shape" } },
      });
      t.flushSubagents();
      return {
        out,
        parentId: (updates(out)[0] as { toolCallId: string }).toolCallId,
      };
    })();
    expect(childrenOf(out, parentId)).toHaveLength(0); // no internals
    expect(answerOf(out, parentId)).toBe("old shape"); // but the report still surfaces
  });

  // ── Transcript path (the real local-SDK source) ──────────────
  // Cursor leaves conversationSteps empty in local mode; the subagent's tool
  // calls live in its on-disk transcript, read via the injected
  // loadSubagentTranscript (keyed by the agentId on the task args), at flush.

  it("streams subagent tool calls LIVE via pollSubagents, then narration + report at flush", () => {
    const out: SessionNotification[] = [];
    let visibleTools = 1; // simulate the transcript growing tool-by-tool
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: () => ({
        steps: [
          { type: "text", text: "Exploring" }, // narration (held for flush)
          ...Array.from({ length: visibleTools }, (_, i) => ({
            type: "tool" as const,
            toolKind: "read",
            title: "Read",
            status: "completed" as const,
            rawInput: { path: `f${i}.ts` },
          })),
        ],
        finalText: "# Report",
      }),
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x", prompt: "y", agentId: "sub-1" },
    });
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    const toolChildren = () =>
      childrenOf(out, parentId).filter((c) => c.sessionUpdate === "tool_call");

    t.pollSubagents(); // sees 1 tool
    expect(toolChildren()).toHaveLength(1);
    visibleTools = 2;
    t.pollSubagents(); // sees 2 — emits ONLY the new one (deduped)
    expect(toolChildren()).toHaveLength(2);
    // narration is NOT streamed live — only tools.
    expect(
      childrenOf(out, parentId).some(
        (c) => c.sessionUpdate === "agent_message_chunk",
      ),
    ).toBe(false);

    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: { status: "success" },
    });
    t.flushSubagents();
    expect(toolChildren()).toHaveLength(2); // no dup of the live-streamed tools
    expect(
      childrenOf(out, parentId).filter(
        (c) => c.sessionUpdate === "agent_message_chunk",
      ),
    ).toHaveLength(1); // narration now
    expect(answerOf(out, parentId)).toBe("# Report");
  });

  it("defers the read to flushSubagents — nothing until the run ends", () => {
    const out: SessionNotification[] = [];
    let reads = 0;
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: () => {
        reads++;
        return {
          steps: [
            {
              type: "tool",
              toolKind: "read",
              title: "Read",
              status: "completed",
              rawInput: { path: "a.ts" },
            },
          ],
          finalText: "",
        };
      },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x", prompt: "y", agentId: "sub-1" },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: { status: "success" },
    });
    expect(reads).toBe(0); // NOT read during streaming (avoids the write race)
    t.flushSubagents();
    expect(reads).toBe(1); // read after the run ends
  });

  it("prefers the on-disk transcript over conversationSteps and keys by the task agentId", () => {
    const out: SessionNotification[] = [];
    const seen: string[] = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: (agentId) => {
        seen.push(agentId);
        return {
          steps: [
            { type: "thought", text: "thinking" },
            {
              type: "tool",
              toolKind: "read",
              title: "Read",
              status: "completed",
              rawInput: { path: "a.ts" },
            },
            {
              type: "tool",
              toolKind: "search",
              title: "Grep",
              status: "completed",
              rawInput: { pattern: "x" },
            },
          ],
          finalText: "# Report",
        };
      },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "Explore", prompt: "go", agentId: "sub-123" },
    });
    // The result carries conversationSteps, but the transcript must WIN.
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: {
          isBackground: false,
          conversationSteps: [
            {
              type: "toolCall",
              message: { type: "glob", args: { globPattern: "**/*" } },
            },
          ],
        },
      },
    });
    t.flushSubagents();
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    expect(seen).toEqual(["sub-123"]); // located by the task agentId
    expect(answerOf(out, parentId)).toBe("# Report"); // transcript final text
    const children = childrenOf(out, parentId);
    expect(children).toHaveLength(3); // thought + read + grep; the conversationStep glob must NOT appear
    expect(children[0]).toMatchObject({ sessionUpdate: "agent_thought_chunk" });
    expect(children[1]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "read",
    });
    expect(children[2]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "search",
    });
  });

  it("falls back to conversationSteps when the transcript is unavailable", () => {
    const out: SessionNotification[] = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: () => null, // no transcript on disk
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x", prompt: "y", agentId: "sub-9" },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: {
          isBackground: false,
          conversationSteps: [
            {
              type: "toolCall",
              message: { type: "read", args: { path: "a.ts" } },
            },
          ],
          resultSuffix: "done",
        },
      },
    });
    t.flushSubagents();
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    const children = childrenOf(out, parentId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      sessionUpdate: "tool_call",
      kind: "read",
    });
  });

  // ── Live discovery (the real shape: agentId only at completion) ──────
  // Cursor does NOT put the subagent agentId on the running-leg task args — it
  // assigns it internally and echoes it only in the task RESULT at completion.
  // So `pollSubagents()` learns the agentId mid-run by matching the prompt we
  // sent against the on-disk transcripts (discoverSubagentAgentId), THEN streams.
  // Without this, an entry with no agentId is invisible and nothing shows until
  // flush — the "subagent tools only appear after it's done" bug.

  it("discovers a running subagent by prompt (agentId absent on the running leg) and streams it LIVE", () => {
    const out: SessionNotification[] = [];
    const discoverCalls: Array<{ prompt: string; claimed: string[] }> = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: (agentId) =>
        agentId === "disc-1"
          ? {
              steps: [
                {
                  type: "tool",
                  toolKind: "read",
                  title: "Read",
                  status: "completed",
                  rawInput: { path: "a.ts" },
                },
              ],
              finalText: "# Report",
            }
          : null,
      discoverSubagentAgentId: (prompt, claimed) => {
        discoverCalls.push({ prompt, claimed: [...claimed] });
        return prompt.includes("explore the codebase") ? "disc-1" : null;
      },
    });
    // NOTE: no agentId on the running-leg args — the realistic shape.
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: {
        description: "Explore",
        prompt: "Please explore the codebase thoroughly",
      },
    });
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    const toolChildren = () =>
      childrenOf(out, parentId).filter((c) => c.sessionUpdate === "tool_call");

    expect(toolChildren()).toHaveLength(0); // nothing before the first poll
    t.pollSubagents(); // discovers disc-1 by prompt, then streams its tool LIVE
    expect(discoverCalls).toHaveLength(1);
    expect(discoverCalls[0].prompt).toContain("explore the codebase");
    expect(toolChildren()).toHaveLength(1);
  });

  it("discovers + streams LIVE even when the running-leg args carry NO prompt", () => {
    // The realistic Cursor shape: the streamed `task` args omit the prompt (it
    // streams via partial-tool-call). Discovery must still run — keyed on the
    // recency fallback (here the injected resolver returns the active agentId) —
    // or nothing streams until the run ends (the reported bug).
    const out: SessionNotification[] = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: (agentId) =>
        agentId === "by-recency"
          ? {
              steps: [
                {
                  type: "tool",
                  toolKind: "search",
                  title: "Grep",
                  status: "completed",
                  rawInput: { pattern: "x" },
                },
              ],
              finalText: "",
            }
          : null,
      // No prompt → the adapter's findSubagentByPrompt resolves by recency; the
      // mock stands in for "the most-recently-active transcript".
      discoverSubagentAgentId: (prompt) =>
        prompt === "" ? "by-recency" : null,
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "Explore" },
    });
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    t.pollSubagents();
    expect(
      childrenOf(out, parentId).filter((c) => c.sessionUpdate === "tool_call"),
    ).toHaveLength(1);
  });

  it("prefers the result's transcriptPath over agentId-based resolution at flush", () => {
    const out: SessionNotification[] = [];
    const byPath: string[] = [];
    const byId: string[] = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: (id) => {
        byId.push(id);
        return { steps: [], finalText: "from-id" };
      },
      loadSubagentTranscriptByPath: (p) => {
        byPath.push(p);
        return {
          steps: [
            {
              type: "tool",
              toolKind: "read",
              title: "Read",
              status: "completed",
              rawInput: { path: "a.ts" },
            },
          ],
          finalText: "from-path",
        };
      },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x", prompt: "y" },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: {
          agentId: "a-1",
          transcriptPath: "/abs/sub.jsonl",
          finalMessage: "done",
        },
      },
    });
    t.flushSubagents();
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    expect(byPath).toEqual(["/abs/sub.jsonl"]); // exact path from the result is used
    expect(byId).toEqual([]); // agentId resolution NOT consulted (path won)
    expect(answerOf(out, parentId)).toBe("from-path");
  });

  it("uses result.value.finalMessage as the report when no transcript/conversationSteps exist", () => {
    const out: SessionNotification[] = [];
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: () => null,
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x", prompt: "y" },
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: { agentId: "a-1", finalMessage: "The final report." },
      },
    });
    t.flushSubagents();
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    expect(answerOf(out, parentId)).toBe("The final report.");
  });

  it("re-emits the authoritative transcript in full when a live guess streamed the WRONG file", () => {
    // Concurrent, promptless subagents: live discovery resolves by recency and
    // can pick the wrong transcript. The completion names the real one
    // (transcriptPath), which is authoritative — flush must re-emit THAT file's
    // tools in full, NOT skip its leading N using a count taken from the wrong
    // file (the dropped-leading-tools bug).
    const out: SessionNotification[] = [];
    const wrong: ParsedSubagentTranscript = {
      steps: [
        {
          type: "tool",
          toolKind: "read",
          title: "Read",
          status: "completed",
          rawInput: { path: "wrong.ts" },
        },
      ],
      finalText: "",
    };
    const right: ParsedSubagentTranscript = {
      steps: [
        {
          type: "tool",
          toolKind: "search",
          title: "Grep",
          status: "completed",
          rawInput: { pattern: "a" },
        },
        {
          type: "tool",
          toolKind: "search",
          title: "Grep",
          status: "completed",
          rawInput: { pattern: "b" },
        },
      ],
      finalText: "# Right report",
    };
    const t = new CursorSdkTranslator({
      sessionId: "s1",
      emit: (n) => out.push(n),
      loadSubagentTranscript: (id) =>
        id === "wrong" ? wrong : id === "right" ? right : null,
      loadSubagentTranscriptByPath: (p) =>
        p === "/abs/right.jsonl" ? right : null,
      discoverSubagentAgentId: () => "wrong", // recency guesses the WRONG file
    });
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "running",
      args: { description: "x" },
    });
    const parentId = (updates(out)[0] as { toolCallId: string }).toolCallId;
    const toolChildren = () =>
      childrenOf(out, parentId).filter((c) => c.sessionUpdate === "tool_call");

    t.pollSubagents(); // discovers "wrong" by recency, streams its 1 tool LIVE
    expect(toolChildren()).toHaveLength(1);

    // Completion names the REAL transcript — authoritative over the live guess.
    t.feed({
      type: "tool_call",
      call_id: "tt",
      name: "task",
      status: "completed",
      result: {
        status: "success",
        value: { agentId: "right", transcriptPath: "/abs/right.jsonl" },
      },
    });
    t.flushSubagents();

    // BOTH of the right file's tools must appear (skip reset to 0 on the source
    // change) — never just its tail. 1 (wrong, already live) + 2 (right) = 3.
    expect(toolChildren()).toHaveLength(3);
    expect(answerOf(out, parentId)).toBe("# Right report");
  });
});

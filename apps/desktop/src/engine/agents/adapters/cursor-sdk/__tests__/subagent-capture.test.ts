import { describe, expect, it, vi } from "vitest";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import { CursorSdkTranslator } from "../translator";
import { parseSubagentTranscript } from "../subagent-transcript";
import type { TranscriptCapture } from "../subagent-transcript-reader";

const child = (text: string) => parseSubagentTranscript(JSON.stringify({
  role: "assistant", message: { id: "child-text", content: [{ type: "text", text }] },
}));

describe("Cursor child capture notices and ownership", () => {
  function setup(read: (identity: { agentId?: string }, final: boolean) => Promise<TranscriptCapture>) {
    let messages: AgentMessage[] = [];
    const translator = new CursorSdkTranslator({ sessionId: "session",
      emit: (event) => { messages = applyUpdate(messages, event); }, readSubagentTranscript: read });
    translator.feed({ type: "tool_call", call_id: "task", name: "task", status: "running",
      args: { agentId: "child", description: "Inspect files" } });
    return { translator, messages: () => messages };
  }

  it.each(["unavailable", "truncated"] as const)("shows %s once as child commentary and retains success/report", async (captureIssue) => {
    const { translator, messages } = setup(async () => ({ ...child("Captured details"), captureIssue }));
    await translator.pollSubagents();
    await translator.pollSubagents();
    translator.feed({ type: "tool_call", call_id: "task", name: "task", status: "completed",
      result: { case: "success", value: { agentId: "child", finalMessage: "Native report" } } });
    await translator.flushSubagents();
    const notice = captureIssue === "truncated" ? "Subagent details were truncated." : "Some subagent details could not be loaded.";
    expect(messages().filter((row) => row.kind === "text" && row.text === notice)).toEqual([
      expect.objectContaining({ kind: "text", phase: "commentary", parentToolId: messages()[0].id.replace(/^tool-/, "") }),
    ]);
    expect(messages()[0]).toMatchObject({ kind: "tool", status: "completed" });
    expect(messages()[0]).toMatchObject({ content: [
      { type: "content", content: { type: "text", text: "Native report" } },
    ] });
  });

  it("discards an in-flight live read when Stop revokes publication", async () => {
    let resolve!: (value: TranscriptCapture) => void;
    let current = true;
    const { translator, messages } = setup(() => new Promise((done) => { resolve = done; }));
    const poll = translator.pollSubagents(() => current);
    current = false;
    resolve(child("Late details"));
    await poll;
    await translator.flushSubagents({ readFinal: false });
    expect(messages().filter((row) => row.kind === "text")).toEqual([]);
  });

  it("keeps the confirmed child report as output when commentary follows it", async () => {
    const { translator, messages } = setup(async () => ({ ...child("Native report"), captureIssue: "unavailable" }));
    await translator.pollSubagents();
    translator.feed({ type: "tool_call", call_id: "task", name: "task", status: "completed",
      result: { case: "success", value: { agentId: "child", finalMessage: "Native report" } } });
    await translator.flushSubagents();
    expect(messages().filter((row) => row.kind === "text" && row.text === "Native report")).toEqual([
      expect.objectContaining({ phase: "final_answer" }),
    ]);
  });

  it("discards a late read when the native child identity changed", async () => {
    let resolve!: (value: TranscriptCapture) => void;
    const { translator, messages } = setup(() => new Promise((done) => { resolve = done; }));
    const poll = translator.pollSubagents();
    translator.feed({ type: "tool_call", call_id: "task", name: "task", status: "completed",
      result: { case: "success", value: { agentId: "corrected-child", finalMessage: "Native report" } } });
    resolve(child("Wrong child"));
    await poll;
    expect(messages().some((row) => row.kind === "text" && row.text === "Wrong child")).toBe(false);
  });

  it("stops final capture immediately while still settling unresolved tools", async () => {
    let resolve!: (value: TranscriptCapture) => void;
    let cancelled = false;
    const { translator, messages } = setup(() => new Promise((done) => { resolve = done; }));
    const finish = translator.flushSubagents({ canReadFinal: () => !cancelled });
    cancelled = true;
    resolve({ ...child("Late final details"), captureIssue: "unavailable" });
    await finish;
    expect(messages().filter((row) => row.kind === "text")).toEqual([]);
    expect(messages()[0]).toMatchObject({ status: "pending", rawOutput: { _zerosToolCompletion: "unreported" } });
  });

  it("coalesces live polls and bounds finalization when a read stalls", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: TranscriptCapture) => void;
      const read = vi.fn(() => new Promise<TranscriptCapture>((done) => { resolve = done; }));
      const { translator, messages } = setup(read);
      const poll = translator.pollSubagents();
      expect(translator.pollSubagents()).toBe(poll);
      expect(read).toHaveBeenCalledTimes(1);
      const finish = translator.flushSubagents();
      await vi.advanceTimersByTimeAsync(2001);
      await finish;
      const length = messages().length;
      resolve(child("Too late"));
      await poll;
      await translator.flushSubagents();
      expect(messages()).toHaveLength(length);
      expect(messages().filter((row) => row.kind === "text")).toEqual([
        expect.objectContaining({ text: "Some subagent details could not be loaded." }),
      ]);
    } finally { vi.useRealTimers(); }
  });
});

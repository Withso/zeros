import { describe, expect, it } from "vitest";
import { applyUpdate, type AgentMessage, type AgentTextMessage } from "@zeros/protocol/agent-messages";
import { partitionTurn, partitionTurnSequence } from "../turn-partition";
import { isProviderWorkEvent } from "../transcript-notices";
import { countEventSummary, formatEventSummary } from "../renderers/tool-summary";
import { formatTranscript } from "../transcript-format";
import { settledFirstPromptForTitle } from "../chat-title";
import { isLocalLiveTextAppend } from "../local-live-text";
import { BLANK } from "../sessions-store";

const notice = () => applyUpdate([], { sessionId: "s", update: { sessionUpdate: "wakeup_notice", noticeId: "wake", source: "loop_wakeup", reason: "Deployment still provisioning", scheduledFor: 1_800_000_017_000 } })[0] as AgentTextMessage;
const prompt: AgentTextMessage = { id: "prompt", kind: "text", role: "user", text: "Watch deployment", createdAt: 1 };
const answer: AgentTextMessage = { id: "answer", kind: "text", role: "agent", text: "Deployment is ready.", createdAt: 5 };
const tools: AgentMessage[] = ["read", "execute"].map((kind, index) => ({ id: `tool-${index}`, kind: "tool", toolCallId: `tool-${index}`, title: kind === "read" ? "Read" : "Bash", toolKind: kind, status: "completed", rawInput: kind === "read" ? { file_path: "/tmp/status" } : { command: "check-status" }, createdAt: 3 + index } as AgentMessage));

describe("wake-up status in the working feed", () => {
  it("holds a notice at the idle tail until work resumes, preserving the settled answer and waiting layout", () => {
    const previous = { ...answer, phase: "final_answer" as const };
    const wake = notice();
    expect(partitionTurnSequence([previous, wake], { live: false })).toEqual([
      { kind: "output", key: previous.id, events: [previous] },
    ]);
    expect(partitionTurnSequence([previous, wake, ...tools, answer], { live: false })).toEqual([
      { kind: "output", key: previous.id, events: [previous] },
      { kind: "working", key: wake.id, events: [wake, ...tools] },
      { kind: "output", key: answer.id, events: [answer] },
    ]);
    expect(partitionTurnSequence([previous, wake], { live: true }).at(-1)?.events).toEqual([wake]);
  });
  it("does not prove model recovery after a failed attempt", () => {
    expect(isProviderWorkEvent(notice())).toBe(false);
  });
  it.each(["/personal/project", "/organization/project", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"])("never smooths a notice into assistant live text in %s", cwd => {
    const wake = notice();
    const before = { ...BLANK, cwd, status: "streaming" as const, transcriptState: "resident" as const, hasTranscript: true, messages: [prompt, wake] };
    const after = { ...before, messages: [prompt, { ...wake, text: `${wake.text} updated` }] };
    expect(isLocalLiveTextAppend(before, after)).toBe(false);
  });
  it("folds the notice with the work and leaves the chip's tool count unchanged", () => {
    const wake = notice(), events = [wake, ...tools, answer];
    expect(partitionTurn(events).working).toEqual([wake, ...tools]);
    expect(partitionTurn(events).finalOutput).toEqual([answer]);
    expect(countEventSummary([wake, ...tools])).toEqual({ toolCalls: 2, agents: 0, messages: 0 });
    expect(formatEventSummary(countEventSummary([wake, ...tools]))).toBe("2 tool calls");
    expect(partitionTurn(events, { live: true }).working[0]).toBe(wake);
  });
  it.each([undefined, "final_answer"] as const)("never treats status metadata as output even with legacy phase %s", phase => {
    const wake = { ...notice(), phase };
    expect(partitionTurn([wake]).finalOutput).toEqual([]);
    expect(formatTranscript([prompt, wake], "concise").text).not.toContain("Woke up");
  });
  it("excludes the notice from copied output but retains it in the full activity transcript", () => {
    const messages = [prompt, notice(), ...tools, answer];
    expect(formatTranscript(messages, "concise").text).toContain(answer.text);
    expect(formatTranscript(messages, "concise").text).not.toContain("Woke up");
    expect(formatTranscript(messages, "full").text).toContain("Deployment still provisioning");
    expect(formatTranscript(messages, "full").text).toContain("## Status");
  });
  it("does not trigger a title or replace the first prompt with a preamble notice", () => {
    expect(settledFirstPromptForTitle({ status: "streaming", messages: [prompt, notice()] })).toBeNull();
    expect(settledFirstPromptForTitle({ status: "ready", messages: [notice(), prompt, answer] })).toEqual({ messageId: "prompt", prompt: "Watch deployment" });
  });
});

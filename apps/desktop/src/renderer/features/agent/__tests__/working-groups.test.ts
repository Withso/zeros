// Working groups: which prose sits between the runs, when a run is a
// group, the span its header reports, and what the live loader line shows.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolMessage } from "../use-agent-session";
import { isInBetweenMessage, partitionTurn, partitionTurnSequence, type TurnSegment } from "../turn-partition";
import { gatedEventIds, handedOffCall, isWorkingGroup, loaderLineSubject, rowsAboveLoader, settledLoaderLine, workingGroupSpan } from "../working-group";

vi.mock("dompurify", () => ({
  default: { addHook: vi.fn(), sanitize: (value: string) => value },
}));
vi.mock("@/renderer/shared/ui/loading", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/renderer/shared/ui/loading")>(),
  ActivityShimmer: ({ bare, subject }: { bare?: boolean; subject?: { key: string } | null }) =>
    `LOADER(${bare ? "bare" : subject?.key ?? "timer"})`,
}));
const setting = vi.hoisted(() => ({ on: true }));
vi.mock("../../settings/in-between-messages", () => ({ useShowInBetweenMessages: () => setting.on }));

import { TurnEventList } from "../turn-event-list";
import type { RendererContext } from "../renderers";
import { MessageView } from "../renderers/message-view";
import { eventShowsFailure } from "../renderers/tool-failure";
import { LoaderLineLabel } from "../loader-line";

const tool = (id: string, overrides: Partial<AgentToolMessage> = {}): AgentToolMessage => ({
  kind: "tool", id, toolCallId: id, title: "Bash", toolKind: "execute", status: "completed",
  rawInput: { command: `run ${id}` }, rawOutput: { exitCode: 0, output: "ok" },
  createdAt: 10, updatedAt: 20, settledAt: 20, ...overrides,
});
const text = (id: string, value: string, overrides: Partial<Extract<AgentMessage, { kind: "text" }>> = {}): AgentMessage =>
  ({ kind: "text", role: "agent", id, text: value, createdAt: 30, ...overrides }) as AgentMessage;
const ids = (segments: TurnSegment[]) =>
  segments.map((segment) => `${segment.inBetween ? "between" : segment.kind}:${segment.events.map((event) => event.id).join(",")}`);

describe("in-between messages", () => {
  it.each([
    ["Claude phase-less prose between tool calls", text("claude", "Reading the partition next.")],
    ["Codex commentary", text("codex", "I'll inspect the tests.", { phase: "commentary" })],
    ["Codex plan item, emitted as commentary", text("plan", "1. Read\n2. Edit", { phase: "commentary", messageId: "turn-plan-1" })],
    ["Codex async delivery, emitted as commentary", text("async", "Still checking CI.", { phase: "commentary" })],
    ["Cursor assistant text between steps", text("cursor", "Found the renderer.", { messageId: "cursor-msg-1" })],
  ])("counts %s", (_, event) => {
    expect(isInBetweenMessage(event)).toBe(true);
  });

  it.each([
    ["a Claude runtime feedback row", text("claude-feedback-1", "Hook finished.", { phase: "commentary" })],
    ["a Claude usage notice", text("claude-feedback-2", "Claude is nearing its usage limit.", { phase: "commentary" })],
    ["a legacy sign-in notice", text("auth", "Failed to authenticate. API Error: 401")],
    ["a Codex unsupported-verification notice", text("verify", "Codex requested identity verification, which this version of Zeros cannot complete.",
      { phase: "commentary", messageId: "3f1c-unsupported-verification:req-7" })],
    ["a Codex partial answer", text("partial", "First pass done.", { phase: "partial_answer" })],
    ["a final answer", text("final", "Done.", { phase: "final_answer" })],
    ["a wake-up notice", text("wake", "Woke up", { wakeupNotice: { reason: "background" } as never })],
    ["a local note", text("note", "Chat finished", { localNote: { event: "done" } as never })],
    ["model fallback prose", text("fallback", "Switched models", { modelFallback: { provider: "claude", toModel: "x", reason: "refusal" } as never })],
    ["a summary divider", text("summary", "Summary", { summaryBoundary: true })],
    ["a resumed-session divider", text("resume", "Continuing session", { resumeBoundary: true })],
    ["a retracted fragment", text("retracted", "", { retracted: true })],
    ["an empty fragment", text("empty", "  ")],
    ["sub-agent narration", text("child", "Child prose", { parentToolId: "agent" })],
    ["thinking", text("thought", "Hmm", { role: "thought" })],
    ["a tool call", tool("tool")],
  ])("excludes %s", (_, event) => {
    expect(isInBetweenMessage(event)).toBe(false);
  });
});

describe("rendering sequence", () => {
  const events: AgentMessage[] = [
    tool("a"), text("m1", "Reading next."), tool("b"), tool("c"),
    text("partial", "First pass done.", { phase: "partial_answer" }), tool("d"), text("answer", "All done."),
  ];

  it("puts in-between messages outside the runs while live", () => {
    expect(ids(partitionTurnSequence(events, { live: true, inBetweenOutside: true }))).toEqual([
      "working:a", "between:m1", "working:b,c", "output:partial", "working:d", "between:answer",
    ]);
  });

  it("keeps them outside once settled with the setting on, and the trailing answer becomes output", () => {
    expect(ids(partitionTurnSequence(events, { inBetweenOutside: true }))).toEqual([
      "working:a", "between:m1", "working:b,c", "output:partial", "working:d", "output:answer",
    ]);
  });

  it("folds them back into the runs with the setting off; confirmed answers stay outside", () => {
    expect(ids(partitionTurnSequence(events, {}))).toEqual([
      "working:a,m1,b,c", "output:partial", "working:d", "output:answer",
    ]);
  });

  it("keeps segment keys from live to settled, and the first run's key when runs merge", () => {
    const live = partitionTurnSequence(events, { live: true, inBetweenOutside: true });
    const on = partitionTurnSequence(events, { inBetweenOutside: true }, live);
    expect(on.map((segment) => segment.key)).toEqual(live.map((segment) => segment.key));
    const off = partitionTurnSequence(events, {}, live);
    expect(off[0].key).toBe(live[0].key);
  });

  it("leaves partitionTurn unchanged", () => {
    expect(partitionTurn(events).working.map((event) => event.id)).toEqual(["a", "m1", "b", "c", "d"]);
  });
});

describe("group threshold, span and gated rows", () => {
  it.each([
    [[], false],
    [[tool("a")], false],
    // Thinking counts as a work row: Thinking, Bash, Thinking is a group.
    [[tool("a"), text("t", "Hmm", { role: "thought" })], true],
    [[text("t1", "Hmm", { role: "thought" }), tool("a"), text("t2", "Then", { role: "thought" })], true],
    [[text("t1", "Hmm", { role: "thought" }), text("t2", "", { role: "thought", redacted: true })], true],
    [[text("t", "Hmm", { role: "thought" })], false],
    // An empty, unredacted thought is not a visible row.
    [[tool("a"), text("t", "", { role: "thought" })], false],
    [[tool("a"), tool("b")], true],
    [[tool("a"), tool("agent", { toolKind: "subagent", rawInput: { description: "Review" } })], true],
    // Setting off: one call plus an in-between message is two foldable items.
    [[tool("a"), text("m", "Next.")], true],
    [[text("m", "Next."), text("n", "Then.")], false],
    [[text("t", "Hmm", { role: "thought" }), text("m", "Next.")], true],
  ] as [AgentMessage[], boolean][])("%#: %j is a group: %s", (events, group) => {
    expect(isWorkingGroup(events)).toBe(group);
  });

  it("spans from the first event to the last first-terminal time, ignoring late updates", () => {
    expect(workingGroupSpan([
      tool("a", { createdAt: 1_000, updatedAt: 9_000, settledAt: 2_000 }),
      text("t", "Hmm", { role: "thought", createdAt: 2_500, updatedAt: 4_000 }),
      tool("b", { createdAt: 4_500, updatedAt: 6_000, settledAt: undefined, status: "in_progress" }),
    ])).toEqual({ startedAt: 1_000, durationMs: 5_000 });
    expect(workingGroupSpan([])).toBeNull();
  });

  it("covers only the loaded events when a page starts inside a group", () => {
    const group = [tool("a", { createdAt: 1_000, settledAt: 2_000 }), tool("b", { createdAt: 3_000, settledAt: 7_000 })];
    expect(workingGroupSpan(group.slice(1))).toEqual({ startedAt: 3_000, durationMs: 4_000 });
  });

  it("matches a pending permission by either call id, and a pending question", () => {
    const events = [tool("a", { nativeToolCallId: "toolu_1" }), tool("b"), tool("c")];
    expect([...gatedEventIds(events, "toolu_1", new Set(["c"]))]).toEqual(["a", "c"]);
    expect(gatedEventIds(events, undefined, new Set()).size).toBe(0);
  });
});

describe("loader line", () => {
  const working = (events: AgentMessage[]): TurnSegment => ({ kind: "working", key: events[0].id, events });
  const subject = (tail: TurnSegment | undefined, groupOpen = false, visible = true) => {
    const line = loaderLineSubject({ visible, tail, groupOpen });
    return "event" in line ? `${line.kind}:${line.event.id}` : line.kind;
  };

  it("is hidden while the user is asked something, and a timer without a work row at the tail", () => {
    expect(subject(working([tool("a")]), false, false)).toBe("hidden");
    expect(subject(undefined)).toBe("timer");
    expect(subject({ kind: "output", key: "m", events: [text("m", "Next.")], inBetween: true })).toBe("timer");
    expect(subject(working([text("t", "", { role: "thought" })]))).toBe("timer");
  });

  it("names a lone call, or a lone thought once its description has settled", () => {
    expect(subject(working([tool("a")]))).toBe("tool:a");
    expect(subject(working([text("t", "Reading the rules. Then", { role: "thought" })]))).toBe("thinking:t");
    // Name and description arrive together: not before the opening line is known.
    expect(subject(working([text("t", "Hmm", { role: "thought" })]))).toBe("timer");
    // A redacted thought has no description: it shows (name alone) once it finishes.
    expect(subject(working([text("t", "", { role: "thought", redacted: true })]))).toBe("timer");
    expect(subject(working([text("t", "", { role: "thought", redacted: true }), tool("a", { status: "completed" })]))).toBe("tool:a");
  });

  it("holds the previous subject while a streaming thought settles, and lets a new call win", () => {
    const thought = (text_: string, at = 40) => text("t", text_, { role: "thought", createdAt: at });
    // The line keeps the call it showed until the thought's description settles.
    expect(subject(working([tool("a"), thought("Hmm")]))).toBe("tool:a");
    expect(subject(working([tool("a"), thought("Reading the rules. Then")]))).toBe("thinking:t");
    // A live reader of a Local thought can settle it before props catch up.
    const line = loaderLineSubject({ visible: true, groupOpen: false, tail: working([tool("a"), thought("Hmm")]), thoughtReady: () => true });
    expect("event" in line && line.event.id).toBe("t");
    // A call that starts after an unsettled thought wins.
    expect(subject(working([thought("Hmm", 1), tool("b", { status: "in_progress", createdAt: 2 })]))).toBe("tool:b");
  });

  it("names the most recently started running work row, else the latest work row", () => {
    const parallel = [tool("a", { status: "in_progress", createdAt: 5 }), tool("b", { status: "in_progress", createdAt: 9 }), tool("c", { createdAt: 12 })];
    expect(subject(working(parallel))).toBe("tool:b");
    expect(subject(working([tool("a"), tool("b")]))).toBe("tool:b");
    // A thought streams while it is the newest event, grouped or not.
    expect(subject(working([tool("a"), text("t", "Hmm. Settled", { role: "thought", createdAt: 40 })]))).toBe("thinking:t");
    expect(subject(working([...parallel, text("t", "Hmm. Settled", { role: "thought", createdAt: 40 })]))).toBe("thinking:t");
    // A finished thought followed by a new call hands over to the call.
    expect(subject(working([text("t", "Hmm", { role: "thought", createdAt: 1 }), tool("a", { status: "in_progress", createdAt: 2 })]))).toBe("tool:a");
    // Still-running parallel calls outrank a thought that already ended.
    expect(subject(working([tool("a", { status: "in_progress", createdAt: 5 }), text("t", "Hmm", { role: "thought", createdAt: 6 }), tool("b", { createdAt: 7 })]))).toBe("tool:a");
  });

  it("reports a transient notice after the last work row of a collapsed group", () => {
    const retry: AgentMessage = { kind: "error_notice", id: "retry", code: "api_retry", severity: "warning", recoverable: true, message: "Retrying", createdAt: 40 } as AgentMessage;
    expect(subject(working([tool("a"), tool("b"), retry]))).toBe("status:retry");
    expect(subject(working([text("t", "Hmm", { role: "thought" }), tool("b"), retry]))).toBe("status:retry");
  });

  it("shows the loader alone when the user opened the live group", () => {
    expect(subject(working([tool("a"), tool("b")]), true)).toBe("bare");
    expect(subject(working([tool("a")]), true)).toBe("tool:a");
  });
});

describe("live tail choreography", () => {
  const working = (events: AgentMessage[]): TurnSegment => ({ kind: "working", key: events[0].id, events });
  const message: TurnSegment = { kind: "output", key: "m", events: [text("m", "Next.")], inBetween: true };

  it("hands a lone call to the feed when a message closes its run, not when it joins a group", () => {
    expect(handedOffCall("a", undefined, [working([tool("a")]), message])).toBe("a");
    expect(handedOffCall("a", undefined, [working([tool("a"), tool("b")])])).toBeUndefined();
    expect(handedOffCall("a", "a", [working([tool("a")])])).toBeUndefined();
    expect(handedOffCall(undefined, "a", [working([tool("a")])])).toBeUndefined();
  });

  it("counts only rows drawn above the loader line, so a lone call does not shift it", () => {
    expect(rowsAboveLoader([working([tool("a")])], "a")).toBe(false);
    expect(rowsAboveLoader([working([tool("a"), tool("b")])], undefined)).toBe(true);
    expect(rowsAboveLoader([working([tool("a")]), message], undefined)).toBe(true);
    expect(rowsAboveLoader([], undefined)).toBe(false);
  });
});

describe("TurnEventList working groups", () => {
  const ctx = {
    isStreaming: true, lastMessageId: null, editBaselines: new Map(), pendingPermission: null,
    pendingQuestionToolCallIds: new Set(), chatId: null, subagentChildren: new Map(),
  } as unknown as RendererContext;
  const render = (events: AgentMessage[], props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(TurnEventList, {
    events, isActive: true, isStreaming: true, ctx, ...props,
  }));

  it("puts a lone live call on the loader line, not also as a row", () => {
    const html = render([tool("a", { status: "in_progress", settledAt: undefined })]);
    expect(html).toContain("LOADER(tool:a)");
    expect(html).not.toContain("run a");
    expect(html).not.toContain("data-working-group");
  });

  it("renders the lone call as a row once a message closes its run, or while the user is asked", () => {
    const closed = render([tool("a"), text("m", "Next.")]);
    expect(closed).toContain("LOADER(timer)");
    expect(closed).toContain("run a");
    const asked = render([tool("a", { status: "in_progress", settledAt: undefined })], {
      ctx: { ...ctx, pendingPermission: { request: { toolCall: { toolCallId: "a" } } } },
    });
    expect(asked).not.toContain("LOADER");
    expect(asked).toContain("run a");
  });

  it("folds Thinking, Bash, Thinking into one collapsed group", () => {
    const events = [text("t1", "Reading the partition", { role: "thought", createdAt: 1_000 }), tool("a", { createdAt: 2_000, settledAt: 3_000 }),
      text("t2", "Now the header", { role: "thought", createdAt: 3_000, updatedAt: 4_000 }), text("answer", "Done.")];
    const html = render(events, { isStreaming: false });
    expect(html).toContain('data-working-group="closed"');
    expect(html).toContain('aria-expanded="false"');
    // The summary keeps counting thinking under messages.
    expect(html).toContain('aria-label="Worked for 3s, 1 tool call, 2 messages"');
    expect(html).not.toContain("run a");
  });

  it("puts a lone live thought on the loader line, not also as a row", () => {
    const html = render([text("t", "Reading the partition. Then", { role: "thought" })]);
    expect(html).toContain("LOADER(thinking:t)");
    expect(html).not.toContain("Reading the partition");
    expect(html).not.toContain("data-working-group");
    const closed = render([text("t", "Reading the partition. Then", { role: "thought" }), text("m", "Next.")]);
    expect(closed).toContain("Reading the partition");
  });

  it("does not show a streaming thought's row or line before its description settles", () => {
    const html = render([text("t", "Reading the parti", { role: "thought" })]);
    expect(html).toContain("LOADER(timer)");
    expect(html).not.toContain("Thinking");
  });

  it("collapses a live group with its own timer, names the current call, and closes it with a message", () => {
    const live = render([tool("a"), tool("b", { status: "in_progress", settledAt: undefined })]);
    expect(live).toContain('data-working-group="live"');
    expect(live).toContain("Working for");
    expect(live).toContain('aria-label="Working, 2 tool calls"');
    expect(live).toContain("LOADER(tool:b)");
    expect(live).not.toContain("run a");
    const closed = render([tool("a", { createdAt: 1_000, settledAt: 2_000 }), tool("b", { createdAt: 2_000, settledAt: 49_000 }), text("m", "Next.")]);
    expect(closed).toContain('data-working-group="closed"');
    expect(closed).toContain("Worked for 48s");
    expect(closed).toContain("LOADER(timer)");
  });

  it("shows only the gated row under a collapsed group while a permission waits", () => {
    const html = render([tool("a"), tool("b", { status: "pending", settledAt: undefined }), tool("c")], {
      ctx: { ...ctx, pendingPermission: { request: { toolCall: { toolCallId: "b" } } } },
    });
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("run b");
    expect(html).not.toContain("run a");
    expect(html).not.toContain("run c");
    expect(html).not.toContain("LOADER");
  });

  it("adds a red error icon to a group with a failed call", () => {
    const html = render([tool("a", { status: "failed" }), tool("b")], { isStreaming: false });
    expect(html).toContain("lucide-circle-x");
    expect(html).toContain("with a failed tool call");
  });

  // Claude delivers a question's answer and a plan rejection through a deny
  // tool_result, so those rows read "failed" in status but ok on screen.
  const quietFailures: [string, AgentToolMessage][] = [
    ["an answered question", tool("q", { title: "AskUserQuestion", toolKind: "question", status: "failed",
      rawInput: { questions: [{ question: "Which branch?", options: [{ label: "main" }] }] }, rawOutput: "User answered: main" })],
    ["a reviewed plan", tool("plan", { title: "ExitPlanMode", toolKind: "switch_mode", status: "failed",
      rawInput: { plan: "1. Edit the header" }, rawOutput: "User rejected the plan" })],
    ["a failed compaction", tool("compact", { title: "Compaction", toolKind: "compaction", status: "failed", rawOutput: "No summary" })],
    ["pending checks", tool("checks", { status: "failed", rawInput: { command: "gh pr checks 12" }, rawOutput: { exitCode: 8, output: "pending" } })],
  ];

  it.each(quietFailures)("keeps the error icon off a group whose %s only reads failed in status", (_, quiet) => {
    const html = render([tool("a"), quiet], { isStreaming: false });
    expect(html).toContain('data-working-group="closed"');
    expect(html).not.toContain("lucide-circle-x");
    expect(html).not.toContain("with a failed tool call");
  });

  it("flags a really failed Bash beside an answered question", () => {
    const html = render([quietFailures[0][1], tool("bash", { status: "failed", rawOutput: { exitCode: 1, output: "boom" } })], { isStreaming: false });
    expect(html).toContain("lucide-circle-x");
    expect(html).toContain("with a failed tool call");
  });

  // A budget stop renders after the working run, never inside a group.
  // A Browser batch renders as one card that reads failed only when every
  // action in it failed.
  const browser = (id: string, status: AgentToolMessage["status"]) => tool(id, {
    title: "node_repl:js", toolKind: "mcp", status, rawOutput: undefined,
    rawInput: { server: "node_repl", tool: "js", arguments: { title: "Open the page", code: "await tab.goto('https://example.test')" } },
  });

  it("keeps the error icon off a group whose Browser batch recovered from a failed action", () => {
    const html = render([tool("a"), browser("web-1", "failed"), browser("web-2", "completed"), tool("b")], { isStreaming: false });
    expect(html).not.toContain("with a failed tool call");
  });

  it("flags a group whose Browser batch failed outright", () => {
    const html = render([tool("a"), browser("web-1", "failed"), browser("web-2", "failed"), tool("b")], { isStreaming: false });
    expect(html).toContain("with a failed tool call");
  });

  it.each([...quietFailures,
    ["a budget stop", tool("budget", { title: "Budget", toolKind: "budget_stop", status: "failed", rawOutput: {} })] as [string, AgentToolMessage],
    ["a failed Bash", tool("bash", { status: "failed", rawOutput: { exitCode: 1, output: "boom" } })] as [string, AgentToolMessage]])(
    "agrees with the row for %s", (_, event) => {
      const row = renderToStaticMarkup(createElement(MessageView, { message: event, ctx: { ...ctx, isStreaming: false } }));
      expect(row.includes('aria-description="Tool failed"')).toBe(eventShowsFailure(event));
    });

  it("follows the setting once settled, and always keeps in-between messages outside while live", () => {
    const events = [tool("a"), text("m1", "Reading next."), tool("b"), tool("c"), text("answer", "All done.")];
    setting.on = false;
    try {
      const folded = render(events, { isStreaming: false });
      expect(folded).toContain("3 tool calls, 1 message");
      expect(folded).not.toContain("Reading next.");
      expect(folded).toContain("All done.");
      expect(render(events)).toContain("Reading next.");
    } finally {
      setting.on = true;
    }
    const outside = render(events, { isStreaming: false });
    expect(outside).toContain("Reading next.");
    // `a` alone is a row; `b, c` is a group.
    expect(outside).toContain("run a");
    expect(outside).toContain("2 tool calls");
  });
});

describe("loader line label", () => {
  const label = (event: AgentMessage, streaming = false, source?: unknown) =>
    renderToStaticMarkup(createElement(LoaderLineLabel, { subject: { kind: "thinking", event, streaming }, source: source as never }));

  it("shows Thinking with the thought's opening line, like its row", () => {
    const html = label(text("t", "Reading   the partition rules.\nThen the header.", { role: "thought" }));
    expect(html).toContain(">Thinking<");
    expect(html).toContain("data-tool-preview");
    expect(html).toContain("Reading the partition rules.");
    expect(html).not.toContain("Then the header");
  });

  it("shows the name alone for an empty or redacted thought, and while the opening line is unknown", () => {
    for (const html of [label(text("t", "", { role: "thought", redacted: true })), label(text("e", "", { role: "thought" })),
      label(text("s", "Reading the parti", { role: "thought" }), true)]) {
      expect(html).toContain(">Thinking<");
      expect(html).not.toContain("data-tool-preview");
    }
  });

  it("learns a streaming Local thought's opening line from the live source, once", () => {
    const thought = text("t", "Reading", { role: "thought" });
    const source = { subscribe: () => () => {}, read: () => ({ ...thought, text: "Reading the rules. Then more words keep arriving" }) };
    expect(label(thought, true, source)).toContain("Reading the rules.");
  });
});

describe("settledLoaderLine", () => {
  const call = (status: AgentToolMessage["status"], createdAt = 1): AgentToolMessage =>
    ({ kind: "tool", id: `t-${status}`, toolCallId: `t-${status}`, title: "Grep partition", toolKind: "search", status, rawInput: { pattern: "partition" }, createdAt, updatedAt: createdAt });
  const thought = (createdAt: number): AgentMessage => ({ kind: "text", id: `th-${createdAt}`, role: "thought", text: "Checking.", createdAt });
  const finished = { kind: "tool" as const, event: call("completed") };

  it("keeps naming the previous call while a newer one has waited briefly", () => {
    expect(settledLoaderLine(finished, { heldLong: false, pendingCall: { since: 10, long: false } })).toBe(finished);
    expect(settledLoaderLine(finished, { heldLong: false, pendingCall: null })).toBe(finished);
  });

  it("returns to the timer once the newer call has waited, never naming a finished call", () => {
    expect(settledLoaderLine(finished, { heldLong: false, pendingCall: { since: 10, long: true } })).toEqual({ kind: "timer" });
    const ended = { kind: "thinking" as const, event: thought(5), streaming: true };
    expect(settledLoaderLine(ended, { heldLong: false, pendingCall: { since: 10, long: true } })).toEqual({ kind: "timer" });
  });

  it("keeps a call that is still running, and a thought that started after the waiting call", () => {
    const running = { kind: "tool" as const, event: call("in_progress") };
    expect(settledLoaderLine(running, { heldLong: false, pendingCall: { since: 10, long: true } })).toBe(running);
    const later = { kind: "thinking" as const, event: thought(20), streaming: true };
    expect(settledLoaderLine(later, { heldLong: false, pendingCall: { since: 10, long: true } })).toBe(later);
  });

  it("returns to the timer for a long-held message, and never shows a hidden line", () => {
    expect(settledLoaderLine({ kind: "bare" }, { heldLong: true, pendingCall: null })).toEqual({ kind: "timer" });
    expect(settledLoaderLine({ kind: "hidden" }, { heldLong: true, pendingCall: { since: 1, long: true } })).toEqual({ kind: "hidden" });
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, AgentToolMessage } from "@zeros/protocol/agent-messages";
import { EventRow } from "../renderers/event-row";
import { EventRowRenderer, renderDetail } from "../renderers/event-row-renderer";
import { countEventSummary, summaryIcons } from "../renderers/tool-summary";
import type { RendererContext } from "../renderers/types";
import { formatTranscript } from "../transcript-format";
import { groupMessagesIntoTurns } from "../turn-grouping";
import { isVisibleTranscriptEvent, partitionTurnSequence } from "../turn-partition";
import { TurnEventList } from "../turn-event-list";

vi.mock("../renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) => createElement("pre", {}, code),
  CodeWithGutter: ({ code }: { code: string }) => createElement("pre", {}, code),
}));
vi.mock("../markdown", () => ({
  renderMarkdown: (text: string) => text,
  renderMarkdownSegments: (text: string) => [{ type: "html", html: text }],
  fileRefPath: () => null,
}));
vi.mock("@/renderer/shared/ui/loading", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/renderer/shared/ui/loading")>(),
  ActivityShimmer: ({ startedAt }: { startedAt: number }) =>
    createElement("span", { "data-activity-start": startedAt }, "LIVE ACTIVITY"),
}));

const ctx = {
  attachmentImagesActive: false,
  pendingQuestionToolCallIds: new Set(),
  editBaselines: new Map(),
  subagentChildren: new Map(),
  chatId: "checks-chat",
} as RendererContext;

function checks(overrides: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: "tool", id: "checks", toolCallId: "checks", nativeToolCallId: "native-checks",
    title: "Running gh pr checks 42", toolKind: "execute", status: "failed",
    createdAt: 10, updatedAt: 20,
    rawInput: { command: "gh pr checks 42" },
    rawOutput: { exitCode: 8, status: "failed", output: "build\tpass\nsmoke\tpending" },
    ...overrides,
  };
}

function sleep(overrides: Partial<AgentToolMessage> = {}): AgentToolMessage {
  const native = { type: "sleep", id: "native-sleep", durationMs: 45_000 };
  return {
    kind: "tool", id: "sleep", toolCallId: "sleep", nativeToolCallId: native.id,
    title: "sleep", toolKind: "other", status: "completed", createdAt: 21, updatedAt: 46_000,
    rawInput: native, rawOutput: native,
    ...overrides,
  };
}

const prompt: AgentMessage = { kind: "text", id: "prompt", role: "user", text: "Check CI", createdAt: 1 };
const narration: AgentMessage = { kind: "text", id: "narration", role: "agent", text: "I will check again shortly.", phase: "commentary", createdAt: 20 };
const answer: AgentMessage = { kind: "text", id: "answer", role: "agent", text: "All checks passed.", phase: "final_answer", createdAt: 47_000 };
const row = (message: AgentToolMessage, open = true) => renderToStaticMarkup(
  createElement(EventRow, { message, ctx, defaultOpen: open, detail: renderDetail(message, ctx) }),
);

describe("pending checks presentation", () => {
  it.each([
    "gh pr checks 42",
    "gh pr checks --required --repo example/project",
    "/opt/homebrew/bin/gh pr checks 42 --watch",
    "/bin/zsh -lc 'gh pr checks 42'",
    ["bash", "-lc", "gh pr checks 42"],
    ["gh", "pr", "checks", "42"],
  ])("shows a pending Bash result for %j without changing native failure evidence", (command) => {
    const tool = checks({ rawInput: { command } });
    const before = JSON.stringify(tool);
    const collapsed = row(tool, false);
    expect(collapsed).toContain(">Bash<");
    expect(collapsed).not.toContain("text-red-primary");
    expect(collapsed).not.toContain("Tool failed");
    expect(collapsed).toContain('aria-description="Checks are still running."');
    const expanded = row(tool);
    expect(expanded).toContain("Checks are still running.");
    expect(expanded).toContain("smoke");
    expect(expanded).not.toContain("text-red-primary");
    expect(expanded).not.toContain("tool failed without an explanation");
    expect(JSON.stringify(tool)).toBe(before);
    const exported = formatTranscript([tool], "full").text;
    expect(exported).toContain("Checks are still running.");
    expect(exported).not.toContain("— failed");
  });

  it("explains pending checks even when output was not captured", () => {
    const html = row(checks({ rawOutput: { exitCode: 8 } }));
    expect(html).toContain("Checks are still running.");
    expect(html).not.toContain("failed without an explanation");
  });

  it.each([
    "pnpm test", "echo 'gh pr checks 42'", "./check-gh pr checks 42",
    "gh pr checks 42 && pnpm test", "gh pr checks 42; exit 8",
    "gh pr checks 42\nexit 8", "gh pr checks 42\rexit 8",
    "gh pr checks 42 | cat", "gh pr checks 42 > result.txt",
    "gh pr checks $PR", 'gh pr checks "$(exit 8)"',
    "env gh pr checks 42", "bash -lc 'gh pr checks 42' extra",
    "gh pr checks 'unterminated", "gh pr checks 42 # comment",
  ])("retains failure styling for ambiguous or unrelated command %j", (command) => {
    const html = row(checks({ rawInput: { command } }));
    expect(html).toContain(">Error<");
    expect(html).toContain("Tool failed");
    expect(html).not.toContain("Checks are still running.");
  });

  it.each([
    { exitCode: 1, output: "smoke failed" },
    { exitCode: 2, output: "Authentication required" },
    { exitCode: 8, status: "interrupted", output: "Stopped" },
    { exitCode: 8, error: "Connection lost" },
    { exitCode: 8, _zerosToolCompletion: "unreported" },
  ])("keeps genuine failures and incomplete results inspectable: %j", (rawOutput) => {
    const tool = checks({ rawOutput });
    expect(row(tool)).toContain(">Error<");
    expect(row(tool)).not.toContain("Checks are still running.");
    expect(formatTranscript([tool], "full").text).toContain("— failed");
  });

  it("uses JSON buckets as pending evidence and unwraps native Cursor results", () => {
    for (const rawOutput of [
      { exitCode: 0, output: '[{"name":"build","bucket":"pass"},{"name":"smoke","bucket":"pending"}]' },
      { status: "success", value: { exitCode: 0, stdout: '[{"name":"smoke","bucket":"pending"}]' } },
    ]) {
      const html = row(checks({ status: "completed", rawInput: { command: "gh pr checks 42 --json bucket,name" }, rawOutput }));
      expect(html).toContain("Checks are still running.");
      expect(html).not.toContain(">Error<");
    }
    for (const output of [
      '[{"bucket":"pass"}]', '[{"bucket":"fail"},{"bucket":"pending"}]',
      '[{"bucket":"unknown"},{"bucket":"pending"}]', '[{"state":"pending"}]',
      'build pending', '[{"bucket":"pending"}',
    ]) {
      const html = row(checks({ status: "completed", rawInput: { command: "gh pr checks 42 --json bucket,name" }, rawOutput: { exitCode: 0, output } }));
      expect(html).not.toContain("Checks are still running.");
    }
  });

  it("keeps an explicit provider failure red even when captured JSON has pending buckets and exit zero", () => {
    const tool = checks({
      rawInput: { command: "gh pr checks 42 --json bucket,name" },
      rawOutput: { exitCode: 0, status: "failed", output: '[{"name":"smoke","bucket":"pending"}]' },
    });
    expect(row(tool)).toContain(">Error<");
    expect(row(tool)).not.toContain("Checks are still running.");
    expect(formatTranscript([tool], "full").text).toContain("— failed");
  });
});

describe("native Sleep visibility", () => {
  it.each(["pending", "in_progress", "completed"] as const)("omits routine %s Sleep from live rows, history, summaries and copy", (status) => {
    const tool = sleep({ status, ...(status !== "completed" ? { rawOutput: undefined } : {}) });
    expect(isVisibleTranscriptEvent(tool)).toBe(false);
    expect(renderToStaticMarkup(createElement(EventRowRenderer, { message: tool, ctx }))).toBe("");
    expect(partitionTurnSequence([tool], { live: true })).toEqual([]);
    expect(countEventSummary([checks(), tool, narration])).toEqual({ toolCalls: 1, agents: 0, messages: 1 });
    expect(summaryIcons([tool])).toEqual([]);
    const restored: AgentMessage[] = JSON.parse(JSON.stringify([prompt, checks(), narration, tool, answer]));
    const full = formatTranscript(restored, "full");
    expect(full.count).toBe(4);
    expect(full.text).not.toContain("sleep");
    expect(full.text).not.toContain("durationMs");
    expect(formatTranscript(restored, "concise").text).toContain("All checks passed.");
    expect(restored).toHaveLength(5);
  });

  it("keeps the turn clock and visible narration during and after the wait", () => {
    for (const status of ["in_progress", "completed"] as const) {
      const events = [checks(), narration, sleep({ status })];
      const turn = groupMessagesIntoTurns([prompt, ...events])[0];
      expect(turn.providerEvents).toEqual(events);
      expect(turn.recordedStartedAt).toBe(1);
      const html = renderToStaticMarkup(createElement(TurnEventList, {
        events: turn.events, activityEvents: turn.providerEvents, activityStartedAt: turn.recordedStartedAt,
        isActive: true, isStreaming: true, ctx,
      }));
      expect(html.match(/LIVE ACTIVITY/g)).toHaveLength(1);
      expect(html).toContain('data-activity-start="1"');
      expect(html).toContain('data-live-narration="true"');
      expect(html).not.toContain(">sleep<");
    }
  });

  it("does not create orphan system turns or nested tool counts for routine sleeps", () => {
    expect(groupMessagesIntoTurns([sleep()])).toEqual([]);
    expect(groupMessagesIntoTurns([sleep(), prompt])).toHaveLength(1);
    const parent = checks({ id: "agent", toolCallId: "agent", toolKind: "subagent", title: "Inspect CI", status: "completed", rawInput: { description: "Inspect CI" }, rawOutput: "Report ready" });
    const exported = formatTranscript([parent, sleep({ parentToolId: "agent" }), checks({ parentToolId: "agent" })], "full");
    expect(exported.text).toContain("Sub-agent:");
    expect(exported.text).toContain("Checks are still running.");
    expect(exported.text).not.toContain("sleep");
  });

  it.each([
    { status: "failed" as const },
    { status: "pending" as const, rawOutput: { _zerosToolCompletion: "unreported" } },
    { nativeToolCallId: undefined },
    { toolKind: "mcp" as const },
    { rawInput: { command: "sleep 45" } },
    { rawInput: { type: "sleep", id: "different-native-id", durationMs: 45_000 } },
    { rawInput: { type: "sleep", id: "native-sleep", durationMs: -1 } },
    { rawOutput: { error: "Sleep interrupted" } },
    { rawOutput: undefined },
    { content: [{ type: "content" as const, content: { type: "text" as const, text: "Unexpected result" } }] },
  ])("retains failures, unresolved and unrelated Sleep-shaped tools: %j", (overrides) => {
    const tool = sleep(overrides);
    expect(isVisibleTranscriptEvent(tool)).toBe(true);
    expect(countEventSummary([tool]).toolCalls).toBe(1);
    expect(formatTranscript([tool], "full").text).toContain("Tool · sleep");
  });
});

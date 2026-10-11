// Canonical replay fixture for the shipping transcript components. Native
// translation and cloud wire ownership are covered by codex-upgrade-transcript.
import { useEffect, useMemo, useState } from "react";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { SessionUpdate } from "@zeros/protocol/agent-events";
import { TurnEventList } from "../features/agent/turn-event-list";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";
import { prepareCachedTranscriptWindow } from "../platform/cloud-transcript-cache-contract";

const owners = ["personal-local", "organization-local", "organization-cloud"] as const;
type Owner = typeof owners[number];
interface Snapshot { messages: AgentMessage[]; startedAt: number; live: boolean; partial: boolean; childPartial: boolean }
const storageKey = `codex-runtime-transcript:${location.search}`;
const context: RendererContext = {
  isStreaming: true, lastMessageId: null, activeTurnStartedAt: 0, editBaselines: new Map(),
  pendingPermission: null, pendingQuestionToolCallIds: new Set(), chatId: null, setMode: null,
  subagentChildren: new Map(), respondToQuestion: () => {}, respondToPermission: () => {},
  retrySafetyReview: async () => {}, recordPolicy: () => {}, editAndResubmit: () => {},
};
function reduce(messages: AgentMessage[], updates: SessionUpdate[]): AgentMessage[] {
  return updates.reduce((previous, update) => applyUpdate(previous, { sessionId: "fixture", update }), messages);
}
function initialSnapshots(): Record<Owner, Snapshot> {
  const saved = sessionStorage.getItem(storageKey);
  if (saved) return JSON.parse(saved);
  return Object.fromEntries(owners.map((owner) => [owner, {
    live: true, partial: false, childPartial: false, startedAt: Date.now() - 65_000,
    messages: reduce([], [
      { sessionUpdate: "agent_message_chunk", messageId: "progress", phase: "commentary", content: { type: "text", text: `Inspecting source for ${owner}.` } },
      { sessionUpdate: "tool_call", toolCallId: "before-report", title: "Bash", kind: "execute", status: "completed",
        rawInput: { command: "printf before-report" }, rawOutput: "Earlier tool details stay visible." },
      { sessionUpdate: "agent_message_chunk", messageId: "report", content: { type: "text", text: `First confirmed finding for ${owner}.` } },
      { sessionUpdate: "tool_call", toolCallId: "research", title: "Agent", kind: "subagent", status: "in_progress",
        rawInput: { agentThreadId: "child", agentPath: "/root/research", description: "Research", prompt: "Inspect the affected source.", model: "gpt-6.1-sol", reasoningEffort: "max" } },
      { sessionUpdate: "agent_message_chunk", messageId: "child-report", parentToolId: "research", phase: "partial_answer", content: { type: "text", text: "The child found the affected code." } },
      { sessionUpdate: "agent_message_chunk", messageId: "child-progress", parentToolId: "research", phase: "commentary", content: { type: "text", text: "The child is checking more cases." } },
      { sessionUpdate: "agent_message_chunk", messageId: "child-late-report", parentToolId: "research", content: { type: "text", text: "The child confirmed another finding." } },
      { sessionUpdate: "tool_call", toolCallId: "nested-review", parentToolId: "research", title: "Agent", kind: "subagent", status: "completed",
        rawInput: { description: "Nested review" }, rawOutput: { report: "Nested review details stay visible." } },
      { sessionUpdate: "tool_call", toolCallId: "nested-command", parentToolId: "nested-review", title: "Bash", kind: "execute", status: "completed",
        rawInput: { command: "printf nested-details" }, rawOutput: "Nested command details stay visible." },
      { sessionUpdate: "tool_call", toolCallId: "after-report", title: "Bash", kind: "execute", status: "completed",
        rawInput: { command: "printf phase-details" }, rawOutput: "Later tool details stay visible." },
      { sessionUpdate: "tool_call", toolCallId: "batch-read", title: "Bash", kind: "execute", status: "completed",
        rawInput: { command: "cat batch-a.ts batch-b.ts", commandActions: [
          { type: "read", path: "batch-a.ts" }, { type: "read", path: "batch-b.ts" },
        ] }, rawOutput: "Shared batch read result." },
      { sessionUpdate: "tool_call", toolCallId: "batch-edit", title: "Edit", kind: "edit", status: "completed",
        rawInput: { changes: [
          { path: "changed-a.ts", kind: { type: "add" }, diff: "first file\n" },
          { path: "changed-b.ts", kind: { type: "add" }, diff: "second file\n" },
        ] } },
      { sessionUpdate: "tool_call", toolCallId: "browser", title: "node_repl:js", kind: "mcp", status: "completed",
        rawInput: { server: "node_repl", tool: "js", arguments: { title: "Inspect disclosure page", code: "await tab.url();" } },
        rawOutput: { raw: { _meta: { browser_use: { url: "https://example.test/disclosures" }, "codex/browserUse": true } } } },
      { sessionUpdate: "agent_thought_chunk", messageId: "thinking", content: { type: "text", text: "Checking disclosure continuity." } },
    ]),
  }])) as Record<Owner, Snapshot>;
}

export function CodexRuntimeTranscriptFixture({ initialOwner }: { initialOwner: Owner }) {
  const [owner, setOwner] = useState<Owner>(initialOwner);
  const [snapshots, setSnapshots] = useState(initialSnapshots);
  const [visible, setVisible] = useState(true);
  const [alternateChat, setAlternateChat] = useState(false);
  const snapshot = snapshots[owner];
  useEffect(() => {
    const cloud = snapshots["organization-cloud"];
    // Exercise the real presentation-only cloud cache on reload. Fixture turn
    // state stays separate; cached rows do not establish a live or settled turn.
    const cached = prepareCachedTranscriptWindow({ recordEpoch: null, revision: 1, cursor: null,
      messages: cloud.messages.map(message => ({ msgId: message.id, kind: message.kind,
        createdAt: message.createdAt, payload: JSON.stringify(message) })) });
    sessionStorage.setItem(storageKey, JSON.stringify({ ...snapshots, "organization-cloud": {
      ...cloud, messages: cached.messages.map(row => JSON.parse(row.payload) as AgentMessage),
    } }));
  }, [snapshots]);
  const children = useMemo(() => {
    const grouped = new Map<string, AgentMessage[]>();
    for (const message of snapshot.messages) {
      if (!("parentToolId" in message) || !message.parentToolId) continue;
      const siblings = grouped.get(message.parentToolId) ?? [];
      siblings.push(message);
      grouped.set(message.parentToolId, siblings);
    }
    return grouped;
  }, [snapshot.messages]);
  const events = useMemo(() => snapshot.messages.filter((message) => !("parentToolId" in message) || !message.parentToolId), [snapshot.messages]);
  const update = (updates: SessionUpdate[], patch: Partial<Snapshot> = {}) => setSnapshots((previous) => ({
    ...previous, [owner]: { ...previous[owner], ...patch, messages: reduce(previous[owner].messages, updates) },
  }));
  return (
    <section id="codex-runtime-transcript" data-owner={owner} data-started-at={snapshot.startedAt} className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">{owners.map((target) => <Button key={target} onClick={() => setOwner(target)}>{target}</Button>)}</div>
      <div id="codex-runtime-feed" {...(!visible ? { inert: "" } : {})} style={{ visibility: visible ? "visible" : "hidden" }}>
        <TurnEventList events={events} isActive isStreaming={snapshot.live} surfaceActive={visible} activityStartedAt={snapshot.startedAt}
          // Deliberately reuse native chat/row ids across different workspaces.
          ctx={{ ...context, chatId: alternateChat ? "alternate-chat" : "fixture-chat", isStreaming: snapshot.live, activeTurnStartedAt: snapshot.startedAt,
            attachmentCwd: owner === "organization-cloud" ? "cloud://fixture/workspace" : `/Users/fixture/${owner}`,
            attachmentImagesActive: visible, subagentChildren: children }}
          footer={!snapshot.live ? <div data-codex-fixture-footer="" className="text-fg3 text-xs">Turn complete</div> : undefined} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={snapshot.partial || !snapshot.live} onClick={() => update([
          { sessionUpdate: "agent_message_chunk", messageId: "more-work", phase: "commentary", content: { type: "text", text: "Checking the remaining cases." } },
          // The native item/completed phase may arrive after later work.
          { sessionUpdate: "agent_message_chunk", messageId: "report", phase: "partial_answer", content: { type: "text", text: "" } },
        ], { partial: true })}>Show partial answer</Button>
        <Button disabled={snapshot.childPartial || !snapshot.live} onClick={() => update([
          { sessionUpdate: "agent_message_chunk", messageId: "child-late-report", parentToolId: "research", phase: "partial_answer", content: { type: "text", text: "" } },
        ], { childPartial: true })}>Confirm child partial answer</Button>
        <Button disabled={!snapshot.live} onClick={() => update([
          { sessionUpdate: "tool_call_update", toolCallId: "research", status: "completed", rawOutput: { status: "completed" } },
        ])}>Complete child</Button>
        <Button disabled={!snapshot.live} onClick={() => update([
          { sessionUpdate: "tool_call_update", toolCallId: "research", status: "in_progress", rawOutput: { status: "running" } },
        ])}>Resume child</Button>
        <Button disabled={!snapshot.live} onClick={() => update([
          { sessionUpdate: "tool_call_update", toolCallId: "research", status: "completed", rawOutput: { status: "completed" } },
          { sessionUpdate: "agent_message_chunk", messageId: "final", phase: "final_answer", content: { type: "text", text: "All findings are confirmed." } },
        ], { live: false })}>Complete turn</Button>
        <Button onClick={() => setVisible((previous) => !previous)}>Toggle transcript visibility</Button>
        <Button onClick={() => setAlternateChat((previous) => !previous)}>Switch chat</Button>
      </div>
    </section>
  );
}

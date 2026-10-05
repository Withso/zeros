import { useState } from "react";
import { applyUpdate, type AgentMessage, type AgentToolMessage } from "@zeros/protocol/agent-messages";
import type { SessionUpdate } from "@zeros/protocol/agent-events";
import { Button } from "../shared/ui/primitives/button";
import { TurnEventList } from "../features/agent/turn-event-list";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import { formatTranscript } from "../features/agent/transcript-format";
import { reconcileHistoryMessages } from "../features/agent/history-message-identity";
import type { RendererContext } from "../features/agent/renderers/types";

const nativeSleep = { type: "sleep", id: "native-wait", durationMs: 45_000 };
const initial: AgentToolMessage = {
  kind: "tool", id: "tool-ci-first", toolCallId: "ci-first", nativeToolCallId: "native-ci-first",
  title: "Running gh pr checks 42", toolKind: "execute", status: "in_progress",
  rawInput: { command: "gh pr checks 42" }, createdAt: 1, updatedAt: 1,
};
const failure: AgentToolMessage = {
  ...initial, id: "tool-ci-failure", toolCallId: "ci-failure", status: "failed",
  rawInput: { command: "pnpm test" },
  rawOutput: { exitCode: 1, output: "One test failed." },
};

export function ToolWaitFixture({ ctx }: { ctx: RendererContext }) {
  const [startedAt] = useState(() => Date.now() - 65_000);
  const [messages, setMessages] = useState<AgentMessage[]>(() => [{ ...initial, createdAt: startedAt + 1, updatedAt: startedAt + 1 }]);
  const [live, setLive] = useState(true);
  const update = (...updates: SessionUpdate[]) => setMessages((previous) => updates.reduce(
    (state, item) => applyUpdate(state, { sessionId: "wait-fixture", update: item }), previous,
  ));
  return (
    <section id="tool-wait-fixture" className="mx-auto max-w-3xl space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => {
          setMessages([{ ...initial, createdAt: startedAt + 1, updatedAt: startedAt + 1 }]);
          setLive(true);
        }}>Reset wait</Button>
        <Button onClick={() => update(
          { sessionUpdate: "tool_call_update", toolCallId: "ci-first", status: "failed", rawOutput: { exitCode: 8, status: "failed", output: "build\tpass\nsmoke\tpending" } },
          { sessionUpdate: "agent_message_chunk", messageId: "wait-narration", phase: "commentary", content: { type: "text", text: "Checks are still running. I will check again shortly." } },
          { sessionUpdate: "tool_call", toolCallId: "ci-wait", nativeToolCallId: nativeSleep.id, title: "Sleep", kind: "other", status: "in_progress", rawInput: nativeSleep },
        )}>Show pending checks</Button>
        <Button onClick={() => update(
          { sessionUpdate: "tool_call_update", toolCallId: "ci-wait", status: "completed", rawOutput: nativeSleep },
          { sessionUpdate: "tool_call", toolCallId: "ci-next", title: "Running gh pr checks 42 --required", kind: "execute", status: "in_progress", rawInput: { command: "gh pr checks 42 --required" } },
        )}>Finish Sleep</Button>
        <Button onClick={() => {
          update(
            { sessionUpdate: "tool_call_update", toolCallId: "ci-next", status: "completed", rawOutput: { exitCode: 0, output: "All checks passed." } },
            { sessionUpdate: "agent_message_chunk", messageId: "wait-answer", phase: "final_answer", content: { type: "text", text: "All checks passed." } },
          );
          setLive(false);
        }}>Finish checks</Button>
        <Button onClick={() => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "ci-wait", status: "pending", rawOutput: { _zerosToolCompletion: "unreported" } });
          setLive(false);
        }}>Stop wait</Button>
        <Button onClick={() => setMessages((previous) => reconcileHistoryMessages(JSON.parse(JSON.stringify(previous)) as AgentMessage[]))}>Reload waits</Button>
      </div>
      <div id="tool-wait-feed">
        <TurnEventList events={messages} isActive isStreaming={live} activityStartedAt={startedAt} ctx={{ ...ctx, chatId: "wait-fixture" }} />
      </div>
      <div id="tool-wait-real-failure"><EventRowRenderer message={failure} ctx={ctx} /></div>
      <output id="tool-wait-export" className="sr-only">{formatTranscript(messages, "full").text}</output>
      <output id="tool-wait-native" className="sr-only">{JSON.stringify(messages)}</output>
    </section>
  );
}

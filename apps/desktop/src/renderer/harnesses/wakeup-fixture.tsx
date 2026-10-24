// Native hook ordering through the real reducer, activity store and transcript.
import { useState } from "react";
import type { SessionUpdate, WakeupNoticeInfo } from "@zeros/protocol/agent-events";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { BLANK, useSessionsStore, useChatAgentActivity } from "../features/agent/sessions-store";
import { loadedBackgroundTaskState } from "../features/agent/background-task-state";
import { TurnEventList } from "../features/agent/turn-event-list";
import { formatTranscript } from "../features/agent/transcript-format";
import { turnFooterDuration } from "../features/agent/turn-footer";
import { formatElapsed } from "../shared/ui/loading";
import type { RendererContext } from "../features/agent/renderers";
import { Button } from "../shared/ui/primitives/button";

const CHAT = "wakeup-fixture", EXECUTION = "wakeup-fixture-execution";
const initial: SessionUpdate = {
  sessionUpdate: "agent_message_chunk", messageId: "waiting-answer", phase: "final_answer",
  content: { type: "text", text: "The deployment is still provisioning. I’ll check again shortly." },
};

function reset(startedAt: number) {
  useSessionsStore.getState().setSession(CHAT, {
    ...BLANK, agentId: "claude", sessionId: EXECUTION, status: "ready",
    messages: applyUpdate([], { sessionId: EXECUTION, update: initial }),
    ...loadedBackgroundTaskState({
      sessionUpdate: "background_tasks_update", waiting: true, activity: { state: "idle", startedAt },
      tasks: [{ taskId: "scheduled-wakeup:deployment", name: "Check deployment", startedAt, updatedAt: startedAt }],
    }),
  });
}

export function WakeupFixture({ ctx }: { ctx: RendererContext }) {
  const [startedAt] = useState(() => { const time = Date.now() - 65_000; reset(time); return time; });
  const [source, setSource] = useState<WakeupNoticeInfo["source"]>("loop_wakeup");
  const slot = useSessionsStore(state => state.sessions[CHAT]);
  const activity = useChatAgentActivity(CHAT);
  const update = (update: SessionUpdate) => useSessionsStore.getState().applyBridgeUpdate({ sessionId: EXECUTION, update });
  const snapshot = (state: "running" | "idle") => update({
    sessionUpdate: "background_tasks_update", waiting: false, tasks: [], activity: { state, startedAt },
  });
  return (
    <section id="wakeup-fixture" className="flex flex-col gap-3">
      <div data-wakeup-transcript>
        <TurnEventList events={slot.messages} isActive isStreaming={activity === "running"}
          activityStartedAt={startedAt} backgroundTasks={activity === "waiting" ? slot.backgroundTasks : undefined}
          ctx={{ ...ctx, chatId: CHAT, isStreaming: activity === "running" }}
          footer={activity !== "running" ? <div data-wakeup-footer className="text-muted-fg py-1 text-xs">
            Output footer · {formatElapsed(turnFooterDuration({ startedAt, endedAt: startedAt + 60_000 }, slot.messages, startedAt))}
          </div> : null} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => update({
          sessionUpdate: "wakeup_notice", noticeId: "deployment-wake", source,
          reason: source === "loop_wakeup" ? "Deployment still provisioning" : "Check deployment",
          scheduledFor: Date.UTC(2026, 9, 24, 12, 1, 30),
        })}>Deliver wake-up notice</Button>
        <Button onClick={() => {
          // The worker hook emits status first. Actual model events resume the
          // native activity; the notice alone must not change waiting state.
          snapshot("running");
          update({ sessionUpdate: "tool_call", toolCallId: "read-deployment", title: "Read", kind: "read", status: "completed",
            rawInput: { file_path: "/workspace/deployment.json" }, rawOutput: { status: "ready" } });
          update({ sessionUpdate: "tool_call", toolCallId: "check-deployment", title: "Bash", kind: "execute", status: "in_progress",
            rawInput: { command: "check-deployment" } });
        }}>Start woken work</Button>
        <Button onClick={() => {
          update({ sessionUpdate: "tool_call_update", toolCallId: "check-deployment", status: "completed", rawOutput: { output: "Deployment ready" } });
          update({ sessionUpdate: "agent_message_chunk", messageId: "ready-answer", phase: "final_answer", content: { type: "text", text: "The deployment is ready. All health checks passed." } });
          snapshot("idle");
        }}>Finish woken work</Button>
        <Button onClick={() => { setSource("loop_wakeup"); reset(startedAt); }}>Reset as loop</Button>
        <Button onClick={() => { setSource("schedule_wakeup"); reset(startedAt); }}>Reset as scheduled task</Button>
      </div>
      <output data-wakeup-copy>{formatTranscript(slot.messages, "concise").text}</output>
    </section>
  );
}

// Real transcript/store/tab projections for the background-continuation smoke.
import { useState } from "react";
import type {
  SessionUpdate,
  BackgroundTasksUpdate,
} from "@zeros/protocol/agent-events";
import { applyUpdate } from "@zeros/protocol/agent-messages";
import { AgentActivityIndicator } from "../features/agent/agent-activity-indicator";
import {
  BLANK,
  useSessionsStore,
  useChatAgentActivity,
  useAnyChatAgentActivity,
} from "../features/agent/sessions-store";
import { loadedBackgroundTaskState } from "../features/agent/background-task-state";
import { turnFooterDuration } from "../features/agent/turn-footer";
import { formatElapsed } from "../shared/ui/loading";
import { TurnEventList } from "../features/agent/turn-event-list";
import type { RendererContext } from "../features/agent/renderers";
import { Button } from "../shared/ui/primitives/button";

const CHAT = "claude-background-fixture";
const EXECUTION = "claude-background-execution";
const CHAT_IDS = [CHAT, "other-working-chat"];

export function ClaudeBackgroundFixture({ ctx }: { ctx: RendererContext }) {
  const [startedAt] = useState(() => {
    const startedAt = Date.now() - 65_000;
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "first-answer",
        phase: "final_answer",
        content: {
          type: "text",
          text: "The implementation is ready. Tests are still running.",
        },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "background-test",
        title: "Background Task",
        kind: "background_task",
        status: "in_progress",
        rawInput: {
          taskId: "test-1",
          name: "Full test suite",
          command: "pnpm test:git",
        },
      },
    ];
    useSessionsStore.getState().setSession(CHAT, {
      ...BLANK,
      agentId: "claude",
      sessionId: EXECUTION,
      status: "ready",
      ...loadedBackgroundTaskState({
        sessionUpdate: "background_tasks_update",
        tasks: [
          { taskId: "test-1", name: "Tests", startedAt, updatedAt: startedAt },
        ],
        waiting: true,
        activity: { state: "idle", startedAt },
      }),
      messages: updates.reduce(
        (messages, update) =>
          applyUpdate(messages, { sessionId: EXECUTION, update }),
        BLANK.messages,
      ),
    });
    return startedAt;
  });
  const [active, setActive] = useState(true);
  const slot = useSessionsStore((state) => state.sessions[CHAT]);
  const activity = useChatAgentActivity(CHAT);
  const workspaceActivity = useAnyChatAgentActivity(CHAT_IDS);
  const update = (update: SessionUpdate) =>
    useSessionsStore
      .getState()
      .applyBridgeUpdate({ sessionId: EXECUTION, update });
  const snapshot = (
    state: "running" | "idle",
    tasks = slot.backgroundTasks,
  ): BackgroundTasksUpdate => ({
    sessionUpdate: "background_tasks_update",
    tasks,
    waiting: state === "idle" && tasks.length > 0,
    activity: { state, startedAt },
  });
  return (
    <section id="claude-background-fixture" className="flex flex-col gap-3">
      <div className="flex gap-3">
        <span id="background-chat-tab">
          <AgentActivityIndicator activity={activity} />
        </span>
        <span id="background-workspace-tab">
          <AgentActivityIndicator activity={workspaceActivity} />
        </span>
      </div>
      <div
        id="background-transcript"
        {...(!active ? { inert: "" } : {})}
        style={{ visibility: active ? "visible" : "hidden" }}
      >
        <TurnEventList
          events={slot.messages}
          isActive
          isStreaming={activity === "running"}
          backgroundTasks={
            activity === "waiting" ? slot.backgroundTasks : undefined
          }
          surfaceActive={active}
          activityStartedAt={startedAt}
          ctx={{
            ...ctx,
            isStreaming: activity === "running",
            attachmentImagesActive: active,
          }}
          footer={
            activity !== "running" ? (
              <div data-testid="background-output-footer">
                Output footer ·{" "}
                {formatElapsed(
                  turnFooterDuration(
                    { startedAt, endedAt: startedAt + 60_000 },
                    slot.messages,
                    startedAt,
                  ),
                )}
              </div>
            ) : null
          }
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            update(
              snapshot("idle", [
                {
                  taskId: "test-1",
                  name: "First child",
                  startedAt,
                  updatedAt: startedAt,
                },
                {
                  taskId: "test-2",
                  name: "Second child",
                  startedAt,
                  updatedAt: startedAt,
                },
              ]),
            )
          }
        >
          Run two children
        </Button>
        <Button
          onClick={() => {
            useSessionsStore
              .getState()
              .setSession(CHAT, { ...slot, status: "streaming" });
            const remaining = slot.backgroundTasks.filter(
              (task) => task.taskId !== "test-1",
            );
            update(snapshot("running", remaining));
            update({
              sessionUpdate: "agent_message_chunk",
              messageId: "interim-answer",
              phase: "final_answer",
              content: {
                type: "text",
                text: "One child is done. The second child is still working.",
              },
            });
            // Native assistant end_turn can precede the SDK's held-back Result.
            update(snapshot("idle", remaining));
          }}
        >
          Complete first child
        </Button>
        <Button
          onClick={() =>
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: "background-test",
              rawOutput: {
                status: "running",
                summary: "A child finished its portion.",
              },
            })
          }
        >
          Child progress
        </Button>
        <Button
          onClick={() => {
            update(snapshot("running", []));
            update({
              sessionUpdate: "agent_message_chunk",
              messageId: "continued-answer",
              content: {
                type: "text",
                text: "The background tests passed. Reviewing the final changes.",
              },
            });
          }}
        >
          Resume parent
        </Button>
        <Button
          onClick={() => {
            useSessionsStore
              .getState()
              .setSession(CHAT, { ...slot, status: "ready" });
            update({
              sessionUpdate: "agent_message_chunk",
              messageId: "last-answer",
              phase: "final_answer",
              content: {
                type: "text",
                text: "Both child agents have completed their work.",
              },
            });
            update({
              sessionUpdate: "tool_call_update",
              toolCallId: "background-test",
              status: "completed",
              rawOutput: { status: "completed", summary: "Tests passed" },
            });
            // Simulate a persisted final reply fifteen minutes after the first
            // result; this exercises the production footer duration projection.
            const current = useSessionsStore.getState().sessions[CHAT];
            useSessionsStore.getState().setSession(CHAT, {
              ...current,
              messages: current.messages.map((message) =>
                message.kind === "text" && message.messageId === "last-answer"
                  ? { ...message, updatedAt: startedAt + 900_000 }
                  : message,
              ),
            });
            update(snapshot("idle", []));
          }}
        >
          Complete parent
        </Button>
        <Button
          onClick={() => {
            const retained = slot;
            const live = snapshot(activity === "running" ? "running" : "idle");
            useSessionsStore
              .getState()
              .setSession(CHAT, {
                ...BLANK,
                ...retained,
                ...loadedBackgroundTaskState(live),
              });
          }}
        >
          Reload activity
        </Button>
        <Button
          onClick={() =>
            useSessionsStore
              .getState()
              .setSession("other-working-chat", {
                ...BLANK,
                agentId: "codex",
                status: "streaming",
              })
          }
        >
          Start other chat
        </Button>
        <Button
          onClick={() =>
            useSessionsStore.getState().setSession("other-working-chat", BLANK)
          }
        >
          Stop other chat
        </Button>
        <Button
          onClick={() => {
            update(
              snapshot("idle", [
                {
                  taskId: "test-2",
                  name: "Follow-up",
                  startedAt,
                  updatedAt: startedAt,
                },
              ]),
            );
          }}
        >
          Wait again
        </Button>
        <Button
          onClick={() =>
            useSessionsStore
              .getState()
              .patchSession(CHAT, {
                ...loadedBackgroundTaskState(),
                lastStopReason: "cancelled",
              })
          }
        >
          Stop background work
        </Button>
        <Button onClick={() => setActive((value) => !value)}>
          Toggle background visibility
        </Button>
      </div>
    </section>
  );
}

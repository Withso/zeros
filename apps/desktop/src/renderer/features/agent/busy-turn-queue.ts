import type { AgentMessage, AgentTextMessage } from "@zeros/protocol/agent-messages";

/** What the session adopts when a send is queued behind a running turn. */
export interface QueuedBehindTurn {
  messages: AgentMessage[];
  status: "streaming";
  error: null;
  failure: null;
  lastStopReason: null;
  foregroundTurnId: string;
  activeTurnStartedAt: number;
}

/** The engine refused a send because another turn already runs on this
 *  session: an agent's message through the Zeros Local CLI, or a send from
 *  another window. Nothing was delivered or persisted, so this is not a
 *  failure. Return the refused bubble to the follow-up queue (the composer's
 *  queued card, where Send now can still steer it) and adopt the running turn,
 *  whose terminal `turn_state` releases the queue. The bubble leaves the
 *  transcript, so the running turn's output never groups under it.
 *  Null when the bubble is gone (Stop, reload or edit already settled it). */
export function queueBehindRunningTurn(input: {
  messages: AgentMessage[];
  bubbleId: string;
  editable: boolean;
  activeTurn: { turnId: string; startedAt: number };
}): QueuedBehindTurn | null {
  const index = input.messages.findIndex(
    (message) => message.kind === "text" && message.role === "user" && message.id === input.bubbleId,
  );
  if (index < 0) return null;
  const bubble = input.messages[index] as AgentTextMessage;
  const queued: AgentTextMessage = {
    ...bubble,
    queued: true,
    queuedEditable: input.editable,
    queuedPresentation: undefined,
    queuedDelivery: undefined,
  };
  const messages = [...input.messages];
  messages[index] = queued;
  return {
    messages,
    status: "streaming",
    error: null,
    failure: null,
    lastStopReason: null,
    foregroundTurnId: input.activeTurn.turnId,
    activeTurnStartedAt: input.activeTurn.startedAt,
  };
}

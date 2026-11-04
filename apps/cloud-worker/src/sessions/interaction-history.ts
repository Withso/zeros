import { buildQuestionStamp } from "@zeros/protocol/agent-messages";
import type { QuestionRequest, QuestionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@zeros/protocol/agent-events";

export type SavedInteraction = { id: string; expiresAt: number } & (
  | { kind: "question"; request: QuestionRequest }
  | { kind: "permission"; request: RequestPermissionRequest }
);
export type InteractionResponse = QuestionResponse | RequestPermissionResponse;
export const INPUT_STOPPED = "dismissed when the workspace stopped";
export const INPUT_TIMEOUT = "dismissed after 15 minutes without an answer";
export const INPUT_CANCELLED = "dismissed when the turn stopped";

export function interactionStarted(value: SavedInteraction): SessionNotification {
  const request = value.request;
  return { sessionId: request.sessionId, update: value.kind === "question" ? {
    sessionUpdate: "tool_call", toolCallId: value.request.toolCallId ?? value.id,
    nativeToolCallId: value.request.nativeRequestId, title: "User input", kind: "question", status: "in_progress",
    rawInput: { questions: value.request.questions.map(question => ({ ...question, question: question.prompt })) },
  } : { ...value.request.toolCall, sessionUpdate: "tool_call", status: "pending" } };
}

export function interactionSettled(value: SavedInteraction, response: InteractionResponse, reason?: string): SessionNotification {
  if (value.kind === "question") {
    const outcome = (response as QuestionResponse).outcome;
    return { sessionId: value.request.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: value.request.toolCallId ?? value.id,
      status: "completed", rawOutput: { zerosQuestion: { ...buildQuestionStamp(value.request, outcome), ...(reason ? { summary: reason } : {}) } } } };
  }
  const outcome = (response as RequestPermissionResponse).outcome;
  const allowed = outcome.outcome === "selected" && value.request.options.some(option => option.optionId === outcome.optionId && option.kind.startsWith("allow"));
  return { sessionId: value.request.sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: value.request.toolCall.toolCallId,
    status: allowed ? "completed" : "failed", rawOutput: { message: reason ?? (allowed ? "Approved" : "Denied"), ...(reason ? { zerosInputDismissal: reason } : {}) } } };
}

export function cancelledInteraction(value: SavedInteraction): InteractionResponse {
  return value.kind === "question" ? { outcome: { outcome: "dismissed" } } : { outcome: { outcome: "cancelled" } };
}

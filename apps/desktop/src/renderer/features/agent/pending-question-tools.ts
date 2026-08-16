import {
  readQuestionStamp,
  type AgentMessage,
  type AgentToolMessage,
} from "./use-agent-session";
import type { QuestionRequest } from "../../platform/bridge/agent-events";

export interface PendingQuestionLike {
  questionId: string;
  request: QuestionRequest;
}

/** True only for a provider-native Browser-use approval. Scoped Browser Stop
 * uses this to release an MCP elicitation without dismissing an unrelated
 * AskUserQuestion that happens to be queued in the same Codex turn. */
export function questionRequestIsBrowserApproval(
  request: QuestionRequest,
): boolean {
  return (
    request.questions.length > 0 &&
    request.questions.every(
      (question) =>
        question.presentation === "one_click_approval" &&
        (question.approvalKind === "browser_origin" ||
          (question.approvalKind === "tool" &&
            question.header?.trim().toLowerCase() === "browser use")),
    )
  );
}

function addIfString(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) ids.add(value);
}

function questionPromptsFromToolInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions
    .map((q) => {
      if (!q || typeof q !== "object") return "";
      const rec = q as {
        prompt?: unknown;
        question?: unknown;
        header?: unknown;
      };
      const prompt =
        typeof rec.prompt === "string"
          ? rec.prompt
          : typeof rec.question === "string"
            ? rec.question
            : typeof rec.header === "string"
              ? rec.header
              : "";
      return prompt.trim().replace(/\s+/g, " ").toLowerCase();
    })
    .filter(Boolean);
}

function questionRequestSignature(request: QuestionRequest): string | null {
  const prompts = request.questions
    .map((q) => q.prompt.trim().replace(/\s+/g, " ").toLowerCase())
    .filter(Boolean);
  return prompts.length > 0 ? prompts.join("\n") : null;
}

function questionToolSignature(tool: AgentToolMessage): string | null {
  const prompts = questionPromptsFromToolInput(tool.rawInput);
  return prompts.length > 0 ? prompts.join("\n") : null;
}

/** IDs that identify transcript question rows currently awaiting a user reply.
 *
 * Blocking-question requests often carry the vendor/native tool id while the
 * transcript row uses a locally minted id. Some dialog paths have no native id,
 * so we also correlate by the question prompt payload. The returned set
 * includes every matching row id flavor so renderers can check their own
 * toolCallId/nativeToolCallId without knowing adapter-specific details.
 */
export function collectPendingQuestionToolCallIds(
  pendingQuestions: readonly PendingQuestionLike[] | undefined,
  messages: readonly AgentMessage[],
): Set<string> {
  const ids = new Set<string>();
  const pending = pendingQuestions ?? [];
  if (pending.length === 0) return ids;

  const requestIds = new Set<string>();
  const requestSignatures = new Set<string>();
  for (const q of pending) {
    addIfString(requestIds, q.questionId);
    addIfString(requestIds, q.request.questionId);
    addIfString(requestIds, q.request.toolCallId);
    addIfString(requestIds, q.request.nativeRequestId);
    const signature = questionRequestSignature(q.request);
    if (signature) requestSignatures.add(signature);
  }

  for (const id of requestIds) ids.add(id);

  for (const message of messages) {
    if (message.kind !== "tool") continue;
    const tool = message as AgentToolMessage;
    if (tool.toolKind !== "question") continue;
    if (readQuestionStamp(tool.rawOutput)) continue;

    const directMatch =
      requestIds.has(tool.toolCallId) ||
      (!!tool.nativeToolCallId && requestIds.has(tool.nativeToolCallId));
    const signature = questionToolSignature(tool);
    const contentMatch = !!signature && requestSignatures.has(signature);

    if (!directMatch && !contentMatch) continue;
    addIfString(ids, tool.toolCallId);
    addIfString(ids, tool.nativeToolCallId);
  }

  return ids;
}

import { randomUUID } from "node:crypto";
import type { CloudV2Agent } from "@zeros/protocol/cloud-v2-relay";
import type { QuestionRequest, QuestionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@zeros/protocol/agent-events";
import { createMessage, type BridgeMessage } from "@zeros/protocol/messages";
import { CLOUD_INPUT_TIMEOUT_MS } from "./drivers/shared/native-input";
import type { SessionStore } from "./sessions/session-store";
import { cancelledInteraction, INPUT_CANCELLED, INPUT_TIMEOUT, interactionSettled, interactionStarted, type InteractionResponse, type SavedInteraction } from "./sessions/interaction-history";
import { WorkspaceError } from "./workspace/scope";

interface Pending {
  value: SavedInteraction;
  response: Promise<InteractionResponse>;
  resolve: (response: InteractionResponse) => void;
  ready?: Promise<void>;
  finishing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
}
interface Owner {
  chatId: string; executionId: string; agentId: CloudV2Agent;
  current(): boolean;
  enqueue(work: () => Promise<void>): Promise<void>;
  publish(frame: BridgeMessage): Promise<void>;
  update(notification: SessionNotification): Promise<void>;
  activity(): void;
  timeout(reason: string): void;
}

/** Native resolvers belong to this execution, never to an attached app socket. */
export class AgentInteractions {
  private readonly pending = new Map<string, Pending>();
  private readonly settled = new Map<string, BridgeMessage>();
  constructor(private readonly store: SessionStore, private readonly owner: Owner) {}

  get blocking(): boolean { return [...this.pending.values()].some(({ value }) => value.kind === "permission" || value.request.blocking); }
  get toolIds(): Set<string> { return new Set([...this.pending.values()].flatMap(({ value }) => value.kind === "question"
    ? [value.request.toolCallId ?? value.id, value.request.nativeRequestId] : [value.request.toolCall.toolCallId, value.request.toolCall.nativeToolCallId ?? ""])); }

  question(request: QuestionRequest, signal?: AbortSignal): Promise<QuestionResponse> {
    const expiresAt = Math.min(request.expiresAt ?? Infinity, Date.now() + CLOUD_INPUT_TIMEOUT_MS);
    return this.add({ kind: "question", id: request.questionId, expiresAt, request: { ...request, expiresAt,
      sessionId: this.owner.executionId, executionId: this.owner.executionId } }, signal) as Promise<QuestionResponse>;
  }
  permission(request: RequestPermissionRequest, signal?: AbortSignal): Promise<RequestPermissionResponse> {
    return this.add({ kind: "permission", id: randomUUID(), expiresAt: Date.now() + CLOUD_INPUT_TIMEOUT_MS,
      request: { ...request, sessionId: this.owner.executionId, executionId: this.owner.executionId } }, signal) as Promise<RequestPermissionResponse>;
  }

  private add(value: SavedInteraction, signal?: AbortSignal): Promise<InteractionResponse> {
    if (!this.owner.current() || signal?.aborted) return Promise.resolve(cancelledInteraction(value));
    const duplicate = [...this.pending.values()].find(pending => pending.value.kind === value.kind &&
      pending.value.request.nativeRequestId === value.request.nativeRequestId);
    if (duplicate) return duplicate.response;
    if (this.pending.size >= 128) return Promise.resolve(cancelledInteraction(value));
    let resolve!: Pending["resolve"];
    const response = new Promise<InteractionResponse>(yes => { resolve = yes; });
    const pending: Pending = { value, response, resolve };
    this.pending.set(value.id, pending);
    pending.ready = this.owner.enqueue(async () => {
      if (!this.owner.current()) throw new WorkspaceError("session-expired", "This execution has ended.");
      const notification = interactionStarted(value);
      await this.store.saveInteraction(this.owner.chatId, value, notification);
      await this.owner.update(notification);
      if (!pending.finishing) await this.owner.publish(this.requestFrame(value));
    });
    void pending.ready.catch(() => {
      this.pending.delete(value.id); clearTimeout(pending.timer); pending.detach?.(); pending.resolve(cancelledInteraction(value));
      this.owner.timeout(INPUT_CANCELLED);
    });
    const abort = () => { void this.finish(pending, cancelledInteraction(value), INPUT_CANCELLED).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    pending.detach = () => signal?.removeEventListener("abort", abort);
    pending.timer = setTimeout(() => {
      if (pending.finishing) return;
      if (value.kind === "question" && !value.request.blocking) void this.finish(pending, cancelledInteraction(value), INPUT_TIMEOUT).catch(() => {});
      else this.owner.timeout(INPUT_TIMEOUT);
    }, Math.max(0, value.expiresAt - Date.now()));
    pending.timer.unref?.();
    void pending.ready.then(() => this.owner.activity(), () => {});
    return response;
  }

  async replay(send: (message: BridgeMessage) => Promise<void>): Promise<void> {
    for (const pending of this.pending.values()) {
      await pending.ready;
      if (!pending.finishing) await send(this.requestFrame(pending.value));
    }
  }

  async reply(kind: SavedInteraction["kind"], id: string, response: InteractionResponse, nativeRequestId?: string): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.value.kind !== kind) {
      const previous = this.settled.get(`${kind}:${id}`);
      if (previous) await this.owner.publish(previous);
      return;
    }
    if (nativeRequestId !== undefined && nativeRequestId !== pending.value.request.nativeRequestId) return;
    if (!validResponse(pending.value, response)) throw new WorkspaceError("invalid-params", "This answer is not one of the requested choices.");
    await this.finish(pending, response);
  }

  async allowPending(): Promise<void> {
    await Promise.all([...this.pending.values()].map(pending => {
      if (pending.value.kind !== "permission" || pending.value.request.requiresExplicitApproval) return;
      const option = pending.value.request.options.find(option => option.kind === "allow_once");
      if (option) return this.finish(pending, { outcome: { outcome: "selected", optionId: option.optionId } });
    }));
  }

  async dismiss(reason: string): Promise<void> {
    await Promise.all([...this.pending.values()].map(pending => this.finish(pending, cancelledInteraction(pending.value), reason)));
  }

  private finish(pending: Pending, response: InteractionResponse, reason?: string): Promise<void> {
    if (pending.finishing) return pending.finishing;
    clearTimeout(pending.timer); pending.detach?.();
    const value = pending.value;
    let committed = false;
    pending.finishing = this.owner.enqueue(async () => {
      const notification = interactionSettled(value, response, reason);
      await this.store.finishInteraction(this.owner.chatId, value, notification);
      committed = true;
      await this.owner.update(notification);
      const frame = value.kind === "question" ? createMessage({ type: "AGENT_QUESTION_SETTLED", source: "engine", agentId: this.owner.agentId,
        chatId: this.owner.chatId, questionId: value.id, outcome: publicQuestionResponse(value.request, response as QuestionResponse).outcome })
        : createMessage({ type: "AGENT_PERMISSION_SETTLED", source: "engine", agentId: this.owner.agentId, chatId: this.owner.chatId,
            permissionId: value.id, sessionId: this.owner.executionId, executionId: this.owner.executionId });
      this.settled.set(`${value.kind}:${value.id}`, frame);
      if (this.settled.size > 256) this.settled.delete(this.settled.keys().next().value!);
      await this.owner.publish(frame);
    }).catch(error => { this.owner.timeout(INPUT_CANCELLED); throw error; }).finally(() => {
      this.pending.delete(value.id); pending.resolve(committed ? response : cancelledInteraction(value)); this.owner.activity();
    });
    return pending.finishing;
  }

  private requestFrame(value: SavedInteraction): BridgeMessage {
    return value.kind === "question" ? createMessage({ type: "AGENT_QUESTION_REQUEST", source: "engine", agentId: this.owner.agentId,
      chatId: this.owner.chatId, questionId: value.id, request: value.request }) : createMessage({ type: "AGENT_PERMISSION_REQUEST", source: "engine",
      agentId: this.owner.agentId, chatId: this.owner.chatId, permissionId: value.id, request: value.request });
  }
}

function validResponse(value: SavedInteraction, response: InteractionResponse): boolean {
  if (value.kind === "permission") {
    const outcome = (response as RequestPermissionResponse).outcome;
    return outcome.outcome === "cancelled" || outcome.outcome === "selected" && value.request.options.some(option => option.optionId === outcome.optionId);
  }
  const outcome = (response as QuestionResponse).outcome;
  if (outcome.outcome !== "answered") return outcome.outcome === "dismissed" || outcome.outcome === "declined";
  const questions = value.request.questions;
  if (outcome.answers.length !== questions.length || new Set(outcome.answers.map(answer => answer.questionId)).size !== questions.length) return false;
  return outcome.answers.every(answer => {
    const question = questions.find(question => question.id === answer.questionId);
    return !!question && (question.multiSelect || answer.selectedOptionIds.length <= 1) &&
      answer.selectedOptionIds.every(id => question.options.some(option => option.id === id)) &&
      (answer.freeText === undefined || question.allowOther) &&
      (answer.selectedOptionIds.length > 0 || !!answer.freeText || question.allowEmptyFreeText === true && answer.freeText === "");
  });
}
function publicQuestionResponse(request: QuestionRequest, response: QuestionResponse): QuestionResponse {
  return response.outcome.outcome !== "answered" ? response : { outcome: { outcome: "answered", answers: response.outcome.answers.map(answer =>
    request.questions.find(question => question.id === answer.questionId)?.secret
      ? { questionId: answer.questionId, selectedOptionIds: [], freeText: "(secret answer hidden)" } : answer) } };
}

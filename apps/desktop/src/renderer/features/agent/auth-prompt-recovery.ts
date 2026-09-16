import type { AgentMessage, AgentTextMessage } from "./use-agent-session";
import type { SessionsActions } from "./sessions-context";

type PromptArgs = Parameters<SessionsActions["sendPrompt"]>;
export class AuthPromptRecovery {
  private entries = new Map<
    string,
    { chatId: string; agentId: string; args: PromptArgs }
  >();
  remember(
    chatId: string,
    agentId: string,
    messageId: string,
    args: PromptArgs,
  ): void {
    this.entries.delete(messageId);
    this.entries.set(messageId, { chatId, agentId, args });
    while (this.entries.size > 32)
      this.entries.delete(this.entries.keys().next().value!);
  }
  read(
    chatId: string,
    agentId: string,
    messageId: string,
  ): PromptArgs | undefined {
    const entry = this.entries.get(messageId);
    return entry?.agentId === agentId && entry.chatId === chatId
      ? entry.args
      : undefined;
  }
  delete(chatId: string): void {
    for (const [id, entry] of this.entries)
      if (entry.chatId === chatId) this.entries.delete(id);
  }
  clear(): void {
    this.entries.clear();
  }
}

export function lastUserPrompt(
  messages: readonly AgentMessage[],
): AgentTextMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.kind === "text" && message.role === "user" && !message.queued)
      return message;
  }
  return undefined;
}

// Compatibility for already-persisted provider failures. Ordinary assistant
// discussion of OAuth/keys is not an authentication gate.
export function isAuthenticationNotice(message: AgentMessage): boolean {
  return (
    message.kind === "text" &&
    message.role !== "user" &&
    /^(?:Failed to authenticate\b|Authentication (?:required|failed)\b|OAuth session expired\b|Invalid API key\b|Unauthorized\b|Not (?:logged|signed) in\b)/i.test(
      message.text.trim(),
    )
  );
}
export function authenticationTurn(
  events: readonly AgentMessage[],
  failureKind?: string,
): boolean {
  // A typed provider failure outranks legacy notice wording. A model or rate
  // error can quote sign-in advice without requiring authentication.
  const kind = failureKind ?? latestTurnFailureKind(events);
  if (kind) return kind === "auth-required";
  return events.some(isAuthenticationNotice);
}

function latestTurnFailureKind(events: readonly AgentMessage[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === "error_notice" && !event.parentToolId && !event.recoverable && event.severity === "error" && event.turnFailure) return event.turnFailure.kind;
  }
  return undefined;
}
export function authenticationTurnOutput(
  events: AgentMessage[],
): AgentMessage[] {
  return events.filter(
    (event) =>
      !isAuthenticationNotice(event) &&
      !(
        event.kind === "tool" &&
        event.toolKind === "model_switch" &&
        (event.rawInput as { toModel?: string } | undefined)?.toModel ===
          "<synthetic>"
      ),
  );
}

/** Auth is a product notice only while it owns the visual tail. Once the user
 * sends again, the earlier turn is settled history with the normal footer. */
export function authenticationTurnState(input: {
  userPrompt: AgentTextMessage | null | undefined;
  events: readonly AgentMessage[];
  failureKind?: string;
  isTail: boolean;
  inFlight: boolean;
}): "sign-in" | "stopped" | null {
  if (!input.userPrompt) return null;
  const kind = (input.isTail ? input.failureKind : undefined) ?? latestTurnFailureKind(input.events);
  const blocked = kind ? kind === "auth-required" : !!input.userPrompt.authRecovery || authenticationTurn(input.events);
  if (!blocked) return null;
  if (!input.isTail) return "stopped";
  return input.inFlight ? null : "sign-in";
}

/** These messages remain in Zeros history but may never have reached the
 * provider. Carry them as context on the next ordinary send, once. The next
 * unblocked user message becomes the boundary, so later sends do not replay
 * them again. The current admission placeholder is excluded by identity. */
export function pendingAuthenticationPrompts(
  messages: readonly AgentMessage[],
  currentMessageId?: string,
): AgentTextMessage[] {
  const pending: AgentTextMessage[] = [];
  let legacyFailure = false;
  let terminal: { turnId: string; kind: string } | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.kind === "error_notice" && !message.parentToolId && !message.recoverable && message.severity === "error") terminal ??= message.turnFailure;
    if (isAuthenticationNotice(message)) legacyFailure = true;
    if (
      message.kind !== "text" ||
      message.role !== "user" ||
      message.queued ||
      message.id === currentMessageId
    )
      continue;
    const blocked = terminal?.turnId === message.id
      ? terminal.kind === "auth-required"
      : !!message.authRecovery || legacyFailure;
    if (!blocked) break;
    pending.push(
      message.authRecovery
        ? message
        : {
            ...message,
            authRecovery: { text: message.text },
          },
    );
    legacyFailure = false;
    terminal = undefined;
  }
  return pending.reverse();
}

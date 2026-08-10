import type { ChatRow } from "../db/chats";

export interface CodexChatForkDependencies {
  getSourceChat(sessionId: string): ChatRow | null;
  invoke(params: Record<string, unknown>): Promise<unknown>;
  persist(chat: ChatRow): void;
  rollbackNative(nativeThreadId: string, sessionId: string, cwd: string): Promise<void>;
  createId(): string;
  now(): number;
}

export interface CodexChatForkResult {
  native: unknown;
  zerosChat: ChatRow;
}

/** Fork one native Codex thread and bind the result to a durable Zeros chat.
 * The native operation happens first because its generated id is authoritative.
 * Persistence failure is compensated by deleting that native thread so callers
 * never receive a half-created chat/thread pair. */
export async function forkCodexChat(
  sessionId: string,
  cwd: string,
  params: unknown,
  dependencies: CodexChatForkDependencies,
): Promise<CodexChatForkResult> {
  if (!sessionId) throw new Error("An active Zeros Codex session is required.");
  const source = dependencies.getSourceChat(sessionId);
  const sourceNativeId = source?.nativeSessionId ?? source?.sessionId;
  if (
    !source ||
    source.agentId !== "codex" ||
    source.sessionId !== sessionId ||
    !sourceNativeId
  ) {
    throw new Error("The active Zeros chat is not bound to a native Codex thread.");
  }
  const input = record(params);
  if (input.path !== undefined && input.path !== null && input.path !== "") {
    throw new Error("Zeros forks only the native thread bound to the active chat.");
  }
  if (input.threadId !== sourceNativeId) {
    throw new Error("The requested Codex thread does not match the active Zeros chat.");
  }
  if (cwd && cwd !== source.folder) {
    throw new Error("The requested fork directory does not match the active chat.");
  }

  const native = await dependencies.invoke({
    ...input,
    threadId: sourceNativeId,
    cwd: source.folder,
    path: null,
    ephemeral: false,
  });
  const response = record(native);
  const thread = record(response.thread);
  const nativeThreadId =
    typeof thread.id === "string" && thread.id.trim() ? thread.id : null;
  if (!nativeThreadId) {
    throw new Error("Codex returned a fork without a native thread id.");
  }
  if (
    typeof thread.forkedFromId === "string" &&
    thread.forkedFromId !== sourceNativeId
  ) {
    throw new Error("Codex returned a fork from a different source thread.");
  }

  const newSessionId = dependencies.createId();
  const createdAt = dependencies.now();
  const titleBase = source.title.trim() || "Untitled";
  const zerosChat: ChatRow = {
    ...source,
    id: dependencies.createId(),
    model:
      typeof response.model === "string" && response.model.trim()
        ? response.model
        : source.model,
    title: `${titleBase} (fork)`.slice(0, 200),
    createdAt,
    updatedAt: createdAt,
    sessionId: newSessionId,
    nativeSessionId: nativeThreadId,
    pinned: false,
    archived: false,
    sourceChatId: null,
  };

  try {
    dependencies.persist(zerosChat);
  } catch (error) {
    await dependencies
      .rollbackNative(nativeThreadId, newSessionId, source.folder)
      .catch(() => undefined);
    throw new Error(
      `Couldn't persist the forked Zeros chat: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { native, zerosChat };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

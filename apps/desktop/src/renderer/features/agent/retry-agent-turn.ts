import type {
  AgentMessage,
  AgentTextMessage,
  MessageContentSegment,
} from "@zeros/protocol/agent-messages";
import type { ChatThread } from "../../state/store";
import type { SessionsActions } from "./sessions-context";
import { messageToEditorContent } from "./composer-editor/reconstruct";
import { encodeAttachments } from "./encode-attachments";
import { loadTranscriptSnapshot } from "./chat-transcript-attach";
import { buildForkTranscriptAttachment, createForkedChat } from "./fork-chat";
import { envForChat } from "./model-catalog";
import type { ComposerAttachment } from "./composer-attachments";
import { lastUserPrompt } from "./auth-prompt-recovery";

// Shared across retained surfaces/remounts; entries live only during a retry.
const pending = new Set<string>();

function readRetryTranscript(
  source: ChatThread,
  prompt: AgentTextMessage,
  events: AgentMessage[],
) {
  return loadTranscriptSnapshot({
    chatId: source.id,
    mode: "concise",
    throughMessageId: prompt.id,
    lastMessageAt: events.reduce(
      (latest, event) => Math.max(latest, event.createdAt),
      source.updatedAt,
    ),
    meta: { title: source.title, folder: source.folder },
  });
}

export function warmRetryTranscript(
  source: ChatThread,
  prompt: AgentTextMessage,
  events: AgentMessage[],
): void {
  void readRetryTranscript(source, prompt, events).catch(() => {});
}

export function turnProducedWork(events: AgentMessage[]): boolean {
  return events.some(
    (event) =>
      (!("parentToolId" in event) || !event.parentToolId) &&
      (event.kind === "tool" ||
        event.kind === "thinking" ||
        (event.kind === "text" &&
          (event.role === "agent" || event.role === "thought") &&
          event.text.trim().length > 0)),
  );
}

export interface RetryAgentTurnRequest {
  chatId: string;
  prompt: AgentTextMessage;
  events: AgentMessage[];
  newChat: boolean;
}

interface RetryDependencies {
  sessions: Pick<
    SessionsActions,
    | "getSession"
    | "getSendGeneration"
    | "getCloseActivity"
    | "ensureSession"
    | "sendPrompt"
  >;
  getChat(id: string): ChatThread | undefined;
  /** Publish route and destination in the same synchronous store transition. */
  publishChat(chat: ChatThread): void;
}

/** Explicit user retry. Keep the failed history and composer draft, reconstruct
 * attachments from durable references, and revalidate ownership after awaits. */
export async function retryAgentTurn(
  request: RetryAgentTurnRequest,
  deps: RetryDependencies,
): Promise<void> {
  const { chatId, prompt } = request;
  if (pending.has(chatId)) return;
  const source = deps.getChat(chatId);
  const sourceSession = deps.sessions.getSession(chatId);
  if (!source?.agentId || !sourceSession) return;
  const sourceGeneration = deps.sessions.getSendGeneration(chatId);
  const ownsSource = () => {
    const chat = deps.getChat(chatId);
    const session = deps.sessions.getSession(chatId);
    const activity = deps.sessions.getCloseActivity(chatId);
    const lastPrompt = session && lastUserPrompt(session.messages);
    return (
      deps.sessions.getSendGeneration(chatId) === sourceGeneration &&
      chat?.agentId === source.agentId &&
      chat?.folder === source.folder &&
      lastPrompt?.id === prompt.id &&
      !activity.running &&
      activity.queuedCount === 0
    );
  };
  if (!ownsSource()) return;
  // A Design execution may recover only within its existing document scope.
  if (request.newChat && sourceSession.agentRole === "design") return;
  pending.add(chatId);
  try {
    const destination = request.newChat ? createForkedChat(source) : source;
    const transcript = request.newChat
      ? readRetryTranscript(source, prompt, request.events)
      : null;
    if (request.newChat) deps.publishChat(destination);
    const destinationGeneration = deps.sessions.getSendGeneration(
      destination.id,
    );
    const ownsDestination = () => {
      const chat = deps.getChat(destination.id);
      const slot = deps.sessions.getSession(destination.id);
      return (
        chat?.agentId === source.agentId &&
        chat?.folder === source.folder &&
        deps.sessions.getSendGeneration(destination.id) ===
          destinationGeneration &&
        (!request.newChat || !slot || !lastUserPrompt(slot.messages))
      );
    };
    const attachments: ComposerAttachment[] = [
      ...messageToEditorContent(prompt).attachments,
    ];
    if (transcript) {
      const snapshot = await transcript;
      if (!ownsDestination() || !ownsSource()) return;
      if (snapshot.count === 0)
        throw new Error(
          "The source transcript could not be read. Retry from the original chat.",
        );
      const attachment = buildForkTranscriptAttachment({
        sourceChatId: chatId,
        sourceLabel: source.title || "Previous chat",
        text: snapshot.text,
        complete: snapshot.complete,
      });
      attachments.push({
        ...attachment,
        id: crypto.randomUUID(),
        kind: "text",
        mimeType: "text/plain",
        size: new TextEncoder().encode(attachment.text).length,
        data: "",
        validation: { ok: true },
      });
    }
    const encoded = await encodeAttachments(attachments, {
      supportsImage:
        sourceSession.initialize?.agentCapabilities?.promptCapabilities
          ?.image !== false,
      cwd: source.folder || sourceSession.cwd || null,
      chatId: destination.id,
      agentId: source.agentId,
    });
    if (encoded.skipped.length > 0) {
      throw new Error(
        `Could not retry with the original attachments: ${encoded.skipped.map((entry) => entry.name).join(", ")}. Restore them and try again.`,
      );
    }
    // Reconstruction and encoding preserve attachment order. Replace every
    // inline chip with its newly resolved metadata, then append new context
    // such as the fork transcript. Segments take precedence over the flat
    // attachment list on the next edit/retry, so both must describe this send.
    let attachmentIndex = 0;
    const segments = prompt.segments?.length
      ? prompt.segments.map((segment): MessageContentSegment =>
          segment.type === "attachment"
            ? { type: "attachment", ...encoded.bubbleAttachments[attachmentIndex++]! }
            : segment,
        )
      : undefined;
    if (segments) {
      for (const attachment of encoded.bubbleAttachments.slice(attachmentIndex))
        segments.push({ type: "attachment", ...attachment });
    }
    if (!ownsDestination() || !ownsSource()) return;
    const currentDestination = deps.getChat(destination.id)!;
    await deps.sessions.ensureSession(destination.id, source.agentId, {
      cwd: source.folder,
      env: envForChat(currentDestination, sourceSession.initialize),
      ...(sourceSession.agentRole === "design"
        ? {
            agentRole: "design",
            designDocumentId: sourceSession.designDocumentId ?? undefined,
          }
        : {}),
    });
    if (!ownsDestination() || !ownsSource()) return;
    const activity = deps.sessions.getCloseActivity(destination.id);
    if (activity.running || activity.queuedCount > 0) return;
    const original =
      prompt.retryText ?? prompt.authRecovery?.text ?? prompt.text;
    const continuing = turnProducedWork(request.events);
    // Include the request even when resuming: a provider may have confirmed a
    // fresh conversation during recovery. This also makes repeated retries
    // safe when the preceding continuation itself never reached the provider.
    const continuation =
      "Continue the interrupted request below. Check the current state and preserve completed work; do not repeat completed actions.\n\nOriginal request:\n";
    const text =
      continuing && !original.startsWith(continuation)
        ? `${continuation}${original}`
        : original;
    await deps.sessions.sendPrompt(
      destination.id,
      text,
      continuing ? "Continue" : prompt.text,
      encoded.blocks.length ? encoded.blocks : undefined,
      encoded.bubbleAttachments.length ? encoded.bubbleAttachments : undefined,
      continuing ? undefined : segments,
      prompt.autoAction,
    );
  } finally {
    pending.delete(chatId);
  }
}

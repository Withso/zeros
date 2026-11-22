// Side chats: a session opened beside the current one. From a message it
// branches there, and the source transcript through that message travels
// hidden in its first prompt; a blank one offers Add chat transcripts.

import type { Action, ChatThread } from "../../state/store";
import { requestWorkbenchReveal } from "../../shell/workbench/workbench-visibility-controller";
import { useWorkspaceStore } from "../../state/store";
import { editChat } from "../../state/cloud-chat-edits";
import { threadToRow } from "../../state/chat-row-wire";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { dbCreateChildChat } from "./agent-history-client";
import { canAddChildSession, createChildChat } from "./add-child-session";
import { loadTranscriptSnapshot, transcriptPillLabel, type TranscriptSnapshot } from "./chat-transcript-attach";
import { createForkedChat } from "./fork-chat";
import { HANDOFF_CONTEXT_OPEN } from "./harness-switch";
import { SIDE_CHAT_QUOTE_MAX, SIDE_CHAT_TITLE, getSideChatSeed, setSideChatSeed, type SideChatSeed } from "./side-chat-seeds";

export * from "./side-chat-seeds";

export interface SideChatSource {
  messageId: string;
  promptId: string | null;
  role: "user" | "agent";
  text: string;
}

export function sideChatQuote(text: string): string {
  const trimmed = text.trim().replace(/\n{3,}/g, "\n\n");
  return trimmed.length > SIDE_CHAT_QUOTE_MAX ? `${trimmed.slice(0, SIDE_CHAT_QUOTE_MAX - 1).trimEnd()}…` : trimmed;
}

/** Wire-text prefix for a side chat's first prompt. The bubble shows only
 *  what the user typed; the HANDOFF_CONTEXT_OPEN tag keeps queued copies
 *  uneditable like a harness handoff. */
export function sideChatContextPrefix(input: { sourceTitle: string; quote: string; text: string; complete?: boolean }): string {
  const omitted = input.complete === false
    ? "\n\nEarlier messages were omitted because the conversation exceeded the transcript read limit."
    : "";
  const quote = input.quote.split("\n").map((line) => `> ${line}`).join("\n");
  return `${HANDOFF_CONTEXT_OPEN} from="${input.sourceTitle.replace(/"/g, "'")}" kind="side_chat">
This is a side chat branched from another conversation at the message quoted below. The transcript is that conversation up to and including the message, for context only; it is not a new request. Answer the user message that follows it.

Branched from:
${quote}

${input.text.trimEnd()}${omitted}
</context_handoff>

User message:
`;
}

export interface SideChatTranscriptDeps {
  load?: typeof loadTranscriptSnapshot;
}

/** The source transcript through the branched message, else through its
 *  prompt. Never the whole turn: later output must not leak into the branch. */
export async function loadSideChatTranscript(
  seed: SideChatSeed,
  folder: string | null | undefined,
  deps: SideChatTranscriptDeps = {},
): Promise<TranscriptSnapshot> {
  const load = deps.load ?? loadTranscriptSnapshot;
  const meta = { title: seed.sourceTitle, folder };
  try {
    return await load({ chatId: seed.sourceChatId, mode: "handoff", lastMessageAt: seed.sourceUpdatedAt, throughMessageId: seed.messageId, cut: "message", meta });
  } catch (error) {
    if (!seed.promptId || seed.promptId === seed.messageId) throw error;
    return load({ chatId: seed.sourceChatId, mode: "handoff", lastMessageAt: seed.sourceUpdatedAt, throughMessageId: seed.promptId, cut: "message", meta });
  }
}

/** Hidden context for a pending side chat's next prompt; "" when none. */
export async function sideChatHandoffFor(
  chatId: string | null | undefined,
  folder: string | null | undefined,
  deps: SideChatTranscriptDeps = {},
): Promise<string> {
  const seed = getSideChatSeed(chatId);
  if (!seed?.pending) return "";
  const snapshot = await loadSideChatTranscript(seed, folder, deps);
  if (snapshot.count === 0) return "";
  return sideChatContextPrefix({ sourceTitle: seed.sourceTitle, quote: seed.quote, text: snapshot.text, complete: snapshot.complete });
}

export interface OpenSideChatDeps {
  /** Publish route and destination in one synchronous store transition. */
  publishChat(chat: ChatThread): void;
  createChild?: typeof dbCreateChildChat;
  chatExists?(id: string): boolean;
  warm?(seed: SideChatSeed, folder: string): void;
  now?: number;
  onError?(message: string, error: unknown): void;
}

export function sideChatSeedFor(source: ChatThread, from: SideChatSource, now = Date.now()): SideChatSeed {
  return {
    sourceChatId: source.id,
    sourceTitle: transcriptPillLabel({ title: source.title, summary: "" }),
    messageId: from.messageId,
    promptId: from.promptId,
    role: from.role,
    quote: sideChatQuote(from.text),
    pending: true,
    createdAt: now,
    sourceUpdatedAt: source.updatedAt,
  };
}

/** Warm a branch's transcript on pointer or focus intent. */
export function warmSideChat(source: ChatThread, from: SideChatSource): void {
  void loadSideChatTranscript(sideChatSeedFor(source, from), source.folder).catch(() => {});
}

/** Local side chats nest under their source as child sessions; cloud ones
 *  keep `sourceChatId` lineage, since cloud has no child links. A blank Local
 *  side chat drops `sourceChatId`: it carries no parent context, and
 *  hasParentContext must not claim it does. */
export function createSideChat(source: ChatThread, branched: boolean, now = Date.now()): ChatThread {
  if (!canAddChildSession(source)) {
    return { ...createForkedChat(source, undefined, now), title: SIDE_CHAT_TITLE };
  }
  const { sourceChatId, ...child } = createChildChat(source, undefined, now);
  return { ...(branched ? { ...child, sourceChatId } : child), title: SIDE_CHAT_TITLE };
}

const columnChatByFolder = new Map<string, string>();

/** The chat column's own selection, kept while a side chat tab has focus. */
export function rememberColumnChat(folder: string, chatId: string): void {
  columnChatByFolder.set(folder, chatId);
}

export function columnChatFor(folder: string): string | null {
  return columnChatByFolder.get(folder) ?? null;
}

/** Closing a side chat tab closes the side chat, as closing a chat tab does,
 *  and hands focus back to the chat column. */
export function closeSideChat(
  dispatch: (action: Action) => void,
  sessions: { closeSession(chatId: string): unknown; getCloseActivity(chatId: string): { running: boolean; queuedCount: number } },
  tabId: string,
  chatId: string,
): void {
  const state = useWorkspaceStore.getState();
  const chat = state.chats.find((row) => row.id === chatId);
  const wasActive = state.activeChatId === chatId;
  dispatch({ type: "REMOVE_WORKBENCH_TAB", id: tabId });
  if (!chat || chat.archived) return;
  const activity = sessions.getCloseActivity(chatId);
  const busy = activity.running || activity.queuedCount > 0;
  const closing = sessions.closeSession(chatId);
  editChat(dispatch, chatId, { archived: true }, { busy });
  if (busy && closing instanceof Promise) {
    void closing.then((confirmed) => {
      if (confirmed !== false) return;
      toast.error("Couldn't confirm the side chat stopped", {
        description: "It may still be running in the cloud workspace.",
        action: { label: "Reopen side chat", onClick: () => {
          editChat(dispatch, chatId, { archived: false });
          publishSideChat(dispatch, { ...chat, archived: false });
        } },
      });
    }).catch(() => {});
  }
  if (!wasActive) return;
  const live = useWorkspaceStore.getState().chats;
  const back = [columnChatFor(chat.folder), chat.sourceChatId, chat.parentChatId].find(
    (id) => !!id && live.some((row) => row.id === id && !row.archived && row.folder === chat.folder),
  );
  if (back) dispatch({ type: "SET_ACTIVE_CHAT", id: back });
}

/** Open a side chat as a focused tab in its workspace's Workbench. */
export function publishSideChat(dispatch: (action: Action) => void, chat: ChatThread): void {
  dispatch({ type: "OPEN_SIDE_CHAT", chat });
  requestWorkbenchReveal();
}

export function canOpenSideChat(source: ChatThread | null | undefined): source is ChatThread {
  return !!source && source.kind !== "terminal" && !source.archived && !!source.folder;
}

export function openSideChat(
  source: ChatThread,
  from: SideChatSource | null,
  deps: OpenSideChatDeps,
): ChatThread | null {
  if (!canOpenSideChat(source)) return null;
  const now = deps.now ?? Date.now();
  const {
    createChild = dbCreateChildChat,
    chatExists = (id) => useWorkspaceStore.getState().chats.some((chat) => chat.id === id),
    warm = (seed, folder) => { void loadSideChatTranscript(seed, folder).catch(() => {}); },
    onError = (message, error) => {
      console.error(`[Zeros] ${message}`, error);
      toast.error(message);
    },
  } = deps;
  const chat = createSideChat(source, from !== null, now);
  if (from) {
    const seed = sideChatSeedFor(source, from, now);
    setSideChatSeed(chat.id, seed);
    warm(seed, source.folder);
  }
  deps.publishChat(chat);
  if (chat.parentChatId) {
    void createChild(threadToRow(chat), source.id).catch((error: unknown) => {
      if (chatExists(chat.id)) onError("Couldn't link the side chat to its parent.", error);
    });
  }
  return chat;
}

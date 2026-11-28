// Side chats: a session opened beside the current one. From a message it
// branches there, and the source transcript through that message travels
// hidden in its first prompt; a blank one offers Add chat transcripts.

import type { Action, ChatThread } from "../../state/store";
import { requestWorkbenchReveal } from "../../shell/workbench/workbench-visibility-controller";
import { useWorkspaceStore } from "../../state/store";
import { editChat } from "../../state/cloud-chat-edits";
import { chatCloseConfirmation, type ChatCloseConfirmationCopy } from "../../shell/conversation/chat-close";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { loadTranscriptSnapshot, transcriptPillLabel, type TranscriptSnapshot } from "./chat-transcript-attach";
import { createForkedChat } from "./fork-chat";
import { HANDOFF_CONTEXT_OPEN } from "./harness-switch";
import { SIDE_CHAT_QUOTE_MAX, SIDE_CHAT_TITLE, getSideChatSeed, isSideChat, setSideChatSeed, type SideChatSeed } from "./side-chat-seeds";

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
  warm?(seed: SideChatSeed, folder: string): void;
  now?: number;
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

/** A side chat is never a child session, Local or cloud: `kind: "side"` keeps
 *  it out of the session tree, and `sourceChatId` only records where it was
 *  opened from. Whether it branched from a message lives in its seed. */
export function createSideChat(source: ChatThread, _branched: boolean, now = Date.now()): ChatThread {
  return { ...createForkedChat(source, undefined, now), kind: "side", title: SIDE_CHAT_TITLE };
}

const columnChatByFolder = new Map<string, string>();

/** The chat column's own selection, kept while a side chat tab has focus. */
export function rememberColumnChat(folder: string, chatId: string): void {
  columnChatByFolder.set(folder, chatId);
}

export function columnChatFor(folder: string): string | null {
  return columnChatByFolder.get(folder) ?? null;
}

/** The chat the chat column shows while side chat `side` has focus: the
 *  column's remembered chat, else the chat the side chat branched from
 *  (following side chats back to an ordinary one), else the newest chat the
 *  column can show. The pane and the column's chrome both resolve it here, so
 *  the breadcrumb, session menus and ⌥⌘T act on the chat that is on screen. */
export function columnChatIdForSideChat(
  chats: readonly ChatThread[],
  side: ChatThread,
  column: string | null,
  shown: (chat: ChatThread) => boolean = (chat) =>
    chat.folder === side.folder && chat.kind !== "terminal" && !chat.archived && !isSideChat(chat),
): string | null {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const pick = (id: string | null | undefined) => {
    const chat = id ? byId.get(id) : undefined;
    return chat && shown(chat) ? chat.id : null;
  };
  const remembered = pick(column);
  if (remembered) return remembered;
  const seen = new Set<string>();
  for (let at: ChatThread | undefined = side; at && !seen.has(at.id); at = byId.get(at.sourceChatId ?? at.parentChatId ?? "")) {
    seen.add(at.id);
    const source = pick(at.sourceChatId) ?? pick(at.parentChatId);
    if (source) return source;
  }
  let newest: ChatThread | null = null;
  for (const chat of chats) if (shown(chat) && (!newest || chat.createdAt >= newest.createdAt)) newest = chat;
  return newest?.id ?? null;
}

/** The session the chat column's chrome (breadcrumb, session menus, the
 *  Agents tab's Viewing row) follows: the focused chat, or while a side chat
 *  has focus, the chat the column shows. */
export function sessionViewChatId(
  chats: readonly ChatThread[],
  activeId: string | null,
  folder: string,
): string | null {
  if (!activeId) return null;
  const active = chats.find((chat) => chat.id === activeId);
  if (!active || !isSideChat(active)) return activeId;
  return columnChatIdForSideChat(chats, active, columnChatFor(folder));
}

export function sideChatCloseConfirmation(
  sessions: { getCloseActivity(chatId: string): { running: boolean; queuedCount: number } },
  chatId: string,
): ChatCloseConfirmationCopy | null {
  const chat = useWorkspaceStore.getState().chats.find((row) => row.id === chatId && !row.archived);
  if (!chat) return null;
  const agentName = chat.agentName?.trim() || chat.agentId?.trim() || "the agent";
  return chatCloseConfirmation({ agentName, ...sessions.getCloseActivity(chatId) });
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

/** Publish the fresh chat that replaces `previous` (/clear, a model switch).
 *  A side chat's replacement stays a side chat, branched from the same chat,
 *  in the same Workbench tab; any other chat opens in the chat column. */
export function publishReplacementChat(
  dispatch: (action: Action) => void,
  previous: ChatThread,
  fresh: ChatThread,
): void {
  if (!isSideChat(previous)) {
    dispatch({ type: "ADD_CHAT", chat: fresh, recordWorkspaceActivity: true });
    return;
  }
  dispatch({
    type: "OPEN_SIDE_CHAT",
    chat: {
      ...fresh,
      kind: "side",
      title: SIDE_CHAT_TITLE,
      ...(previous.sourceChatId ? { sourceChatId: previous.sourceChatId } : {}),
    },
    replaceChatId: previous.id,
    recordWorkspaceActivity: true,
  });
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
  const { warm = (seed, folder) => { void loadSideChatTranscript(seed, folder).catch(() => {}); } } = deps;
  const chat = createSideChat(source, from !== null, now);
  if (from) {
    const seed = sideChatSeedFor(source, from, now);
    setSideChatSeed(chat.id, seed);
    warm(seed, source.folder);
  }
  deps.publishChat(chat);
  return chat;
}

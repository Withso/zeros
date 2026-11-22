// Side chats: a session opened beside the current one. From a message it
// branches there, and the source transcript through that message travels
// hidden in its first prompt; a blank one offers Add chat transcripts.

import type { ChatThread } from "../../state/store";
import { useWorkspaceStore } from "../../state/store";
import { threadToRow } from "../../state/chat-row-wire";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { useSyncExternalStore } from "react";
import { dbCreateChildChat } from "./agent-history-client";
import { canAddChildSession, createChildChat } from "./add-child-session";
import { loadTranscriptSnapshot, transcriptPillLabel, type TranscriptSnapshot } from "./chat-transcript-attach";
import { createForkedChat } from "./fork-chat";
import { HANDOFF_CONTEXT_OPEN } from "./harness-switch";

export const SIDE_CHAT_TITLE = "Side chat";
export const SIDE_CHAT_QUOTE_MAX = 600;
export const SIDE_CHAT_SEED_LIMIT = 200;
const STORAGE_KEY = "zeros.side-chats.v1";

/** Where a side chat branched from. `pending` until a prompt carrying the
 *  hidden context is accepted; the quote stays for the banner. */
export interface SideChatSeed {
  sourceChatId: string;
  sourceTitle: string;
  /** The exact message the user branched from. */
  messageId: string;
  /** Opening prompt of that message's turn; the cut falls back to it when the
   *  exact id is outside the loaded history. */
  promptId: string | null;
  role: "user" | "agent";
  quote: string;
  pending: boolean;
  createdAt: number;
  /** The source chat's updatedAt when branched; keys the transcript cache so
   *  a hover warm and the first send share one read. */
  sourceUpdatedAt: number;
}

export interface SideChatSource {
  messageId: string;
  promptId: string | null;
  role: "user" | "agent";
  text: string;
}

type SeedMap = Readonly<Record<string, SideChatSeed>>;

function isSeed(value: unknown): value is SideChatSeed {
  if (!value || typeof value !== "object") return false;
  const seed = value as Partial<SideChatSeed>;
  return typeof seed.sourceChatId === "string" && typeof seed.messageId === "string" &&
    (seed.role === "user" || seed.role === "agent") && typeof seed.quote === "string" &&
    typeof seed.pending === "boolean" && typeof seed.createdAt === "number";
}

function readSeeds(): SeedMap {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, SideChatSeed> = {};
    for (const [id, seed] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isSeed(seed)) continue;
      out[id] = {
        ...seed,
        sourceTitle: typeof seed.sourceTitle === "string" ? seed.sourceTitle : "",
        promptId: typeof seed.promptId === "string" ? seed.promptId : null,
        sourceUpdatedAt: typeof seed.sourceUpdatedAt === "number" ? seed.sourceUpdatedAt : seed.createdAt,
      };
    }
    return out;
  } catch {
    return {};
  }
}

let seeds: SeedMap | null = null;
const listeners = new Set<() => void>();

function current(): SeedMap {
  seeds ??= readSeeds();
  return seeds;
}

function commit(next: SeedMap): void {
  seeds = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Storage full or unavailable: the seed still lives for this run. */
  }
  for (const listener of listeners) listener();
}

/** Newest wins; the oldest seeds beyond the bound are dropped. */
export function boundSeeds(map: SeedMap, limit = SIDE_CHAT_SEED_LIMIT): SeedMap {
  const entries = Object.entries(map);
  if (entries.length <= limit) return map;
  entries.sort((a, b) => b[1].createdAt - a[1].createdAt);
  return Object.fromEntries(entries.slice(0, limit));
}

export function getSideChatSeed(chatId: string | null | undefined): SideChatSeed | null {
  return chatId ? current()[chatId] ?? null : null;
}

export function setSideChatSeed(chatId: string, seed: SideChatSeed): void {
  commit(boundSeeds({ ...current(), [chatId]: seed }));
}

export function markSideChatSeedSent(chatId: string): void {
  const seed = current()[chatId];
  if (!seed?.pending) return;
  commit({ ...current(), [chatId]: { ...seed, pending: false } });
}

/** Deleting a chat prunes its seed. */
export function pruneSideChatSeeds(liveChatIds: ReadonlySet<string>): void {
  const map = current();
  const kept = Object.fromEntries(Object.entries(map).filter(([id]) => liveChatIds.has(id)));
  if (Object.keys(kept).length !== Object.keys(map).length) commit(kept);
}

export function resetSideChatSeedsForTesting(): void {
  seeds = null;
  listeners.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSideChatSeed(chatId: string | null | undefined): SideChatSeed | null {
  return useSyncExternalStore(subscribe, () => getSideChatSeed(chatId), () => null);
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

/** The source transcript through the branched message: the exact message
 *  when it is in the loaded history, else through its turn. */
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
    if (!seed.promptId) throw error;
    return load({ chatId: seed.sourceChatId, mode: "handoff", lastMessageAt: seed.sourceUpdatedAt, throughMessageId: seed.promptId, meta });
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

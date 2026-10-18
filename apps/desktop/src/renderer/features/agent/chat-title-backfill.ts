// ──────────────────────────────────────────────────────────
// Chat title backfill — name Untitled chats nobody is looking at
// ──────────────────────────────────────────────────────────
//
// The chat surface names a chat while it is on screen. Many chats never are:
// tabs another agent started or messaged through the Zeros Local CLI,
// background tabs, chats reopened with a long history whose first prompt is no
// longer in the loaded window. This app-level service asks the Local engine
// for each Untitled / New chat chat's first real prompt (`chats.titleSeeds`)
// once its agent answered, and hands it to the same deduplicated request the
// surface uses. Cloud chats keep the surface path; their runtime serves its
// own transcripts.
// ──────────────────────────────────────────────────────────

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { ChatTitleSeedWire } from "../../platform/bridge/workspace-bridge";
import type { Action } from "../../state/workspace-store";
import type { ChatThread } from "../../state/store";
import type { requestAiChatTitle } from "./chat-title";

const SEEDED_TITLES = new Set(["Untitled", "New chat"]);
/** Older Untitled chats are not worth a paid request each at every launch. */
const RECENT_MS = 14 * 24 * 3_600_000;
const FLUSH_DELAY_MS = 1_000;
const BATCH = 50;
/** The title service allows 20 requests a minute per account; leave room for
 * the chats the user is looking at. */
const MAX_REQUESTS_PER_FLUSH = 6;
const COOLDOWN_MS = 30_000;

export interface ChatTitleBackfillDeps {
  getChats: () => readonly ChatThread[];
  subscribeChats: (listener: () => void) => () => void;
  onDbChanged: (listener: (message: unknown) => void) => () => void;
  /** The Local engine is connected and can answer. */
  connected: () => boolean;
  seeds: (chatIds: readonly string[]) => Promise<ChatTitleSeedWire[]>;
  request: typeof requestAiChatTitle;
  dispatch: (action: Action) => void;
  now?: () => number;
}

function untitled(chat: ChatThread, now: number): boolean {
  return (
    SEEDED_TITLES.has(chat.title) &&
    !chat.archived &&
    chat.kind !== "terminal" &&
    !isCloudWorkspace(chat.folder) &&
    now - (chat.updatedAt ?? 0) <= RECENT_MS
  );
}

export function startChatTitleBackfill(deps: ChatTitleBackfillDeps): () => void {
  const now = deps.now ?? Date.now;
  const due = new Set<string>();
  /** Chats this service has already seen as candidates (so a list change
   * queues only newcomers; transcript changes re-queue the rest). */
  const known = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let stopped = false;
  let cooldownUntil = 0;

  const candidates = () => deps.getChats().filter((chat) => untitled(chat, now()));
  const schedule = () => {
    if (stopped || timer || due.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, Math.max(FLUSH_DELAY_MS, cooldownUntil - now()));
  };
  const queue = (ids: Iterable<string>) => {
    for (const id of ids) due.add(id);
    schedule();
  };
  const refreshCandidates = () => {
    const fresh: string[] = [];
    const current = new Set<string>();
    for (const chat of candidates()) {
      current.add(chat.id);
      if (!known.has(chat.id)) fresh.push(chat.id);
    }
    for (const id of [...known]) if (!current.has(id)) known.delete(id);
    for (const id of fresh) known.add(id);
    queue(fresh);
  };

  const flush = async () => {
    if (stopped || flushing) return;
    if (!deps.connected()) return; // a reconnect's DB_CHANGED queues again
    flushing = true;
    try {
      const byId = new Map(candidates().map((chat) => [chat.id, chat] as const));
      const ids = [...due].filter((id) => byId.has(id)).slice(0, BATCH);
      for (const id of [...due]) if (!byId.has(id) || ids.includes(id)) due.delete(id);
      if (ids.length === 0) return;
      let seeds: ChatTitleSeedWire[];
      try {
        seeds = await deps.seeds(ids);
      } catch {
        return; // an older engine without the op: the chat surface still names chats
      }
      if (stopped) return;
      let requested = 0;
      for (const seed of seeds) {
        const chat = deps.getChats().find((candidate) => candidate.id === seed.chatId);
        if (!seed.answered || !chat || !untitled(chat, now())) continue;
        if (requested >= MAX_REQUESTS_PER_FLUSH) {
          due.add(chat.id);
          cooldownUntil = now() + COOLDOWN_MS;
          continue;
        }
        if (deps.request({ chatId: chat.id, messageId: seed.messageId, prompt: seed.prompt, expectedTitle: chat.title, dispatch: deps.dispatch }))
          requested++;
      }
    } finally {
      flushing = false;
      schedule();
    }
  };

  const unsubscribeChats = deps.subscribeChats(refreshCandidates);
  const unsubscribeDb = deps.onDbChanged((message) => {
    const record = (message ?? {}) as { kinds?: unknown; chatIds?: unknown };
    const kinds = Array.isArray(record.kinds) ? record.kinds : [];
    if (kinds.includes("messages")) {
      const ids = Array.isArray(record.chatIds) ? record.chatIds.filter((id): id is string => typeof id === "string") : null;
      const open = new Set(candidates().map((chat) => chat.id));
      queue(ids ? ids.filter((id) => open.has(id)) : open);
    } else if (kinds.includes("chats")) {
      // After a reconnect or another device's change, look at everything once.
      queue(candidates().map((chat) => chat.id));
    }
  });
  refreshCandidates();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribeChats();
    unsubscribeDb();
  };
}

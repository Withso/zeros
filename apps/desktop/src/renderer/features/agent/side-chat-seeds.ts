// Side chat seeds: where each side chat branched from, persisted per chat id.
// Kept free of store imports so the workspace store can forget a deleted
// chat's seed.

import { useSyncExternalStore } from "react";

export const SIDE_CHAT_QUOTE_MAX = 600;
export const SIDE_CHAT_TITLE = "Side chat";
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

export function forgetSideChatSeed(chatId: string): void {
  const map = current();
  if (!(chatId in map)) return;
  const { [chatId]: _forgotten, ...kept } = map;
  commit(kept);
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

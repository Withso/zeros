import { useSyncExternalStore } from "react";
import { z } from "zod";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

/** Team sharing phase 2 (slice A): who sent each user message, from the
 * control plane's durable receipts. Keyed by the workspace and its native chat
 * id (chatKey) and the user message's id (the transcript row's msgId). Type-only
 * imports here: cloud-v2 loads this early, and a value import reorders a cycle. `null` is a known answer
 * ("unknown legacy attribution"); absent means not asked yet. Bounded. */
const MAX_CHATS = 64, MAX_PER_CHAT = 2_000;
const chats = new Map<string, Map<string, string | null>>();
const listeners = new Set<() => void>();
let version = 0;

/** A history reply's bounded sender map, read leniently (unknown fields and bad entries are ignored). */
export const ChatSendersSchema = z.record(z.string().min(1).max(256), z.unknown());
const Entry = z.union([z.object({ userId: z.string().uuid() }).passthrough(), z.null()]);

export function acceptChatSenders(chatKey: string, value: unknown): void {
  const parsed = ChatSendersSchema.safeParse(value);
  if (!parsed.success) return;
  let changed = false;
  const chat = chats.get(chatKey) ?? new Map<string, string | null>();
  for (const [messageId, raw] of Object.entries(parsed.data).slice(-MAX_PER_CHAT)) {
    const entry = Entry.safeParse(raw);
    if (!entry.success) continue;
    const userId = entry.data?.userId ?? null;
    if (chat.get(messageId) === userId && chat.has(messageId)) continue;
    chat.delete(messageId); chat.set(messageId, userId); changed = true;
  }
  while (chat.size > MAX_PER_CHAT) chat.delete(chat.keys().next().value!);
  chats.delete(chatKey); chats.set(chatKey, chat);
  while (chats.size > MAX_CHATS) chats.delete(chats.keys().next().value!);
  if (changed) { version++; for (const listener of listeners) listener(); }
}

/** A history reply for a native chat id in a cloud workspace. */
export function acceptHistorySenders(target: CloudWorkspaceTarget, nativeChatId: string, value: unknown): void {
  acceptChatSenders(chatKeyFor(target, nativeChatId), value);
}
/** Wraps the bridge's history read: a reply's sender map is kept for the chat it was read for. */
export function keepHistorySenders<T extends Record<string, unknown>, O>(read: (target: CloudWorkspaceTarget, op: string, params: Record<string, unknown>, options?: O) => Promise<T>) {
  return (target: CloudWorkspaceTarget, op: string, params: Record<string, unknown>, options?: O) => read(target, op, params, options).then(result => {
    if (result.senders !== undefined && typeof params.chatId === "string" && params.chatId) acceptHistorySenders(target, params.chatId, result.senders);
    return result;
  });
}

/** The store's key for a native chat in a cloud workspace. */
export const chatKeyFor = (target: CloudWorkspaceTarget, nativeChatId: string) =>
  `${target.organizationId.toLowerCase()}/${target.workspaceId.toLowerCase()}/${nativeChatId}`;

/** userId, null (known unknown), or undefined (not answered yet). */
export function chatSender(chatKey: string | null | undefined, messageId: string | null | undefined): string | null | undefined {
  return chatKey && messageId ? chats.get(chatKey)?.get(messageId) : undefined;
}
export function useChatSender(chatKey: string | null | undefined, messageId: string | null | undefined): string | null | undefined {
  useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  return chatSender(chatKey, messageId);
}
/** Account change: another person's attributions never carry over. */
export function clearChatSenders(): void { chats.clear(); version++; for (const listener of listeners) listener(); }

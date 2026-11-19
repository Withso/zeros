import { z } from "zod";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { acceptHistorySenders, chatKeyFor, chatSender } from "./chat-senders";
import { readCloudV2History } from "./cloud-v2";

/** Live and worker-history messages can lack sender attribution; fetch it from the control plane's receipts in a separate request. */
const FLUSH_MS = 150, BATCH = 200, RETRY_MS = 30_000;
const pending = new Map<string, { target: CloudWorkspaceTarget; chatId: string; ids: Set<string>; timer: ReturnType<typeof setTimeout> }>();
const asked = new Map<string, number>();
const Id = z.string().min(1).max(256);

export function lookupChatSender(target: CloudWorkspaceTarget, nativeChatId: string, messageId: string, read = readCloudV2History): void {
  if (!Id.safeParse(messageId).success) return;
  const key = chatKeyFor(target, nativeChatId), id = `${key}\0${messageId}`, now = Date.now();
  if (chatSender(key, messageId) !== undefined || now - (asked.get(id) ?? -Infinity) < RETRY_MS) return;
  asked.set(id, now);
  while (asked.size > 10_000) asked.delete(asked.keys().next().value!);
  let batch = pending.get(key);
  if (!batch) {
    batch = { target, chatId: nativeChatId, ids: new Set(), timer: setTimeout(() => flush(key, read), FLUSH_MS) };
    pending.set(key, batch);
  }
  batch.ids.add(messageId);
  if (batch.ids.size >= BATCH) { clearTimeout(batch.timer); flush(key, read); }
}

function flush(key: string, read: typeof readCloudV2History): void {
  const batch = pending.get(key);
  if (!batch) return;
  pending.delete(key);
  const ids = [...batch.ids];
  for (let start = 0; start < ids.length; start += BATCH) {
    const userMessageIds = ids.slice(start, start + BATCH);
    void read(batch.target, "messages.senders", { chatId: batch.chatId, userMessageIds })
      .then(result => acceptHistorySenders(batch.target, batch.chatId, result.senders), () => {
        // Keep the ask timestamp so failure still observes the retry cooldown.
      });
  }
}

export function resetChatSenderLookupsForTests(): void { for (const batch of pending.values()) clearTimeout(batch.timer); pending.clear(); asked.clear(); }

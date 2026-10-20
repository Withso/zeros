import { parseCloudScopedId, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

// Only ADD_CHAT from this renderer establishes this fact. A missing cache,
// provider binding or history response cannot prove that an older chat is empty.
const fresh = new Map<string, string>();
export function markFreshCloudChat(chatId: string, folder: string): void {
  const chat = parseCloudScopedId(chatId), workspace = parseCloudWorkspaceKey(folder);
  if (!chat || !workspace || chat.organizationId !== workspace.organizationId || chat.workspaceId !== workspace.workspaceId) return;
  fresh.delete(chatId);
  fresh.set(chatId, folder);
  while (fresh.size > 64) fresh.delete(fresh.keys().next().value!);
}
export function consumeFreshCloudChat(chatId: string, folder: string | null | undefined): boolean {
  if (!folder || fresh.get(chatId) !== folder) return false;
  return fresh.delete(chatId);
}
export function forgetFreshCloudChat(chatId: string): void { fresh.delete(chatId); }

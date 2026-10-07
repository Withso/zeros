import { CloudTranscriptCache } from "../state/cloud-transcript-cache";
import { canReadCloudWorkspace, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument, getCloudWorkspaceRows } from "../state/cloud-workspace-catalog";
import { isElectron, nativeInvoke } from "./runtime";
import { parseCloudScopedId, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { z } from "zod";
import type { CachedTranscriptWindow, CloudTranscriptOwner } from "./cloud-transcript-cache-contract";

let account: string | null = null;
export const cloudTranscriptCache = new CloudTranscriptCache({
  isAllowed: owner => isElectron() && owner.accountId === account && cloudWorkspaceCatalogConfirmed() &&
    canReadCloudWorkspace(cloudWorkspaceDocument(owner)),
  read: owner => nativeInvoke("cloud_transcript_cache_read", owner),
  write: (owner, window, cacheEpoch) => nativeInvoke("cloud_transcript_cache_write", { ...owner, window, cacheEpoch }),
  prune: scope => nativeInvoke("cloud_transcript_cache_prune", scope),
});
export function setCloudTranscriptCacheOwner(next: string | null): void {
  account = next;
  cloudTranscriptCache.setAccount(next);
}
function ownerForChat(chatId: string): CloudTranscriptOwner | null {
  if (!isElectron()) return null;
  const chat = parseCloudScopedId(chatId);
  return account && chat ? { accountId: account, organizationId: chat.organizationId, workspaceId: chat.workspaceId, chatId: chat.id } : null;
}
export function peekCloudTranscriptWindow(chatId: string): CachedTranscriptWindow | null {
  const owner = ownerForChat(chatId);
  return owner ? cloudTranscriptCache.peek(owner) : null;
}
export async function readCachedCloudTranscriptWindow(chatId: string): Promise<CachedTranscriptWindow | null> {
  const owner = ownerForChat(chatId);
  return owner ? cloudTranscriptCache.read(owner) : null;
}
export function captureCloudTranscriptConfirmation(chatId: string): ((window: CachedTranscriptWindow) => void) | null {
  const owner = ownerForChat(chatId);
  const confirm = owner ? cloudTranscriptCache.captureConfirmation(owner) : null;
  return confirm ? window => { void confirm(window).catch(() => {}); } : null;
}
export function forgetCloudTranscriptChat(chatId: string): void {
  const owner = ownerForChat(chatId);
  if (owner) void cloudTranscriptCache.prune(owner);
}
export function forgetCloudTranscriptWorkspace(target: CloudWorkspaceTarget): void {
  if (account && isElectron()) void cloudTranscriptCache.prune({ accountId: account, organizationId: target.organizationId, workspaceId: target.workspaceId });
}
export function forgetRemovedCloudTranscriptWorkspaces(workspaceIds: readonly string[]): void {
  if (!account || !isElectron()) return;
  for (const id of workspaceIds) {
    const target = parseCloudWorkspaceKey(id);
    if (target) forgetCloudTranscriptWorkspace(target);
    else if (z.string().uuid().safeParse(id).success) void cloudTranscriptCache.prune({ accountId: account, workspaceId: id });
  }
}
export function retainAuthorizedCloudTranscriptWorkspaces(): void {
  if (!account || !isElectron() || !cloudWorkspaceCatalogConfirmed()) return;
  const retainedWorkspaces = getCloudWorkspaceRows().flatMap(row => {
    const target = parseCloudWorkspaceKey(row.path);
    return target && canReadCloudWorkspace(cloudWorkspaceDocument(target))
      ? [{ organizationId: target.organizationId, workspaceId: target.workspaceId }] : [];
  });
  void cloudTranscriptCache.prune({ accountId: account, retainedWorkspaces });
}

/** A cache callback is provisional and cannot resolve the authoritative read.
 * The microtask lets the initial hydration register its exact request identity
 * before cached paint, without waiting for another animation frame. */
export async function readCloudTranscriptWithCachedPaint<T>(
  chatId: string,
  authoritative: () => Promise<T>,
  onCached?: (window: CachedTranscriptWindow) => void,
): Promise<T> {
  let settled = false;
  const paint = (window: CachedTranscriptWindow | null) => {
    if (!settled && window && peekCloudTranscriptWindow(chatId) === window) onCached?.(window);
  };
  if (onCached) {
    const remembered = peekCloudTranscriptWindow(chatId);
    if (remembered) queueMicrotask(() => paint(remembered));
    else void readCachedCloudTranscriptWindow(chatId).then(paint);
  }
  try { return await authoritative(); }
  catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 401 || status === 403 || status === 404) {
      // Denial/tombstone is authoritative absence, not an offline fallback.
      const target = parseCloudScopedId(chatId);
      if (status === 403 && target) forgetCloudTranscriptWorkspace({ organizationId: target.organizationId, workspaceId: target.workspaceId });
      else forgetCloudTranscriptChat(chatId);
      onCached?.({ recordEpoch: null, revision: 0, cursor: null, messages: [] });
    }
    throw error;
  }
  finally { settled = true; }
}

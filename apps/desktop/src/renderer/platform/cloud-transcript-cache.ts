import { CloudTranscriptCache, CloudHistoryRestoreTracker, type CloudHistoryRestoreTicket } from "../state/cloud-transcript-cache";
import { canReadCloudWorkspace, cloudWorkspaceCatalogConfirmed, cloudWorkspaceDocument, getCloudWorkspaceRows } from "../state/cloud-workspace-catalog";
import { isElectron, nativeInvoke } from "./runtime";
import { cloudScopedId, parseCloudScopedId, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";
import { z } from "zod";
import { CloudHistoryRestoreMetadataSchema, cloudHistoryFencesMatch, type CloudHistoryRestoreMetadata, type CloudHistoryRestoreFence,
  type CachedTranscriptWindow, type CloudTranscriptOwner } from "./cloud-transcript-cache-contract";

let account: string | null = null;
const historyRestore = new CloudHistoryRestoreTracker();
export type CloudHistoryRestoreOrigin = "control-plane" | "native" | "disk";
const nativeHeads = new Map<string, CloudHistoryRestoreFence>();
const restoreListeners = new Set<{ listener: (chatId: string, fence: CloudHistoryRestoreFence, origin: CloudHistoryRestoreOrigin) => void; includeDisk: boolean }>();
const publishRestoreHead = (chatId: string, fence: CloudHistoryRestoreFence, origin: CloudHistoryRestoreOrigin) => {
  for (const subscription of restoreListeners) {
    if (origin === "disk" && !subscription.includeDisk) continue;
    try { subscription.listener(chatId, fence, origin); } catch { /* A presentation subscriber cannot change restore authority. */ }
  }
};
export const cloudTranscriptCache = new CloudTranscriptCache({
  isAllowed: owner => isElectron() && owner.accountId === account && cloudWorkspaceCatalogConfirmed() &&
    canReadCloudWorkspace(cloudWorkspaceDocument(owner)),
  read: owner => nativeInvoke("cloud_transcript_cache_read", owner),
  write: (owner, window, cacheEpoch, historyEpoch) => nativeInvoke("cloud_transcript_cache_write", { ...owner, window, cacheEpoch,
    ...(historyEpoch ? { historyEpoch } : {}) }),
  prune: scope => nativeInvoke("cloud_transcript_cache_prune", scope),
  onRestoreHead: (owner, fence) => {
    // Disk may fence old provisional presentation on remount. It cannot
    // replace a current independently authorized CP binding/head.
    if (!historyRestore.head(owner, owner.chatId)) publishRestoreHead(cloudScopedId(owner, owner.chatId), fence, "disk");
  },
});
export function setCloudTranscriptCacheOwner(next: string | null): void {
  account = next;
  cloudTranscriptCache.setAccount(next);
  historyRestore.setAccount(next);
  nativeHeads.clear();
}
export function captureCloudHistoryRestoreRead(target: CloudWorkspaceTarget): CloudHistoryRestoreTicket | null {
  return account ? historyRestore.capture({ accountId: account, organizationId: target.organizationId, workspaceId: target.workspaceId }) : null;
}
export function assertCloudHistoryRestoreResult(ticket: CloudHistoryRestoreTicket | null,
  metadata: CloudHistoryRestoreMetadata | null, conversations: readonly string[] = []): void {
  if (ticket) historyRestore.assertResult(ticket, metadata, conversations);
}
export function onCloudHistoryRestoreHead(listener: (chatId: string, fence: CloudHistoryRestoreFence, origin: CloudHistoryRestoreOrigin) => void, includeDisk = false): () => void {
  const subscription = { listener, includeDisk };
  restoreListeners.add(subscription);
  return () => { restoreListeners.delete(subscription); };
}
export function cloudHistoryRestoreHead(chatId: string): CloudHistoryRestoreFence | undefined {
  const chat = parseCloudScopedId(chatId);
  if (!chat || !account) return undefined;
  const owner = { accountId: account, organizationId: chat.organizationId, workspaceId: chat.workspaceId, chatId: chat.id };
  return historyRestore.head(owner, chat.id) ?? cloudTranscriptCache.restoreHead(owner);
}
export async function installCloudHistoryRestoreMetadata(target: CloudWorkspaceTarget, input: CloudHistoryRestoreMetadata,
  conversations: readonly string[] = [], ticket: CloudHistoryRestoreTicket | null = captureCloudHistoryRestoreRead(target),
  origin: Exclude<CloudHistoryRestoreOrigin, "disk"> = "control-plane"): Promise<void> {
  const metadata = CloudHistoryRestoreMetadataSchema.parse(input);
  if (metadata.projection.organizationId !== target.organizationId || metadata.projection.workspaceId !== target.workspaceId)
    throw new Error("Cloud restore belongs to another workspace.");
  if (!ticket) return;
  const changed = historyRestore.install(ticket, metadata, conversations);
  // An older supplied page can be ignored while a newer head remains known.
  // That retained head is not evidence that this page confirmed it natively.
  historyRestore.assertResult(ticket, metadata, conversations);
  const ids = new Set([...metadata.historyHeads.map(head => head.conversationId), ...conversations, ...changed.map(head => head.conversationId)]);
  const changedIds = new Set(changed.map(head => head.conversationId));
  for (const id of ids) {
    const fence = historyRestore.head(ticket.scope, id);
    if (!fence) continue;
    const chatId = cloudScopedId(ticket.scope, id), native = nativeHeads.get(chatId);
    const confirmedNative = !!native && cloudHistoryFencesMatch(native, fence);
    if (origin === "native") {
      nativeHeads.delete(chatId); nativeHeads.set(chatId, fence);
      while (nativeHeads.size > 512) nativeHeads.delete(nativeHeads.keys().next().value!);
    } else if (!confirmedNative) nativeHeads.delete(chatId);
    // A CP projection may arrive first. The first independently verified VM
    // confirmation of that same head still fences its older visible rows.
    // Exact duplicate VM reads do not repeatedly clear the accepted transcript.
    if (changedIds.has(id) || origin === "native" && !confirmedNative)
      publishRestoreHead(chatId, fence, origin);
  }
  await Promise.all([...ids].map(chatId => {
    const fence = historyRestore.head(ticket.scope, chatId);
    return fence ? cloudTranscriptCache.installRestoreHead({ ...ticket.scope, chatId }, fence) : undefined;
  }));
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
  let painted: CachedTranscriptWindow | null = null;
  const unsubscribe = onCached ? onCloudHistoryRestoreHead((changedChat, fence) => {
    if (changedChat !== chatId || settled || !painted) return;
    painted = null;
    onCached({ recordEpoch: null, revision: 0, cursor: null, messages: [], restoreHead: fence });
  }, true) : undefined;
  const paint = (window: CachedTranscriptWindow | null) => {
    if (!settled && window && peekCloudTranscriptWindow(chatId) === window) { painted = window; onCached?.(window); }
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
  finally { settled = true; unsubscribe?.(); }
}

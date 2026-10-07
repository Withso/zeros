import { app } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { CommandHandler } from "../router";
import { getSessionUserForMain, onMainAuthSessionChanged } from "./auth-session";
import { CloudTranscriptCacheStore } from "../../cloud-transcript-cache-store";
import { CloudTranscriptOwnerSchema, CloudTranscriptPruneSchema, CachedTranscriptWindowSchema } from "../../../src/renderer/platform/cloud-transcript-cache-contract";
import { IS_LOCAL_DEVELOPMENT } from "../../runtime-mode";

let store: { path: string; value: CloudTranscriptCacheStore } | null = null;
let installed = false;
let sessionKey: string | null | undefined;
let cacheEpoch = randomUUID();
let pendingCleanup = false;
let failedCleanup = false;
function cacheStore(): CloudTranscriptCacheStore {
  const directory = path.join(app.getPath("userData"), "cloud-transcripts-v1");
  if (store?.path !== directory) store = { path: directory, value: new CloudTranscriptCacheStore(directory) };
  return store.value;
}
function synchronizeOwner(): string | null {
  let user: ReturnType<typeof getSessionUserForMain>;
  try { user = getSessionUserForMain(); }
  catch {
    sessionKey = undefined; cacheEpoch = randomUUID(); pendingCleanup = true; failedCleanup = true;
    throw new Error("Cloud transcript cache unavailable.");
  }
  const accountId = user?.accountId ?? user?.sub ?? null;
  const next = user ? JSON.stringify([user.provider, accountId, user.sessionId ?? null]) : null;
  if (sessionKey !== next) {
    sessionKey = next;
    cacheEpoch = randomUUID();
    // Main retires disk data even when the renderer is gone. The epoch is an
    // in-memory lifecycle fence, never a persisted credential or admission.
    pendingCleanup = true;
  }
  if (pendingCleanup) {
    try {
      // A failed sign-out cleanup cannot revive disk data on a later sign-in.
      if (failedCleanup) cacheStore().retainAccount(null);
      cacheStore().retainAccount(accountId);
      pendingCleanup = false; failedCleanup = false;
    } catch {
      failedCleanup = true;
      throw new Error("Cloud transcript cache unavailable.");
    }
  }
  return accountId;
}
export function installCloudTranscriptCacheLifecycle(): void {
  if (installed || IS_LOCAL_DEVELOPMENT) return;
  installed = true;
  onMainAuthSessionChanged(() => {
    try { synchronizeOwner(); } catch { /* A cache failure cannot block sign-out. */ }
  });
  try { synchronizeOwner(); } catch { /* Optional cache I/O cannot block Local IPC registration. */ }
}
function assertOwner(accountId: string, expectedEpoch?: string): void {
  if (synchronizeOwner() !== accountId || expectedEpoch !== undefined && expectedEpoch !== cacheEpoch)
    throw new Error("Cloud transcript cache owner changed.");
}
export const cloudTranscriptCacheRead: CommandHandler = args => {
  const owner = CloudTranscriptOwnerSchema.parse(args);
  assertOwner(owner.accountId);
  return { cacheEpoch, window: cacheStore().read(owner) };
};
export const cloudTranscriptCacheWrite: CommandHandler = args => {
  const parsed = CloudTranscriptOwnerSchema.extend({ cacheEpoch: z.string().uuid(), window: CachedTranscriptWindowSchema }).strict().parse(args);
  const { cacheEpoch: expectedEpoch, window, ...owner } = parsed;
  assertOwner(owner.accountId, expectedEpoch);
  cacheStore().write(owner, window);
};
export const cloudTranscriptCachePrune: CommandHandler = args => {
  const scope = CloudTranscriptPruneSchema.parse(args);
  assertOwner(scope.accountId);
  cacheStore().prune(scope);
};

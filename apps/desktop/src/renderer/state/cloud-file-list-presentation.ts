import { z } from "zod";
import {
  accountPresentationGeneration,
  CLOUD_FILE_LIST_PRESENTATION_KEY,
  getAccountPresentationOwner,
  readAccountPresentation,
  writeAccountPresentation,
} from "../platform/account-presentation-cache";
import { cloudWorkspaceKey, parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import type { WorkspaceFileListing } from "../platform/bridge/workspace-bridge";
import { subscribeWorkspaceAccessEnded, workspaceAccessEnded, workspaceAccessScope } from "../platform/team-sharing-registry";
import {
  canReadCloudWorkspace,
  cloudCatalogGeneration,
  cloudWorkspaceDocument,
  cloudWorkspaceOwnerGeneration,
  cloudWorkspaceStopVersion,
  subscribeCloudWorkspaces,
} from "./cloud-workspace-catalog";

const MAX_ENTRIES = 12;
const MAX_BYTES = 1024 * 1024;
const paths = z.string().array().max(20_000);
const row = z.object({
  lineage: z.string(),
  listing: z.object({ files: paths, designDirectories: paths.optional() }),
});
const snapshot = z.tuple([z.string(), row]).array().max(MAX_ENTRIES);
let account = -1;
const revisions = new Map<string, number>();
let lists = new Map<string, z.infer<typeof row>>();
const listeners = new Set<() => void>();
const deniedDocuments = new WeakSet<object>();

export function cloudFileListAccess(folder: string) {
  const owner = getAccountPresentationOwner();
  const target = parseCloudWorkspaceKey(folder);
  if (!owner || !target || workspaceAccessEnded(target)) return null;
  const doc = cloudWorkspaceDocument(target);
  // Team sharing authorizes history, not the workspace's live files.
  if (!doc || deniedDocuments.has(doc) || !canReadCloudWorkspace(doc) || doc.sharing?.readOnly || !doc.capabilities.canWrite) return null;
  const lineage = JSON.stringify([doc.ownerUserId === undefined ? doc.createdBy : doc.ownerUserId, doc.generation.number]);
  const key = JSON.stringify([accountPresentationGeneration(), cloudCatalogGeneration(), cloudWorkspaceOwnerGeneration(target), folder, lineage, revisions.get(cloudWorkspaceKey(target)) ?? 0]);
  return {
    key,
    lineage,
    ready: doc.status === "ready" || doc.status === "busy",
    readKey: JSON.stringify([key, cloudWorkspaceStopVersion(target), workspaceAccessScope()]),
  };
}

export function subscribeCloudFileListAccess(listener: () => void): () => void {
  const offCatalog = subscribeCloudWorkspaces(listener);
  const offAccess = subscribeWorkspaceAccessEnded(listener);
  listeners.add(listener);
  return () => { offCatalog(); offAccess(); listeners.delete(listener); };
}

function restoreCloudFileLists(): string | null {
  const owner = getAccountPresentationOwner();
  const generation = accountPresentationGeneration();
  if (generation !== account) {
    account = generation;
    const parsed = owner && snapshot.safeParse(readAccountPresentation(CLOUD_FILE_LIST_PRESENTATION_KEY, owner, MAX_BYTES));
    lists = new Map(parsed && parsed.success ? parsed.data : []);
  }
  return owner;
}

export function peekCloudFileList(folder: string, lineage: string): WorkspaceFileListing | undefined {
  restoreCloudFileLists();
  const saved = lists.get(folder);
  return saved?.lineage === lineage ? saved.listing : undefined;
}

function persistCloudFileLists(owner: string): void {
  writeAccountPresentation(CLOUD_FILE_LIST_PRESENTATION_KEY, owner, [...lists], MAX_BYTES);
}

export function rememberCloudFileList(folder: string, lineage: string, listing: WorkspaceFileListing): void {
  const owner = restoreCloudFileLists();
  if (!owner || parseCloudWorkspaceKey(folder)?.relativePath) return;
  const bytes = JSON.stringify(listing).length * 2;
  if (lists.get(folder)?.listing === listing && lists.get(folder)?.lineage === lineage) return;
  lists.delete(folder);
  if (listing.files.length <= 20_000 && (listing.designDirectories?.length ?? 0) <= 20_000 && bytes < MAX_BYTES / 2) {
    lists.set(folder, { lineage, listing });
  }
  let size = 0;
  for (const [key, value] of [...lists].reverse()) {
    size += (key.length + JSON.stringify(value).length + 8) * 2;
    if (size > MAX_BYTES - 1024) lists.delete(key);
  }
  while (lists.size > MAX_ENTRIES) lists.delete(lists.keys().next().value!);
  persistCloudFileLists(owner);
}

export function pruneCloudFileLists(remove: (folder: string, lineage: string) => boolean): void {
  const owner = restoreCloudFileLists();
  if (!owner) return;
  let changed = false;
  for (const [folder, saved] of lists) {
    if (remove(folder, saved.lineage)) changed = lists.delete(folder) || changed;
  }
  if (changed) persistCloudFileLists(owner);
}

export function retireCloudFileLists(): void {
  pruneCloudFileLists(() => true);
  revisions.clear();
  for (const listener of listeners) listener();
}

export function invalidateCloudFileListAccess(target: Parameters<typeof cloudWorkspaceKey>[0]): void {
  const key = cloudWorkspaceKey(target);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  for (const listener of listeners) listener();
}

export function forgetCloudWorkspaceFileList(target: Parameters<typeof cloudWorkspaceKey>[0]): void {
  const doc = cloudWorkspaceDocument(target);
  if (doc) deniedDocuments.add(doc);
  pruneCloudFileLists(folder => folder === cloudWorkspaceKey(target));
  invalidateCloudFileListAccess(target);
}

export function resetCloudFileListsForTests(): void {
  account = -1;
}

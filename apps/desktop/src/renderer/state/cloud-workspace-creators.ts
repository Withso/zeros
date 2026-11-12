import { useMemo, useSyncExternalStore } from "react";
import type { Workspace } from "../platform/git";
import { parseCloudWorkspaceKey } from "../platform/bridge/cloud-workspace-key";
import { cloudWorkspaceDocument, getCloudWorkspaceDocuments, subscribeCloudWorkspaces } from "./cloud-workspace-catalog";

/** A row's current Creator: null for a Local row (always this account's), ""
 * for a cloud row whose document has no Creator yet (matches no person). */
export type CreatorOf = (workspace: Workspace) => string | null;

export function creatorLookup(documents: ReturnType<typeof getCloudWorkspaceDocuments>): CreatorOf {
  const byId = new Map(documents.map(doc => [doc.id, doc.ownerUserId ?? ""]));
  return workspace => {
    const target = parseCloudWorkspaceKey(workspace.id) ?? parseCloudWorkspaceKey(workspace.path);
    return target ? (byId.get(target.workspaceId) ?? "") : null;
  };
}

/** One lookup per catalog snapshot (stable while the documents are). */
export function useCloudWorkspaceCreators(): CreatorOf {
  const documents = useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspaceDocuments, getCloudWorkspaceDocuments);
  return useMemo(() => creatorLookup(documents), [documents]);
}

/** Which Team sharing sidebar section a row belongs in for the viewer. A Local
 * row, a row without sharing fields and the viewer's own row are theirs; a
 * pinned row is Pinned whoever runs it; a teammate's row shows only when followed. */
export function sharingSectionLookup(documents: ReturnType<typeof getCloudWorkspaceDocuments>, me: string | null) {
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  return (workspace: Workspace): "pinned" | "mine" | "following" | null => {
    const target = parseCloudWorkspaceKey(workspace.id) ?? parseCloudWorkspaceKey(workspace.path);
    const doc = target ? byId.get(target.workspaceId) : undefined;
    if (!doc?.sharing) return "mine";
    if (doc.sharing.pinned) return "pinned";
    if (doc.sharing.viewerRole === "creator" || (me !== null && doc.ownerUserId === me)) return "mine";
    return doc.sharing.following ? "following" : null;
  };
}

export function useSharingSections(me: string | null) {
  const documents = useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspaceDocuments, getCloudWorkspaceDocuments);
  return useMemo(() => sharingSectionLookup(documents, me), [documents, me]);
}

/** Team sharing: true when this folder is a teammate's cloud workspace the
 * account only reads (never connected, woken or written). */
export function cloudFolderIsReader(folder: string | null | undefined): boolean {
  const target = folder ? parseCloudWorkspaceKey(folder) : null;
  return !!target && cloudWorkspaceDocument(target)?.sharing?.readOnly === true;
}
export function useCloudFolderIsReader(folder: string | null | undefined): boolean {
  const read = () => cloudFolderIsReader(folder);
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}
/** Team sharing phase 2: this folder is an activated workspace where members write as themselves. */
export function cloudFolderTeamWriting(folder: string | null | undefined): boolean {
  const target = folder ? parseCloudWorkspaceKey(folder) : null;
  return !!target && cloudWorkspaceDocument(target)?.sharing?.teamWriting === true;
}
export function useCloudFolderTeamWriting(folder: string | null | undefined): boolean {
  const read = () => cloudFolderTeamWriting(folder);
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}
/** One reader predicate per catalog snapshot, for lists of folders. */
export function useCloudReaderLookup(): (folder: string) => boolean {
  const documents = useSyncExternalStore(subscribeCloudWorkspaces, getCloudWorkspaceDocuments, getCloudWorkspaceDocuments);
  return useMemo(() => {
    const readers = new Set(documents.filter(doc => doc.sharing?.readOnly === true).map(doc => doc.id));
    return (folder: string) => {
      const target = parseCloudWorkspaceKey(folder);
      return !!target && readers.has(target.workspaceId);
    };
  }, [documents]);
}

/** The folder's cloud document when it carries Team sharing fields (a stable reference), else null. */
export function useCloudFolderSharedDocument(folder: string | null | undefined) {
  const read = () => {
    const target = folder ? parseCloudWorkspaceKey(folder) : null;
    const doc = target ? cloudWorkspaceDocument(target) : undefined;
    return doc?.sharing ? doc : null;
  };
  return useSyncExternalStore(subscribeCloudWorkspaces, read, read);
}

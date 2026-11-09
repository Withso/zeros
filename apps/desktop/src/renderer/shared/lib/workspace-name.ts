import {
  isWorkspaceNumber,
  workspaceNumberLabel,
} from "@zeros/protocol/local-orchestration";

/** A new workspace's name until one of its chats is first named; the
 * engine and control plane keep that first title on the workspace. */
export const UNTITLED_WORKSPACE_TITLE = "Untitled";

/** Titles a chat carries before it is named. The first other title one of a
 * workspace's chats receives becomes the workspace's title. */
const UNNAMED_CHAT_TITLES: ReadonlySet<string> = new Set(["", "Untitled", "New chat"]);

export function isNamedChatTitle(title: string | null | undefined): boolean {
  return !UNNAMED_CHAT_TITLES.has((title ?? "").trim());
}

/** A prepared Local workspace is "Untitled" (and `w-<n>`) from its first
 * frame, exactly as the row that replaces it. An engine that predates numbers
 * keeps naming the pending row by its branch. */
export function pendingWorkspaceIdentity(prepared: {
  number?: number;
}): { label?: string; number?: number } {
  return prepared.number === undefined
    ? {}
    : { label: UNTITLED_WORKSPACE_TITLE, number: prepared.number };
}

/** `w-310`: the workspace's permanent number within its owner, which the
 * column header shows. Null for a row without one (a folder, an older engine
 * or control plane). */
export function workspaceNumberName(
  workspace: { number?: number | null } | null | undefined,
): string | null {
  return workspace && isWorkspaceNumber(workspace.number)
    ? workspaceNumberLabel(workspace.number)
    : null;
}

/** A cloud workspace document's title by the sidebar's rule: "Untitled" until
 * its first chat is named; a control plane without titles keeps its name. */
export function cloudWorkspaceDocumentTitle(document: {
  name: string;
  title?: string | null;
}): string {
  if (document.title === undefined) return document.name;
  return document.title?.trim() || UNTITLED_WORKSPACE_TITLE;
}

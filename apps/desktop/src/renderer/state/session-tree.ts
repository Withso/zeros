// Parent and child sessions: the tree Local orchestration records
// (`parentChatId`/`rootChatId`) projected onto one workspace's chats.

import { isSideChat } from "../features/agent/side-chat-seeds";
import type { ChatThread } from "./store";

export interface SessionNode {
  chat: ChatThread;
  children: SessionNode[];
}

export interface SessionTree {
  /** Parent sessions of the folder, oldest first: its chats whose parent is
   *  unknown or lives in another folder. */
  roots: SessionNode[];
  byId: ReadonlyMap<string, SessionNode>;
}

/** Terminals and side chats are not sessions; side chats live only in their
 *  Workbench tabs. */
function isSession(chat: ChatThread, includeArchived: boolean): boolean {
  return chat.kind !== "terminal" && !isSideChat(chat) && (includeArchived || !chat.archived);
}

const byCreated = (a: SessionNode, b: SessionNode) =>
  a.chat.createdAt - b.chat.createdAt || a.chat.id.localeCompare(b.chat.id);

/** Build the session tree for `folder`. Children may live in other folders
 *  (a child workspace); they nest under their parent wherever it is. A
 *  read-only (archived) workspace includes its closed chats. */
export function buildSessionTree(
  chats: readonly ChatThread[],
  folder: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): SessionTree {
  const byId = new Map<string, SessionNode>();
  for (const chat of chats) if (isSession(chat, includeArchived)) byId.set(chat.id, { chat, children: [] });
  const roots: SessionNode[] = [];
  for (const node of byId.values()) {
    const parent = node.chat.parentChatId ? byId.get(node.chat.parentChatId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else if (node.chat.folder === folder) roots.push(node);
  }
  for (const node of byId.values()) {
    const parent = node.chat.parentChatId ? byId.get(node.chat.parentChatId) : undefined;
    if (node.chat.folder === folder && parent && parent.chat.folder !== folder && !roots.includes(node)) roots.push(node);
  }
  for (const node of byId.values()) node.children.sort(byCreated);
  roots.sort(byCreated);
  return { roots, byId };
}

/** The path from the session's parent session down to the session itself.
 *  Stops at a session that is a root of the tree's folder. */
export function sessionLineage(tree: SessionTree, chatId: string): ChatThread[] {
  const rootIds = new Set(tree.roots.map((root) => root.chat.id));
  const path: ChatThread[] = [];
  const seen = new Set<string>();
  let node = tree.byId.get(chatId);
  while (node && !seen.has(node.chat.id)) {
    seen.add(node.chat.id);
    path.unshift(node.chat);
    if (rootIds.has(node.chat.id)) break;
    node = node.chat.parentChatId ? tree.byId.get(node.chat.parentChatId) : undefined;
  }
  return path;
}

/** The parent session a chat belongs to in this folder, or null. */
export function sessionRootId(tree: SessionTree, chatId: string): string | null {
  const first = sessionLineage(tree, chatId)[0];
  return first && tree.roots.some((root) => root.chat.id === first.id) ? first.id : null;
}

/** Every descendant id, depth first. */
export function sessionDescendantIds(node: SessionNode): string[] {
  return node.children.flatMap((child) => [child.chat.id, ...sessionDescendantIds(child)]);
}

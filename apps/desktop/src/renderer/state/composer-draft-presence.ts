import { create } from "zustand";
import {
  getLiveChatDraft,
  liveChatDraftEntries,
  subscribeToLiveChatDrafts,
} from "../features/agent/composer-live-drafts";
import type { ChatThread, ComposerDraft } from "./store";
import { useWorkspaceStore } from "./workspace-store";
import { folderIsWithinRoot } from "./workspace-resolution";

function hasContent(draft: ComposerDraft | null | undefined): boolean {
  return (
    !!draft && (draft.attachments.length > 0 || draft.text.trim().length > 0)
  );
}

function editChatIds(): Set<string> {
  // Persisted edit keys use the existing `${chatId}:${messageId}` contract.
  return new Set(
    Object.keys(useWorkspaceStore.getState().editComposerDrafts).map((key) =>
      key.slice(0, key.indexOf(":")),
    ),
  );
}

let editedChats = editChatIds();

function chatHasDraft(chatId: string): boolean {
  return (
    editedChats.has(chatId) ||
    hasContent(
      getLiveChatDraft(chatId) ??
        useWorkspaceStore.getState().chatComposerDrafts[chatId],
    )
  );
}

function allDraftIds(): ReadonlySet<string> {
  const candidates = new Set([
    ...Object.keys(useWorkspaceStore.getState().chatComposerDrafts),
    ...[...liveChatDraftEntries()].map(([id]) => id),
    ...editedChats,
  ]);
  return new Set([...candidates].filter(chatHasDraft));
}

/** Derived, memory-only presence. A keystroke inspects only its own chat and
 * publishes only an empty/nonempty transition, never the text or attachment
 * progress. Consumers select booleans, so unrelated tabs keep their snapshot. */
export const useComposerDraftPresence = create<ReadonlySet<string>>(() =>
  allDraftIds(),
);

const stopLive = subscribeToLiveChatDrafts((chatId) => {
  const present = chatHasDraft(chatId);
  const current = useComposerDraftPresence.getState();
  if (current.has(chatId) === present) return;
  const next = new Set(current);
  if (present) next.add(chatId);
  else next.delete(chatId);
  useComposerDraftPresence.setState(next, true);
});

const stopSaved = useWorkspaceStore.subscribe((state, previous) => {
  if (
    state.chatComposerDrafts === previous.chatComposerDrafts &&
    state.editComposerDrafts === previous.editComposerDrafts
  )
    return;
  if (state.editComposerDrafts !== previous.editComposerDrafts)
    editedChats = editChatIds();
  const next = allDraftIds();
  const current = useComposerDraftPresence.getState();
  if (current.size === next.size && [...next].every((id) => current.has(id)))
    return;
  useComposerDraftPresence.setState(next, true);
});

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    stopLive();
    stopSaved();
  });

export function useChatHasDraft(chatId: string): boolean {
  return useComposerDraftPresence((ids) => ids.has(chatId));
}

export function useAnyChatHasDraft(chatIds: readonly string[]): boolean {
  return useComposerDraftPresence((ids) => chatIds.some((id) => ids.has(id)));
}

/** Closed tabs still own their drafts. A nested registered workspace wins
 * over its parent, including subdirectory chats and macOS path aliases. */
export function draftChatIdsByWorkspace(
  chats: readonly ChatThread[],
  workspaces: readonly { id: string; path: string }[],
): Map<string, string[]> {
  const grouped = new Map(
    workspaces.map((workspace) => [workspace.id, [] as string[]]),
  );
  for (const chat of chats) {
    if (chat.kind === "terminal") continue;
    let owner: (typeof workspaces)[number] | undefined;
    for (const workspace of workspaces) {
      if (
        folderIsWithinRoot(chat.folder, workspace.path) &&
        (!owner || folderIsWithinRoot(workspace.path, owner.path))
      )
        owner = workspace;
    }
    if (owner) grouped.get(owner.id)!.push(chat.id);
  }
  return grouped;
}

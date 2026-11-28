import { isSideChat } from "./side-chat-seeds";
import type { ChatThread } from "../../state/store";
import { useWorkspaceStore } from "../../state/store";
import { threadToRow } from "../../state/chat-row-wire";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { toast } from "@/renderer/shared/ui/primitives/elements";
import { dbCreateChildChat } from "./agent-history-client";
import { loadTranscriptSnapshot, transcriptPillLabel } from "./chat-transcript-attach";
import {
  deliverTextAttachmentToChat,
  trackPendingTextAttachmentDelivery,
} from "./composer-text-attachment-delivery";
import { buildForkTranscriptAttachment, createForkedChat } from "./fork-chat";

/** Add child session is Local only: Cloud workspaces have no Local
 *  orchestration links to nest the child with. A side chat is not a session,
 *  so it never parents one. */
export function canAddChildSession(parent: ChatThread | null | undefined): parent is ChatThread {
  return !!parent && parent.kind !== "terminal" && !isSideChat(parent) && !parent.archived && !!parent.folder && !isCloudWorkspace(parent.folder);
}

export function createChildChat(parent: ChatThread, id?: string, now?: number): ChatThread {
  return {
    ...createForkedChat(parent, id, now),
    parentChatId: parent.id,
    rootChatId: parent.rootChatId ?? parent.id,
  };
}

/** Seeded by Add child session, so it starts with the parent's handoff. */
export function hasParentContext(chat: ChatThread | null | undefined): boolean {
  return !!chat?.parentChatId && chat.sourceChatId === chat.parentChatId;
}

export interface AddChildSessionDeps {
  /** Publish route and destination in one synchronous store transition. */
  publishChat(chat: ChatThread): void;
  createChild?: typeof dbCreateChildChat;
  loadTranscript?: typeof loadTranscriptSnapshot;
  deliver?: typeof deliverTextAttachmentToChat;
  chatExists?(id: string): boolean;
  onError?(message: string, error: unknown): void;
}

export function addChildSession(parent: ChatThread, deps: AddChildSessionDeps): ChatThread | null {
  if (!canAddChildSession(parent)) return null;
  const {
    createChild = dbCreateChildChat,
    loadTranscript = loadTranscriptSnapshot,
    deliver = deliverTextAttachmentToChat,
    chatExists = (id) => useWorkspaceStore.getState().chats.some((chat) => chat.id === id),
    onError = (message, error) => {
      console.error(`[Zeros] ${message}`, error);
      toast.error(message);
    },
  } = deps;
  const child = createChildChat(parent);
  deps.publishChat(child);

  void createChild(threadToRow(child), parent.id).catch((error: unknown) => {
    if (chatExists(child.id)) onError("Couldn't link the child session to its parent.", error);
  });

  const sourceLabel = transcriptPillLabel({ title: parent.title, summary: "" });
  const delivery = loadTranscript({
    chatId: parent.id,
    mode: "handoff",
    // Message writes do not advance `updatedAt`; a fresh key never reuses an
    // older handoff from the transcript cache.
    lastMessageAt: Date.now(),
    meta: { title: sourceLabel, folder: parent.folder },
  })
    .then((snapshot) => {
      if (!chatExists(child.id) || snapshot.count === 0) return;
      deliver(
        child.id,
        buildForkTranscriptAttachment({
          sourceChatId: parent.id,
          sourceLabel,
          text: snapshot.text,
          complete: snapshot.complete,
          mode: "handoff",
        }),
      );
    })
    .catch((error: unknown) => {
      if (chatExists(child.id)) onError("Couldn't add the parent's context. Attach its transcript from the + menu.", error);
    });
  trackPendingTextAttachmentDelivery(child.id, delivery);
  return child;
}

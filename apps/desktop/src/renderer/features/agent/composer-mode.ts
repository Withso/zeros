import {
  composerModeSnapshotSchema,
  type ComposerMode,
} from "@zeros/protocol/composer-mode";
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { useWorkspaceStore } from "../../state/workspace-store";

const pending = new WeakMap<RuntimeClient, Map<string, Promise<void>>>();

/** Serialize user selections per conversation. Sends join this fence so an
 * immediate Enter cannot reach the agent with the preceding mode. */
export function setComposerMode(
  bridge: RuntimeClient,
  chatId: string,
  mode: ComposerMode,
): Promise<void> {
  let queue = pending.get(bridge);
  if (!queue) {
    queue = new Map();
    pending.set(bridge, queue);
  }
  const chat = useWorkspaceStore
    .getState()
    .chats.find((value) => value.id === chatId);
  if (!chat) return Promise.reject(new Error("Conversation is unavailable."));
  const operation = (queue.get(chatId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const current = useWorkspaceStore
        .getState()
        .chats.find((value) => value.id === chatId);
      if (!current || current.folder !== chat.folder)
        throw new Error("The conversation workspace changed.");
      const result = composerModeSnapshotSchema.parse(
        await workspaceOp(bridge, "chats.setComposerMode", {
          chatId,
          folder: chat.folder,
          mode,
          // A new chat can be selected before its ordinary sidebar write-through.
          // The engine only uses this seed for a never-persisted, non-deleted ID.
          initialChat: current,
        }),
      );
      useWorkspaceStore.getState().dispatch({
        type: "SET_CHAT_COMPOSER_MODE",
        id: chatId,
        folder: chat.folder,
        mode: result.mode,
        revision: result.revision,
      });
    });
  queue.set(chatId, operation);
  void operation
    .finally(() => {
      if (queue!.get(chatId) === operation) queue!.delete(chatId);
    })
    .catch(() => {});
  return operation;
}

export function awaitComposerMode(
  bridge: RuntimeClient,
  chatId: string,
): Promise<void> | undefined {
  // Preserve the synchronous dispatch path when there is no selection to join.
  if (!pending.get(bridge)?.has(chatId)) return undefined;
  // A second selection may be queued while the preceding request settles.
  return (async () => {
    let flight: Promise<void> | undefined;
    while ((flight = pending.get(bridge)?.get(chatId))) await flight;
  })();
}

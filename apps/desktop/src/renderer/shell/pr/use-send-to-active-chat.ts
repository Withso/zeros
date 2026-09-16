// ──────────────────────────────────────────────────────────
// useSendToActiveChat — fire a prompt at the active chat from anywhere
// ──────────────────────────────────────────────────────────
//
// The header "Create PR" button and the PR status island both need to drop a
// prompt into the chat the user is currently looking at, without being mounted
// inside a chat view. Prepare the chat just as the composer does: hydrate its
// history and bind its selected agent before calling the provider sender.
// The provider can recover an existing slot, but cannot start an unbound one.
//
// `text` is what the agent receives; `displayText` + `bubbleAttachments` +
// `segments` + `autoAction` shape the user bubble (so "Create a PR" shows as
// a tidy auto-sent label + icon while the agent gets the full brief).
// ──────────────────────────────────────────────────────────

import { useCallback } from "react";
import { legacyProviderBinding } from "@zeros/protocol/identities";

import { useAgentSessions } from "../../features/agent/sessions-hooks";
import { envForChat } from "../../features/agent/model-catalog";
import type { AutoActionKind } from "../../features/agent/auto-action";
import { useBridge } from "../../platform/bridge/use-bridge";
import type {
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "../../features/agent/use-agent-session";
import {
  recordWorkspaceActivity,
  useActiveChatId,
  useWorkspaceStore,
} from "../../state/store";
import { folderIsWithinRoot } from "../../state/workspace-resolution";
import { toast } from "../../shared/ui/primitives/elements";

export interface SendToActiveChatArgs {
  /** Wire text — what the agent receives. */
  text: string;
  /** Bubble text — defaults to `text` when omitted. */
  displayText?: string;
  bubbleAttachments?: AgentTextMessageAttachment[];
  segments?: MessageContentSegment[];
  /** Auto-sent action kind (PR island / Create PR buttons). Renders the
   *  bubble with the "sent by Zeros" treatment — icon + brown bubble,
   *  copy-only. Typed as the canonical union so producers can't stamp a kind
   *  the icon registry doesn't know. See AgentTextMessage.autoAction. */
  autoAction?: AutoActionKind;
  /** Called when the accepted send finishes or fails. Action surfaces use it
   *  to retain their synchronous single-flight claim for the whole turn. */
  onSettled?: () => void;
}

export function useSendToActiveChat(
  workspacePath: string,
): (args: SendToActiveChatArgs) => boolean {
  const sessions = useAgentSessions();
  const bridge = useBridge();
  // Capture the click's chat across PR preflight awaits. Reading the global
  // active id when those finish would redirect the action after navigation.
  const activeChatId = useActiveChatId();

  return useCallback(
    ({
      text,
      displayText,
      bubbleAttachments,
      segments,
      autoAction,
      onSettled,
    }: SendToActiveChatArgs) => {
      const targetChat = () => {
        const chat = useWorkspaceStore
          .getState()
          .chats.find((chat) => chat.id === activeChatId);
        if (
          !chat ||
          chat.archived ||
          !folderIsWithinRoot(chat.folder, workspacePath)
        ) {
          throw new Error("Open or start a chat in this workspace first.");
        }
        if (chat.kind === "terminal") {
          throw new Error("Open an agent chat to send this PR action.");
        }
        if (!chat.agentId) {
          throw new Error("Choose an agent for this chat first.");
        }
        if (!bridge || bridge.status !== "connected") {
          throw new Error(
            "The engine is reconnecting. Try again once connected.",
          );
        }
        return { ...chat, agentId: chat.agentId };
      };
      const reportError = (error: unknown) => {
        toast.error("Couldn't send to agent", {
          description: error instanceof Error ? error.message : String(error),
        });
      };
      try {
        targetChat();
      } catch (error) {
        reportError(error);
        return false;
      }
      recordWorkspaceActivity(workspacePath);
      void (async () => {
        let chat = targetChat();
        if (sessions.getSession(chat.id)?.transcriptState !== "resident") {
          await sessions.hydrateChat(chat.id);
          chat = targetChat();
          if (sessions.getSession(chat.id)?.transcriptState !== "resident") {
            throw new Error(
              "Couldn't load this chat. Try again once it reconnects.",
            );
          }
        }
        const slot = sessions.getSession(chat.id);
        if (slot?.agentId !== chat.agentId) {
          const options = {
            agentName: chat.agentName ?? chat.agentId,
            cwd: chat.folder,
            env: envForChat(chat, slot?.initialize),
          };
          const binding =
            (chat.providerBinding?.providerId === chat.agentId
              ? chat.providerBinding
              : undefined) ??
            (chat.sessionId
              ? legacyProviderBinding(chat.agentId, chat.sessionId)
              : undefined);
          // A cold existing conversation must re-adopt its provider thread,
          // including when only the engine still knows its resume identity.
          const adopted =
            binding || slot?.hasTranscript
              ? await sessions.loadIntoChat(
                  chat.id,
                  chat.agentId,
                  binding ?? null,
                  options,
                )
              : false;
          targetChat();
          if (!adopted)
            await sessions.ensureSession(chat.id, chat.agentId, options);
          const ready = sessions.getSession(chat.id);
          if (!ready?.sessionId || ready.agentId !== chat.agentId) {
            throw new Error(
              ready?.error ?? "Couldn't start this chat's agent. Try again.",
            );
          }
        }
        if (targetChat().agentId !== chat.agentId) {
          throw new Error(
            "This chat's agent changed. Try the PR action again.",
          );
        }
        await sessions.sendPrompt(
          chat.id,
          text,
          displayText,
          undefined,
          bubbleAttachments,
          segments,
          autoAction,
        );
      })()
        .catch(reportError)
        .finally(() => onSettled?.());
      return true;
    },
    [sessions, bridge, activeChatId, workspacePath],
  );
}

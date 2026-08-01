// ──────────────────────────────────────────────────────────
// useSendToActiveChat — fire a prompt at the active chat from anywhere
// ──────────────────────────────────────────────────────────
//
// The header "Create PR" button and the PR status island both need to drop a
// prompt into the chat the user is currently looking at, without being mounted
// inside a chat view. `useAgentSessions()` exposes the stable, provider-level
// `sendPrompt(chatId, …)` — the same self-healing send path the composer uses
// (it queues behind an in-flight turn and respawns a dead session), so this is
// just a thin, target-the-active-chat wrapper over it.
//
// `text` is what the agent receives; `displayText` + `bubbleAttachments` +
// `segments` + `autoAction` shape the user bubble (so "Create a PR" shows as
// a tidy auto-sent label + icon while the agent gets the full brief).
// ──────────────────────────────────────────────────────────

import { useCallback } from "react";

import { useAgentSessions } from "../../zeros/agent/sessions-hooks";
import type { AutoActionKind } from "../../zeros/agent/auto-action";
import type {
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "../../zeros/agent/use-agent-session";
import { useActiveChatId } from "../../zeros/store/store";
import { toast } from "../../zeros/ui/primitives/elements";

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

export function useSendToActiveChat(): (args: SendToActiveChatArgs) => boolean {
  const sessions = useAgentSessions();
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
      if (!activeChatId) {
        toast.error("No active chat", {
          description: "Open or start a chat in this workspace first.",
        });
        return false;
      }
      sessions
        .sendPrompt(
          activeChatId,
          text,
          displayText,
          undefined,
          bubbleAttachments,
          segments,
          autoAction,
        )
        .catch(() => {
          // The error surfaces on the chat's own error state; this is a
          // fire-and-forget from a button.
        })
        .finally(() => onSettled?.());
      return true;
    },
    [sessions, activeChatId],
  );
}

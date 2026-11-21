import { useMemo } from "react";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { useSessionsStore } from "./sessions-store";

export interface NativeSubagent {
  id: string;
  ownerChatId: string;
  title: string;
  running: boolean;
}

/** Provider-native subagents (Claude Task, Codex agents) a chat started
 *  directly. Nested subagents stay inside their parent's card. */
export function nativeSubagentsOf(ownerChatId: string, messages: readonly AgentMessage[]): NativeSubagent[] {
  return messages.flatMap((m) =>
    m.kind === "tool" && m.toolKind === "subagent" && !m.parentToolId
      ? [{
          id: m.toolCallId,
          ownerChatId,
          title: m.title.trim() || "Agent",
          running: m.status === "pending" || m.status === "in_progress",
        }]
      : []);
}

const SEP = "\u0000";
const ROW = "\u0001";

/** Primitive selector key so transcript deltas that do not touch a subagent
 *  leave subscribers alone. */
export function useNativeSubagents(chatIds: readonly string[]): readonly NativeSubagent[] {
  const key = useSessionsStore((state) => chatIds.flatMap((chatId) => {
    const messages = state.sessions[chatId]?.messages;
    return messages
      ? nativeSubagentsOf(chatId, messages).map((s) => [s.id, chatId, s.title, s.running ? "1" : ""].join(SEP))
      : [];
  }).join(ROW));
  return useMemo(() => (key
    ? key.split(ROW).map((row) => {
        const [id, ownerChatId, title, running] = row.split(SEP);
        return { id: id!, ownerChatId: ownerChatId!, title: title!, running: running === "1" };
      })
    : []), [key]);
}

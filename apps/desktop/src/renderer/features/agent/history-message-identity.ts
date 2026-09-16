import type { AgentMessage } from "@zeros/protocol/agent-messages";

/** History can overlap an already loaded window. Only the durable row id
 * proves two snapshots represent the same event. Names, arguments and native
 * ids can repeat across real calls or executions, including unnamed results. */
export function reconcileHistoryMessages(
  messages: AgentMessage[],
): AgentMessage[] {
  const positions = new Map<string, number>();
  let output: AgentMessage[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const key = message.id;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, output?.length ?? index);
      output?.push(message);
    } else {
      output ??= messages.slice(0, index);
      const previous = output[position];
      if (previous.kind === "text" && previous.retracted) continue;
      if (message.kind === "text" && message.retracted) { output[position] = message; continue; }
      if (message.kind === "tool" && previous.kind === "tool" && (message.resultRevision ?? 0) !== (previous.resultRevision ?? 0)) {
        if ((message.resultRevision ?? 0) > (previous.resultRevision ?? 0)) output[position] = message;
        continue;
      }
      const time = snapshotTime(message);
      const previousTime = snapshotTime(previous);
      // Millisecond timestamps can tie across a replay. A start cannot erase
      // a recorded result, including its failure output.
      const staleStart =
        message.kind === "tool" &&
        previous.kind === "tool" &&
        (previous.status === "completed" || previous.status === "failed") &&
        (message.status === "pending" || message.status === "in_progress");
      if (time > previousTime || (time === previousTime && !staleStart))
        output[position] = message;
    }
  }
  return output ?? messages;
}

function snapshotTime(message: AgentMessage): number {
  return "updatedAt" in message && typeof message.updatedAt === "number"
    ? message.updatedAt
    : message.createdAt;
}

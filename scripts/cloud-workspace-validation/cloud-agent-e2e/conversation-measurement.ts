import { randomUUID } from "node:crypto";
import { measureBootOwnerTurn } from "./baseline";

type Input = Omit<Parameters<typeof measureBootOwnerTurn>[1], "existing">;
type Measurement = Awaited<ReturnType<typeof measureBootOwnerTurn>>;
export type ConversationMeasurement = {
  conversationId: string;
  turnKind: "cold-first" | "same-conversation-second";
  turnOrdinal: 1 | 2;
  measurement: Measurement;
};

/** Two independently verified renderer sends. The second loads the exact
 * existing conversation after the first final proof, with a fresh message
 * identity. An invalid-auth first turn does not prove a surviving native
 * host, so this labels conversational reuse rather than provider success or
 * native-domain reuse. A failure never causes a retry or another enqueue. */
export async function measureBootOwnerConversation(bridge: Parameters<typeof measureBootOwnerTurn>[0], input: Input,
  observe: (row: ConversationMeasurement) => void,
): Promise<void> {
  const first = await measureBootOwnerTurn(bridge, { ...input, existing: false });
  observe({ conversationId: input.conversationId, turnKind: "cold-first", turnOrdinal: 1, measurement: first });
  const second = await measureBootOwnerTurn(bridge, { ...input, existing: true, userMessageId: randomUUID() });
  observe({ conversationId: input.conversationId, turnKind: "same-conversation-second", turnOrdinal: 2, measurement: second });
}

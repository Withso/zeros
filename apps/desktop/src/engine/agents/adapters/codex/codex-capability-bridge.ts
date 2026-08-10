import type {
  CodexCapabilityOperation,
  CodexCapabilityRequestMessage,
} from "@zeros/protocol/messages";

import { createMessage, type EngineMessage } from "../../../types";
import type { TransportClient } from "../../../transport/types";

export interface CodexCapabilityInvocation {
  operation: CodexCapabilityOperation;
  cwd: string;
  sessionId?: string;
  params?: unknown;
}

const REQUEST_TYPES = new Set<EngineMessage["type"]>([
  "CODEX_CAPABILITY_REQUEST",
]);

export function isCodexCapabilityRequest(
  msg: EngineMessage,
): msg is CodexCapabilityRequestMessage {
  return REQUEST_TYPES.has(msg.type);
}

/** Local-desktop trust boundary for Codex app-server capability RPCs. The
 * explicit operation allowlist lives in @zeros/protocol; arbitrary JSON-RPC is
 * never exposed to the renderer or relay. */
export class CodexCapabilityBridge {
  constructor(
    private readonly invoke: (
      request: CodexCapabilityInvocation,
    ) => Promise<unknown>,
  ) {}

  async handle(
    msg: CodexCapabilityRequestMessage,
    client: TransportClient,
  ): Promise<void> {
    if (client.kind !== "local") {
      this.reply(msg, client, undefined, {
        code: "LOCAL_ONLY",
        message:
          "Codex capability management is available only on the trusted desktop.",
      });
      return;
    }

    try {
      const result = await this.invoke({
        operation: msg.operation,
        cwd: msg.cwd,
        sessionId: msg.sessionId,
        params: msg.params,
      });
      this.reply(msg, client, result);
    } catch (error) {
      this.reply(msg, client, undefined, {
        code: "UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reply(
    msg: CodexCapabilityRequestMessage,
    client: TransportClient,
    result?: unknown,
    error?: {
      code: "LOCAL_ONLY" | "UNAVAILABLE" | "INVALID_REQUEST" | "UNSUPPORTED";
      message: string;
    },
  ): void {
    client.send(
      createMessage({
        type: "CODEX_CAPABILITY_RESPONSE",
        source: "engine",
        requestId: msg.id,
        operation: msg.operation,
        ...(error ? { error } : { result }),
      }),
    );
  }
}

import type {
  BridgeMessage,
  CodexCapabilityOperation,
  CodexCapabilityResponseMessage,
} from "@zeros/protocol/messages";

import { getActiveBridge } from "../../platform/bridge/active-bridge";

const CAPABILITY_TIMEOUT_MS = 30_000;

export interface CodexCapabilityInput {
  operation: CodexCapabilityOperation;
  cwd: string;
  sessionId?: string;
  params?: unknown;
}

export class CodexCapabilityClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexCapabilityClientError";
    this.code = code;
  }
}

export async function callCodexCapability<T = unknown>(
  input: CodexCapabilityInput,
): Promise<T> {
  const bridge = getActiveBridge();
  if (!bridge) {
    throw new CodexCapabilityClientError(
      "DISCONNECTED",
      "The Zeros engine is not connected yet.",
    );
  }
  const response = await bridge.request<CodexCapabilityResponseMessage>(
    {
      type: "CODEX_CAPABILITY_REQUEST",
      operation: input.operation,
      cwd: input.cwd,
      sessionId: input.sessionId,
      params: input.params,
    } as Partial<BridgeMessage> & { type: string },
    CAPABILITY_TIMEOUT_MS,
  );
  if (
    response.type !== "CODEX_CAPABILITY_RESPONSE" ||
    response.operation !== input.operation
  ) {
    throw new CodexCapabilityClientError(
      "PROTOCOL_ERROR",
      `Unexpected response to ${input.operation}: ${response.type}`,
    );
  }
  if (response.error) {
    throw new CodexCapabilityClientError(
      response.error.code,
      response.error.message,
    );
  }
  return response.result as T;
}

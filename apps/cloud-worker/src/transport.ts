import type { CloudV2WorkerFrame, CloudV2WorkerTiming } from "@zeros/protocol/cloud-v2-relay";
import type { McpAuthorizationRequest } from "./mcp/gateway";

export type PromptOperation = "pull" | "ack" | "begin" | "outcome" | "stop-ack" | "stop";
export type PromptRequest = (operation: PromptOperation, body: unknown, signal?: AbortSignal) => Promise<unknown>;

export interface TransportHandlers {
  open(): void | Promise<void>;
  frame(raw: unknown): Promise<void>;
  close(): void;
}

/** No offline queue: native work stays in the session store, and a fresh
 * connection backfills history. Replaying opaque prompt frames is unsafe. */
export interface Transport {
  start(handlers: TransportHandlers): void;
  send(frame: CloudV2WorkerFrame): Promise<boolean>;
  dispose(): Promise<void>;
  /** Durable explicit work has its own typed/idempotent HTTPS channel. */
  promptRequest?: PromptRequest;
  mcpAuthorization?: McpAuthorizationRequest;
  /** Best-effort diagnostics, independent of strict authority/history frames. */
  reportTiming?: (record: CloudV2WorkerTiming) => void;
}

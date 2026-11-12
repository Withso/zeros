import type { NotifyUserWorkerRequest } from "@zeros/protocol/notify-user";
import type { NotifyUserDelivery } from "./notify-user/service";
import type { CloudEnvironmentReport, CloudRuntimeUpdateReply, CloudRuntimeUpdateRequest, CloudV2SetupStatus, CloudV2WorkerFrame, CloudV2WorkerTiming } from "@zeros/protocol/cloud-v2-relay";
import type { LocalCommandInput, LocalCommandResult } from "@zeros/protocol/local-commands";
import type { McpAuthorizationRequest } from "./mcp/gateway";
import type { ReportGithubCheckout } from "./workspace/github-checkout";

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
  send(frame: CloudV2WorkerFrame, options?: { timeoutMs: number }): Promise<boolean>;
  dispose(): Promise<void>;
  /** Durable explicit work has its own typed/idempotent HTTPS channel. */
  promptRequest?: PromptRequest;
  mcpAuthorization?: McpAuthorizationRequest;
  /** local-commands-v1: one RunLocalCommand through the control plane to the
   * requester's Mac. The control plane chooses the Mac; the worker only names the chat. */
  localCommand?(request: { chatId: string; executionId: string; input: LocalCommandInput; contextId?: string }, signal: AbortSignal): Promise<{ result: LocalCommandResult; acknowledge(): Promise<void> }>;
  /** Before dispatching a legacy relay prompt or steer: a narrow secondary fence; never restores authority. */
  retireLocalCommandSender?(request: { chatId: string; executionId: string }): Promise<void>;
  /** Local commands awaiting their terminal result count as busy work. */
  readonly localCommandsPending?: number;
  reportGithubCheckout?: ReportGithubCheckout;
  reportCheckoutFailure?: () => Promise<void>;
  reportEnvironment?: (report: CloudEnvironmentReport, signal?: AbortSignal) => Promise<void>;
  /** notify-user-v1: POST notifications (202); 409 already_notified and 429 are answers, not failures. */
  notifyUser?(request: NotifyUserWorkerRequest, signal?: AbortSignal): Promise<NotifyUserDelivery>;
  /** setup-status-v1: POST setup, 204. Best effort; the next hello reports again. */
  reportSetup?: (status: CloudV2SetupStatus) => Promise<void>;
  runtimeUpdate?: (request: CloudRuntimeUpdateRequest, signal?: AbortSignal) => Promise<CloudRuntimeUpdateReply>;
  readyRuntime?: () => Promise<void>;
  /** Team sharing slice B (acting-user-v1): POST /v2/cloud/worker/<path> for leases, renew and retirement.
   * A refusal throws with `status` and the closed `contextCode` from its body. */
  contextRequest?(path: string, body: unknown): Promise<unknown>;
  /** Best-effort diagnostics, independent of strict authority/history frames. */
  reportTiming?: (record: CloudV2WorkerTiming) => void;
}

import type { ContentBlock, PromptResponse, SessionNotification, QuestionRequest, QuestionResponse, RequestPermissionRequest, RequestPermissionResponse } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import type { DriverTimingStage } from "../agent-timings";
import type { DriverMcpServers } from "../mcp/gateway";
import type { ApplicationEnvironment } from "../credentials/application-environment";

interface DriverSession {
  sessionId: string;
  cwd: string;
  model?: string;
  /** Persisted chat selection. Each driver maps only its supported native values. */
  effort?: string;
  fast?: boolean;
  nativeSessionId?: string;
  application?: ApplicationEnvironment;
  onTiming?: (stage: DriverTimingStage) => void;
  mcpServers?: DriverMcpServers;
  modeId?: string;
  onQuestion?: (request: QuestionRequest, signal?: AbortSignal) => Promise<QuestionResponse>;
  onPermission?: (request: RequestPermissionRequest, signal?: AbortSignal) => Promise<RequestPermissionResponse>;
}

export type DriverOpen = DriverSession & (
  | { proxy: { baseUrl: string; token: string }; apiKey?: never; oauthToken?: never }
  | { apiKey: string; proxy?: never; oauthToken?: never }
  | { oauthToken: string; proxy?: never; apiKey?: never }
);

function redactCredentials(message: string, input?: DriverOpen): string {
  const secrets = [input?.proxy?.token, input?.oauthToken, input?.apiKey,
    ...Object.values(input?.mcpServers ?? {}).flatMap(server => Object.values(server.headers))]
    .filter((value): value is string => !!value).flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value])
    .sort((a,b) => b.length - a.length);
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]").split(JSON.stringify(secret).slice(1,-1)).join("[redacted]"), message);
}

export function redactDriverMessage(message: string, input?: DriverOpen): string {
  const redacted = redactCredentials(message, input);
  return input?.application?.diagnostic(redacted) ?? redacted;
}

/** Canonical identities survive short app values; raw tool data has no such exemption. */
export function redactDriverValue<T>(value: T, input?: DriverOpen): T {
  const redacted = JSON.parse(redactCredentials(JSON.stringify(value), input)) as T;
  return input?.application?.value(redacted) ?? redacted;
}

/** One driver owns one native conversation. Relay/inbox/history are worker-owned. */
export interface Driver {
  /** A reserved native UUID is not yet evidence that a resumable conversation
   * exists. Provisional drivers confirm it via provider_binding_update. */
  open(input: DriverOpen): Promise<{ nativeSessionId: string; provisional?: boolean }>;
  prompt(content: ContentBlock[]): Promise<PromptResponse>;
  steer(content: ContentBlock[]): Promise<SteerOutcome>;
  setModel(model: string): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  /** Optional native live settings; credentials never enter this courier. */
  updateConfig?(config: { model?: string; effort?: string; fast: boolean }): Promise<void>;
  interrupt(): Promise<void>;
  onEvent(emit: (event: SessionNotification) => void): () => void;
  dispose(): Promise<void>;
}

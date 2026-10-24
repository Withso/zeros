import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";
import type { DriverTimingStage } from "../agent-timings";
import type { DriverMcpServers } from "../mcp/gateway";

interface DriverSession {
  sessionId: string;
  cwd: string;
  model?: string;
  /** Persisted chat selection. Each driver maps only its supported native values. */
  effort?: string;
  nativeSessionId?: string;
  onTiming?: (stage: DriverTimingStage) => void;
  mcpServers?: DriverMcpServers;
}

export type DriverOpen = DriverSession & (
  | { proxy: { baseUrl: string; token: string }; apiKey?: never; oauthToken?: never }
  | { apiKey: string; proxy?: never; oauthToken?: never }
  | { oauthToken: string; proxy?: never; apiKey?: never }
);

export function redactDriverMessage(message: string, input?: DriverOpen): string {
  const secrets = [input?.proxy?.token, input?.oauthToken, input?.apiKey,
    ...Object.values(input?.mcpServers ?? {}).flatMap(server => Object.values(server.headers))]
    .filter((value): value is string => !!value).flatMap(value => /^Bearer /i.test(value) ? [value, value.slice(7)] : [value])
    .sort((a,b) => b.length - a.length);
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]").split(JSON.stringify(secret).slice(1,-1)).join("[redacted]"), message);
}

/** One driver owns one native conversation. Relay/inbox/history are worker-owned. */
export interface Driver {
  /** A reserved native UUID is not yet evidence that a resumable conversation
   * exists. Provisional drivers confirm it via provider_binding_update. */
  open(input: DriverOpen): Promise<{ nativeSessionId: string; provisional?: boolean }>;
  prompt(content: ContentBlock[]): Promise<PromptResponse>;
  steer(content: ContentBlock[]): Promise<SteerOutcome>;
  setModel(model: string): Promise<void>;
  interrupt(): Promise<void>;
  onEvent(emit: (event: SessionNotification) => void): () => void;
  dispose(): Promise<void>;
}

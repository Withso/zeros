import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { SteerOutcome } from "@zeros/protocol/messages";

export interface DriverOpen {
  sessionId: string;
  cwd: string;
  model?: string;
  nativeSessionId?: string;
  proxy: { baseUrl: string; token: string };
}

/** One driver owns one native conversation. Relay/inbox/history are worker-owned. */
export interface Driver {
  open(input: DriverOpen): Promise<{ nativeSessionId: string }>;
  prompt(content: ContentBlock[]): Promise<PromptResponse>;
  steer(content: ContentBlock[]): Promise<SteerOutcome>;
  setModel(model: string): Promise<void>;
  interrupt(): Promise<void>;
  onEvent(emit: (event: SessionNotification) => void): () => void;
  dispose(): Promise<void>;
}

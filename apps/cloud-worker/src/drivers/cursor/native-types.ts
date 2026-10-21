import type { AgentOptions, SDKUserMessage } from "@cursor/sdk";

export const CURSOR_VERSION = "1.0.37";
export type { AgentUsage as CursorAgentUsage } from "@cursor/sdk";
export interface NativeResult { id: string; status: string; result?: string; error?: { message?: string; code?: string }; model?: { id: string }; usage?: unknown }
export interface NativeRun {
  id: string;
  stream(): AsyncIterable<unknown>;
  wait(): Promise<NativeResult>;
  cancel(): Promise<void>;
  steer?(text: string): Promise<string>;
}
export interface NativeSend {
  model: { id: string }; mode: "agent"; local: { force: true }; idempotencyKey: string;
  onStep(args: { step: unknown }): Promise<void>;
  onDelta(args: { update: unknown }): Promise<void>;
}
export interface NativeAgent {
  agentId: string;
  send(message: SDKUserMessage, options: NativeSend): Promise<NativeRun>;
  close(): void;
  getUsage(): Promise<unknown>;
}
export interface NativeSDK {
  create(options: AgentOptions): Promise<NativeAgent>;
  resume(id: string, options: AgentOptions): Promise<NativeAgent>;
}
export interface OpenParams { cwd: string; nativeSessionId?: string; model: string }
export interface PromptParams { turnId: string; content: SDKUserMessage; model: string }
export type HostEvent = { t: "event"; turnId: string; kind: "started" | "delta" | "step" | "message" | "result" | "error"; value: unknown };
export type HostRequest = { id: number; method: string; params: unknown };
export type HostResponse = { t: "reply"; id: number; value?: unknown; error?: string };

import type { AgentOptions, SDKUserMessage } from "@cursor/sdk";
import type { DriverMcpServers } from "../../mcp/gateway";
import type { CursorModelRecord, CursorModelSelection } from "./model-selection";

export const CURSOR_VERSION = "1.2.0";
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
  model: CursorModelSelection; mode: "agent" | "plan"; local: { force: true }; idempotencyKey: string;
  onStep(args: { step: unknown }): Promise<void>;
  onDelta(args: { update: unknown }): Promise<void>;
}
export interface NativeAgent {
  agentId: string;
  send(message: SDKUserMessage, options: NativeSend, native?: NativeCallOptions): Promise<NativeRun>;
  close(): void;
  getUsage(): Promise<unknown>;
}
/** The catalog record for the selected model, so the SDK need not fetch the
 * account's catalog again inside create, resume or send (local-model-catalog.ts). */
export interface NativeCallOptions { localModelCatalog: CursorModelRecord[] }
export interface NativeSDK {
  create(options: AgentOptions, native?: NativeCallOptions): Promise<NativeAgent>;
  resume(id: string, options: AgentOptions, native?: NativeCallOptions): Promise<NativeAgent>;
}
export interface OpenParams { cwd: string; nativeSessionId?: string; model: string; effort?: string; fast?: boolean; mcpServers?: DriverMcpServers; modeId?: "agent" | "plan" }
export interface PromptParams { turnId: string; content: SDKUserMessage; model: string; effort?: string; fast?: boolean; modeId?: "agent" | "plan" }
export type HostEvent = { t: "event"; turnId: string; kind: "started" | "delta" | "step" | "message" | "result" | "error"; value: unknown };
export type HostRequest = { id: number; method: string; params: unknown };
export type HostResponse = { t: "reply"; id: number; value?: unknown; error?: string };

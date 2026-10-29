import { randomUUID } from "node:crypto";
import type { ContentBlock, PromptResponse, SessionNotification } from "@zeros/protocol/agent-events";
import type { CloudV2ControlFrame, CloudV2WorkerFrame } from "@zeros/protocol/cloud-v2-relay";
import type { BridgeMessage, SteerOutcome } from "@zeros/protocol/messages";
import type { Driver, DriverOpen } from "../drivers/driver";
import type { Transport, TransportHandlers } from "../transport";

export const CLIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CLIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
export const WORKSPACE_KEY = `cloud://11111111-1111-4111-8111-111111111111/${WORKSPACE_ID}`;
export const config: Extract<CloudV2ControlFrame, { t: "config" }> = {
  t: "config", loginRevision: "0", workspace: { id: WORKSPACE_ID, organizationId: "11111111-1111-4111-8111-111111111111", checkoutPath: "/fixture/checkout", repository: "fixture/repo", branch: "workspace/fixture", baseBranch: "main" },
  agents: { codex: { baseUrl: "http://127.0.0.1:1/v1", token: "fixture-proxy-token", expiresAt: 9_999_999_999_999 } },
};
export const browserFrame = <T extends Record<string, unknown>>(type: string, fields: T = {} as T) => ({ id: randomUUID() as string, source: "browser", timestamp: Date.now(), type, ...fields });

export class FakeRelay implements Transport {
  frames: CloudV2WorkerFrame[] = [];
  connected = false;
  handlers!: TransportHandlers;
  start(handlers: TransportHandlers): void { this.handlers = handlers; this.connected = true; void handlers.open(); }
  async send(frame: CloudV2WorkerFrame): Promise<boolean> { if (!this.connected) return false; this.frames.push(structuredClone(frame)); return true; }
  async receive(frame: unknown): Promise<void> { await this.handlers.frame(frame); }
  async request(clientId: string, frame: unknown): Promise<void> { await this.receive({ t: "frame", clientId, frame }); }
  disconnect(): void { this.connected = false; this.handlers.close(); }
  async reconnect(): Promise<void> { this.connected = true; await this.handlers.open(); }
  async dispose(): Promise<void> { this.disconnect(); }
  bridge(type?: string): Array<{ clientId: string; frame: BridgeMessage }> {
    return this.frames.flatMap((item) => item.t === "frame" && (!type || (item.frame as BridgeMessage).type === type) ? [{ clientId: item.clientId, frame: item.frame as BridgeMessage }] : []);
  }
  response(requestId: string): BridgeMessage | undefined { return this.bridge().map((entry) => entry.frame).find((frame) => "requestId" in frame && frame.requestId === requestId); }
}

export class FakeDriver implements Driver {
  opened?: DriverOpen;
  opening?: Promise<void>;
  prompts: ContentBlock[][] = [];
  steers: ContentBlock[][] = [];
  model?: string;
  configs: Array<{ model?: string; effort?: string; fast: boolean }> = [];
  disposed = false;
  interrupts = 0;
  steerResult: SteerOutcome | Promise<SteerOutcome> = "delivered";
  private resolve?: (result: PromptResponse) => void;
  private reject?: (error: Error) => void;
  private listeners = new Set<(event: SessionNotification) => void>();
  async open(input: DriverOpen): Promise<{ nativeSessionId: string }> {
    this.opened = input;
    await this.opening;
    if (this.disposed) throw new Error("Driver closed.");
    return { nativeSessionId: input.nativeSessionId ?? `native-${input.sessionId}` };
  }
  prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.prompts.push(content);
    return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
  }
  complete(response: PromptResponse = { stopReason: "end_turn" }): void { this.resolve?.(response); this.resolve = undefined; this.reject = undefined; }
  fail(): void { this.reject?.(new Error("Native request failed.")); this.resolve = undefined; this.reject = undefined; }
  async steer(content: ContentBlock[]): Promise<SteerOutcome> { this.steers.push(content); return this.steerResult; }
  async setModel(model: string): Promise<void> { this.model = model; }
  async updateConfig(config: { model?: string; effort?: string; fast: boolean }): Promise<void> {
    if (config.model !== undefined) this.model = config.model;
    this.configs.push(config);
  }
  async interrupt(): Promise<void> { this.interrupts++; this.complete({ stopReason: "cancelled" }); }
  onEvent(emit: (event: SessionNotification) => void): () => void { this.listeners.add(emit); return () => this.listeners.delete(emit); }
  emit(update: SessionNotification["update"]): void { for (const listener of this.listeners) listener({ sessionId: this.opened!.sessionId, update }); }
  async dispose(): Promise<void> { this.disposed = true; this.complete({ stopReason: "cancelled" }); }
}

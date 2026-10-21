import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export class Channel<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting?: (item: IteratorResult<T>) => void;
  private ended = false;
  push(value: T): void { if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ done: false, value }); } else this.values.push(value); }
  end(): void { this.ended = true; this.waiting?.({ done: true, value: undefined }); this.waiting = undefined; }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.values.length ? Promise.resolve({ done: false, value: this.values.shift()! })
      : this.ended ? Promise.resolve({ done: true, value: undefined }) : new Promise(resolve => { this.waiting = resolve; }) };
  }
}

export class FakeQuery extends Channel<unknown> {
  closed = false; interrupts = 0; models: string[] = [];
  private readonly input: AsyncIterator<SDKUserMessage>;
  constructor(readonly args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) { super(); this.input = args.prompt[Symbol.asyncIterator](); }
  async read(): Promise<SDKUserMessage> { const next = await this.input.next(); if (next.done) throw new Error("Input ended"); return next.value; }
  async interrupt(): Promise<void> { this.interrupts++; }
  async setModel(model: string): Promise<void> { this.models.push(model); }
  close(): void { this.closed = true; this.end(); }
}

export function harness() {
  const queries: FakeQuery[] = [];
  return { queries, query: (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => { const query = new FakeQuery(args); queries.push(query); return query; } };
}

export const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const input = { sessionId: "execution", nativeSessionId: nativeId, cwd: "/fixture/checkout", model: "claude-sonnet-4-6", proxy: { baseUrl: "http://127.0.0.1:1/anthropic", token: "offline-proxy-placeholder" } };
export const text = (text: string) => [{ type: "text" as const, text }];
export const result = (uuid?: string, fields: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", result: "", session_id: nativeId, ...(uuid ? { user_message_uuid: uuid } : {}), ...fields });
export const tick = () => new Promise<void>(resolve => setImmediate(resolve));

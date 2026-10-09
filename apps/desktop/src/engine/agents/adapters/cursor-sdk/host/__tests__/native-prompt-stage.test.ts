import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorHostClient, type HostTransport } from "../host-client";
import type { NativePromptStage } from "../../../../types";

class Transport implements HostTransport {
  requests: Array<{ id: number; op: string; args: Record<string, unknown> }> = [];
  writes: Array<((error?: Error | null) => void) | undefined> = [];
  line?: (line: string) => void;
  exit?: () => void;
  send(line: string, onWrite?: (error?: Error | null) => void) { this.requests.push(JSON.parse(line)); this.writes.push(onWrite); }
  onLine(listener: (line: string) => void) { this.line = listener; }
  onExit(listener: () => void) { this.exit = listener; }
  dispose() {}
  reply(result: unknown, ok = true) { this.line?.(JSON.stringify({ k: "res", id: this.requests.at(-1)!.id, ok,
    ...(ok ? { result } : { error: result }) }) + "\n"); }
}
const clients: CursorHostClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); });
async function setup() {
  const transport = new Transport(), client = new CursorHostClient(() => transport); clients.push(client);
  const creating = client.module().Agent.create({}); transport.reply({ agentId: "native" });
  return { client, transport, agent: await creating };
}

describe("Cursor native prompt stage observation", () => {
  it("routes native delta packets by the original host runId rather than the current warm agent", async () => {
    const f = await setup(), first = vi.fn(), second = vi.fn();
    const sendingFirst = f.agent.send({ text: "First" }, { onDelta: first });
    const firstRunId = f.transport.requests.at(-1)!.args.runId;
    f.transport.reply({ sdkRunId: "native-first" }); const a = await sendingFirst;
    const sendingSecond = f.agent.send({ text: "Second" }, { onDelta: second });
    const secondRunId = f.transport.requests.at(-1)!.args.runId;
    f.transport.reply({ sdkRunId: "native-second" }); const b = await sendingSecond;
    expect(firstRunId).not.toEqual(secondRunId);
    const consume = async (run: typeof a) => { for await (const _item of run.stream()) { /* drain native callbacks */ } };
    const consumed = Promise.all([consume(a), consume(b)]);
    const packet = (runId: unknown, update: unknown) => f.transport.line?.(JSON.stringify({ k: "ev", ev: "run.delta", runId, update }) + "\n");
    packet(firstRunId, { type: "text-delta", text: "Original run" });
    packet(secondRunId, { type: "tool-call-started", callId: "read", toolCall: { type: "read" } });
    for (const runId of [firstRunId, secondRunId]) f.transport.line?.(JSON.stringify({ k: "ev", ev: "run.streamEnd", runId }) + "\n");
    packet(firstRunId, { type: "text-delta", text: "Late old background" });
    await consumed;
    expect(first).toHaveBeenCalledExactlyOnceWith({ update: { type: "text-delta", text: "Original run" } });
    expect(second).toHaveBeenCalledExactlyOnceWith({ update: { type: "tool-call-started", callId: "read", toolCall: { type: "read" } } });
  });
  it("waits for the actual successful write callback and separates SDK run creation from native acceptance", async () => {
    const f = await setup(), observer = vi.fn<(stage: NativePromptStage) => void>();
    const pending = f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer });
    void pending.catch(() => {});
    expect(observer).not.toHaveBeenCalled();
    const wire = f.transport.requests.at(-1)!.args;
    expect(wire.options).not.toHaveProperty("onNativePromptStage");
    const written = f.transport.writes.at(-1);
    expect(written).toBeTypeOf("function");
    written?.();
    expect(observer.mock.calls).toEqual([["native_write"]]);
    f.transport.reply({ sdkRunId: "run" }); await pending;
    expect(observer.mock.calls).toEqual([["native_write"], ["sdk_run_created"]]);
    expect(observer).not.toHaveBeenCalledWith("native_acceptance_ack");
  });

  it("does not report an errored write or rejected SDK start as successful native stages", async () => {
    const f = await setup(), observer = vi.fn();
    const pending = f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer });
    void pending.catch(() => {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "unauthenticated" });
    f.transport.writes.at(-1)?.(new Error("Synthetic broken pipe"));
    f.transport.reply({ message: "Synthetic authentication failure", code: "unauthenticated" }, false);
    await rejected; expect(observer).not.toHaveBeenCalled();
  });

  it("keeps observer exceptions inert and does not serialize callback functions", async () => {
    const f = await setup(), observer = vi.fn(() => { throw new Error("Synthetic observer error"); });
    const pending = f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer });
    void pending.catch(() => {});
    expect(() => f.transport.writes.at(-1)?.()).not.toThrow();
    f.transport.reply({ sdkRunId: "run" });
    await expect(pending).resolves.toMatchObject({ id: "run" });
    expect(observer).toHaveBeenCalledTimes(2);
  });

  it("ignores a delayed old pipe-write callback after host disposal", async () => {
    const f = await setup(), observer = vi.fn();
    const pending = f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer });
    void pending.catch(() => {});
    const written = f.transport.writes.at(-1);
    expect(written).toBeTypeOf("function");
    const rejected = expect(pending).rejects.toThrow("disposed");
    await f.client.dispose(); await rejected;
    written?.(); expect(observer).not.toHaveBeenCalled();
  });
});

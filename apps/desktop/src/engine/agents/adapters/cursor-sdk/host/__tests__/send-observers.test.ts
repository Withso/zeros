import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorHostClient, type HostTransport } from "../host-client";
import type { CursorSdkSendOptions } from "../../adapter";

class Transport implements HostTransport {
  requests: Array<{ id: number; op: string; args: Record<string, unknown> }> = [];
  writes: Array<((error?: Error | null) => void) | undefined> = [];
  onSend?: () => void;
  line?: (line: string) => void;
  send(line: string, onWrite?: (error?: Error | null) => void) { this.onSend?.(); this.requests.push(JSON.parse(line)); this.writes.push(onWrite); }
  onLine(listener: (line: string) => void) { this.line = listener; }
  onExit(_listener: () => void) {}
  dispose() {}
  reply(result: unknown) { this.line?.(JSON.stringify({ k: "res", id: this.requests.at(-1)!.id, ok: true, result }) + "\n"); }
}
const clients: CursorHostClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); });
async function setup() {
  const transport = new Transport(), client = new CursorHostClient(() => transport); clients.push(client);
  const creating = client.module().Agent.create({}); transport.reply({ agentId: "native" });
  return { client, transport, agent: await creating };
}
describe("Cursor host send observers", () => {
  it("registers the summarize run before early summary events and retains its native identity", async () => {
    const f = await setup();
    const pending = f.agent.summarize!();
    const request = f.transport.requests.at(-1)!;
    expect(request.op).toBe("agent.summarize");
    expect(request.args).toMatchObject({ agentId: "native" });
    expect(request.args).not.toHaveProperty("message");
    const summary = { type: "summary", agent_id: "native", run_id: "native-summary", status: "completed" };
    f.transport.line?.(JSON.stringify({ k: "ev", ev: "run.msg", runId: request.args.runId, msg: summary }) + "\n");
    f.transport.reply({ sdkRunId: "native-summary" });
    const run = await pending;
    f.transport.line?.(JSON.stringify({ k: "ev", ev: "run.streamEnd", runId: request.args.runId }) + "\n");
    const items = []; for await (const item of run.stream()) items.push(item);
    expect(run.id).toBe("native-summary"); expect(items).toEqual([summary]);
    const waiting = run.wait(); expect(f.transport.requests.at(-1)!.op).toBe("run.wait");
    f.transport.reply({ status: "finished" }); await waiting;
  });
  it("reports the native write and run creation outside the wire options", async () => {
    const f = await setup(), observer = vi.fn();
    const pending = f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer } satisfies CursorSdkSendOptions);
    expect(f.transport.requests.at(-1)!.args.options).toEqual({});
    expect(observer).not.toHaveBeenCalled(); f.transport.writes.at(-1)?.();
    f.transport.reply({ sdkRunId: "native-run" }); await pending;
    expect(observer.mock.calls).toEqual([["native_write"], ["sdk_run_created"]]);
  });
  it("does not claim a native write when the transport write throws", async () => {
    const f = await setup(), observer = vi.fn();
    f.transport.onSend = () => { throw new Error("Synthetic transport failure"); };
    await expect(f.agent.send({ text: "Synthetic" }, { onNativePromptStage: observer } satisfies CursorSdkSendOptions)).rejects.toThrow("Synthetic transport failure");
    expect(observer).not.toHaveBeenCalled();
  });
  it("sends plain options unchanged", async () => {
    const f = await setup(), pending = f.agent.send({ text: "Synthetic" }, { model: "explicit-model" });
    expect(f.transport.requests.at(-1)!.args.options).toEqual({ model: "explicit-model" });
    f.transport.reply({ sdkRunId: "native-run" }); await pending;
  });
});

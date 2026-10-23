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

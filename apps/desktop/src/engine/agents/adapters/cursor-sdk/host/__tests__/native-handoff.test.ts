import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";
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
describe("Cursor strict original native handoff", () => {
  it("propagates a typed synchronous authority refusal before any native write", async () => {
    const f = await setup(), observer = vi.fn(), cause = new CloudCommandFailureError({ stage: "validation", category: "access_denied" });
    const beforeNativeWrite = vi.fn(() => { throw cause; });
    const pending = f.agent.send({ text: "Synthetic" }, { beforeNativeWrite, onNativePromptStage: observer } satisfies CursorSdkSendOptions);
    void pending.catch(() => {});
    expect(f.transport.requests).toHaveLength(1);
    await expect(pending).rejects.toBe(cause);
    expect(beforeNativeWrite).toHaveBeenCalledOnce(); expect(f.transport.requests).toHaveLength(1); expect(observer).not.toHaveBeenCalled();
  });
  it("runs the conservative handoff synchronously before transport write and excludes it from wire options", async () => {
    const f = await setup(), order: string[] = [], observer = vi.fn();
    const beforeNativeWrite = vi.fn(() => { order.push("assert", "mark"); });
    f.transport.onSend = () => order.push("write");
    const pending = f.agent.send({ text: "Synthetic" }, { beforeNativeWrite, onNativePromptStage: observer } satisfies CursorSdkSendOptions);
    expect(order).toEqual(["assert", "mark", "write"]);
    expect(f.transport.requests.at(-1)!.args.options).not.toHaveProperty("beforeNativeWrite");
    expect(observer).not.toHaveBeenCalled(); f.transport.writes.at(-1)?.();
    f.transport.reply({ sdkRunId: "native-run" }); await pending;
    expect(beforeNativeWrite).toHaveBeenCalledOnce(); expect(observer.mock.calls).toEqual([["native_write"], ["sdk_run_created"]]);
  });
  it("keeps a potentially executed mark when transport write throws, without claiming a successful write", async () => {
    const f = await setup(), order: string[] = [], observer = vi.fn();
    const beforeNativeWrite = () => order.push("mark");
    f.transport.onSend = () => { order.push("write"); throw new Error("Synthetic transport failure"); };
    await expect(f.agent.send({ text: "Synthetic" }, { beforeNativeWrite, onNativePromptStage: observer } satisfies CursorSdkSendOptions)).rejects.toThrow("Synthetic transport failure");
    expect(order).toEqual(["mark", "write"]); expect(observer).not.toHaveBeenCalled();
  });
  it("preserves legacy and both Local paths without a handoff callback", async () => {
    const f = await setup(), pending = f.agent.send({ text: "Synthetic" }, { model: "explicit-model" });
    expect(f.transport.requests.at(-1)!.args.options).toEqual({ model: "explicit-model" });
    f.transport.reply({ sdkRunId: "native-run" }); await pending;
  });
});

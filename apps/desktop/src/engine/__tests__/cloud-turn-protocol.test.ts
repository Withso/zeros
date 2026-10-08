import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CloudNativeResultSchema } from "@zeros/protocol/cloud-commands";
import { ZerosEngine } from "../zeros-engine";
import type { TransportClient } from "../transport/types";

const call = ZerosEngine.prototype as unknown as {
  handleCloudCommandOperation(this: unknown, op: string, params: Record<string, unknown>, client: TransportClient): Promise<unknown>;
};
function fixture(kind: "read" | "snapshot") {
  const commandId = randomUUID();
  const entry = { commandId, position: 1, state: "failed", payload: null, executionId: "execution", generation: 1,
    resultCode: "cloud_provider_prompt_auth_required", createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString(),
    result: { version: 1, model: "model", terminal: { commandId, conversationId: "chat", executionId: "execution", turnId: "turn", agentId: "claude",
      status: "failed", stopReason: null, error: "Authentication required" } } };
  const result = kind === "read" ? { ...entry, conversationId: "chat" } :
    { version: 1, conversationId: "chat", revision: 1, paused: false, pending: [], receipts: [entry] };
  const client: TransportClient = { id: "client", kind: "cloud", send: vi.fn(), close: vi.fn() };
  const engine = { cloudCommands: { handle: vi.fn(async () => result) }, cloudTurnProtocols: new WeakMap<TransportClient, number>() };
  const request = kind === "read" ? { kind, commandId } : { kind, conversationId: "chat" };
  const invoke = (params: Record<string, unknown>) => call.handleCloudCommandOperation.call(engine, "cloudCommands.request", { request, ...params }, client);
  return { client, engine, invoke, result };
}
describe("negotiated cloud turn protocol", () => {
  it.each(["read", "snapshot"] as const)("keeps %s receipts valid for strict native v1 desktops", async kind => {
    const f = fixture(kind);
    const result = await f.invoke({ nativeCommandsVersion: 1 }) as Record<string, any>;
    const native = kind === "read" ? result.result : result.receipts[0].result;
    expect(native).toEqual({ version: 1, model: "model" });
    expect(CloudNativeResultSchema.omit({ terminal: true }).strict().safeParse(native).success).toBe(true);
  });
  it.each(["read", "snapshot"] as const)("retains exact %s terminals only after explicit opt-in", async kind => {
    const f = fixture(kind);
    expect(await f.invoke({ nativeCommandsVersion: 1, cloudTurnProtocolVersion: 1 })).toEqual(f.result);
    expect(f.engine.cloudTurnProtocols.get(f.client)).toBe(1);
    await expect(f.invoke({ cloudTurnProtocolVersion: 2 })).rejects.toMatchObject({ code: "invalid_command" });
  });
  it("preserves the older queue-only result projection", async () => {
    const f = fixture("read");
    expect(await f.invoke({})).not.toHaveProperty("result");
  });
});

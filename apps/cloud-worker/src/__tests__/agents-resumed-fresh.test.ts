// After a restore the worker keeps each chat, but a provider may no longer hold
// its native session. A driver that can tell opens a fresh one; the client is
// told through the existing resumedFresh field, once, so it replays the
// conversation to the new session. No other frame or wording changes.
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { DriverOpen } from "../drivers/driver";
import { CloudWorker } from "../worker";
import { CLIENT_A, WORKSPACE_ID, WORKSPACE_KEY, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

/** A driver whose provider no longer has the requested session on disk. */
class GoneDriver extends FakeDriver {
  async open(input: DriverOpen): Promise<{ nativeSessionId: string; provisional?: boolean; resumedFresh?: true }> {
    await super.open(input);
    return input.nativeSessionId ? { nativeSessionId: `fresh-${input.sessionId}`, provisional: true, resumedFresh: true } : { nativeSessionId: `native-${input.sessionId}` };
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function restored(Driver: typeof FakeDriver) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-resumed-fresh-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const start = async (make: () => FakeDriver) => {
    const relay = new FakeRelay(), drivers: FakeDriver[] = [];
    const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {},
      drivers: { codex: () => { const driver = make(); drivers.push(driver); return driver; } } });
    cleanups.push(() => worker.dispose());
    worker.start(); await relay.receive(config); await relay.receive({ t: "open", clientId: CLIENT_A });
    const request = async (type: string, fields: Record<string, unknown>) => {
      const frame = browserFrame(type, fields); await relay.request(CLIENT_A, frame); return { id: frame.id, reply: relay.response(frame.id) };
    };
    return { worker, relay, drivers, request };
  };
  // A first VM: the chat gets a native session and one turn.
  const first = await start(() => new FakeDriver());
  await first.request("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "codex", title: "Kept", createdAt: 100 } } });
  const created = await first.request("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID });
  const executionId = (created.reply as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>).session.sessionId;
  await first.request("AGENT_PROMPT", { agentId: "codex", chatId: "chat", sessionId: executionId, executionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "first" }] });
  await expect.poll(() => first.drivers[0]?.prompts.length).toBe(1);
  first.drivers[0]!.complete(); await first.worker.flush();
  await first.relay.receive({ t: "close", clientId: CLIENT_A });
  await first.worker.dispose();
  // The restored VM: the worker's own state came back; the provider's may not have.
  const next = await start(() => new Driver());
  const loaded = await next.request("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "chat", sessionId: executionId, executionId, cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID,
    providerBinding: { providerId: "codex", kind: "native", resumeId: `native-${executionId}` } });
  return { next, loaded, executionId };
}

it("tells the client once, on the load reply, when a chat's native session had to start fresh", async () => {
  const { next, loaded, executionId } = await restored(GoneDriver);
  expect(loaded.reply).toMatchObject({ type: "AGENT_SESSION_LOADED", response: { resumedFresh: true } });
  expect(next.drivers[0]!.opened?.nativeSessionId).toBe(`native-${executionId}`);
  // The fresh session binds at its first turn, and that binding update does not ask for the replay again.
  await next.request("AGENT_PROMPT", { agentId: "codex", chatId: "chat", sessionId: (loaded.reply as Extract<BridgeMessage, { type: "AGENT_SESSION_LOADED" }>).sessionId,
    executionId: (loaded.reply as Extract<BridgeMessage, { type: "AGENT_SESSION_LOADED" }>).executionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "after restore" }] });
  await expect.poll(() => next.drivers[0]?.prompts.length).toBe(1);
  next.drivers[0]!.emit({ sessionUpdate: "provider_binding_update", providerBinding: { providerId: "codex", kind: "native", resumeId: `fresh-${executionId}` } } as never);
  next.drivers[0]!.complete(); await next.worker.flush();
  const updates = next.relay.bridge("AGENT_SESSION_UPDATE").map(entry => (entry.frame as Extract<BridgeMessage, { type: "AGENT_SESSION_UPDATE" }>).notification.update)
    .filter(update => update.sessionUpdate === "provider_binding_update");
  expect(updates.length).toBeGreaterThan(0);
  for (const update of updates) expect(update).not.toHaveProperty("resumedFresh");
  expect(next.relay.bridge("AGENT_ERROR")).toEqual([]);
});

it("changes nothing for a chat whose native session is still there", async () => {
  const { next, loaded, executionId } = await restored(FakeDriver);
  expect(loaded.reply?.type).toBe("AGENT_SESSION_LOADED");
  expect((loaded.reply as Extract<BridgeMessage, { type: "AGENT_SESSION_LOADED" }>).response).not.toHaveProperty("resumedFresh");
  expect(next.drivers[0]!.opened?.nativeSessionId).toBe(`native-${executionId}`);
});

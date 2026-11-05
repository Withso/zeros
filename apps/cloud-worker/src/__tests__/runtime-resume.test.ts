import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { CLIENT_A, WORKSPACE_ID, WORKSPACE_KEY, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("resumes the existing execution and provider session after a quiet runtime handoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-resume-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const start = async (instanceId?: string) => {
    const relay = new FakeRelay(), drivers: FakeDriver[] = [];
    const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {},
      ...(instanceId ? { runtimeResume: { instanceId } } : {}),
      drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
    cleanups.push(() => worker.dispose());
    worker.start(); await relay.receive(config); await relay.receive({ t: "open", clientId: CLIENT_A });
    const request = async (type: string, fields: Record<string, unknown>) => {
      const frame = browserFrame(type, fields); await relay.request(CLIENT_A, frame); return { id: frame.id, reply: relay.response(frame.id) };
    };
    return { worker, relay, drivers, request };
  };
  const first = await start();
  await first.request("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "codex", title: "Retained", createdAt: 100 } } });
  const created = await first.request("AGENT_NEW_SESSION", { agentId: "codex", chatId: "chat", cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID });
  expect(created.reply?.type).toBe("AGENT_SESSION_CREATED");
  const executionId = (created.reply as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>).session.sessionId;
  const prompt = { agentId: "codex", chatId: "chat", sessionId: executionId, executionId,
    userMessageId: randomUUID(), prompt: [{ type: "text", text: "first turn" }] };
  await first.request("AGENT_PROMPT", prompt);
  await expect.poll(() => first.drivers[0]?.prompts.length).toBe(1);
  first.drivers[0]!.complete(); await first.worker.flush();
  const nativeSessionId = `native-${executionId}`;
  const instanceId = (first.relay.bridge("ENGINE_READY")[0]!.frame as Extract<BridgeMessage, { type: "ENGINE_READY" }>).instanceId!;
  await first.relay.receive({ t: "close", clientId: CLIENT_A });
  await first.worker.dispose();

  const next = await start(instanceId);
  const loaded = await next.request("AGENT_LOAD_SESSION", { agentId: "codex", chatId: "chat", sessionId: executionId, executionId,
    cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID, adoptOnly: true });
  expect(loaded.reply?.type).toBe("AGENT_SESSION_LOADED");
  expect(next.relay.bridge("ENGINE_READY")[0]!.frame).toMatchObject({ instanceId });
  const sent = await next.request("AGENT_PROMPT", { ...prompt, userMessageId: randomUUID(), prompt: [{ type: "text", text: "after update" }] });
  await expect.poll(() => next.drivers[0]?.prompts.length).toBe(1);
  expect(next.drivers[0]!.opened?.nativeSessionId).toBe(nativeSessionId);
  next.drivers[0]!.complete(); await next.worker.flush();
  expect(next.relay.response(sent.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  const history = await next.request("WORKSPACE_REQUEST", { op: "messages.window", params: { chatId: "chat" } });
  expect(history.reply?.type).toBe("WORKSPACE_RESPONSE");
  expect(JSON.stringify(history.reply)).toContain("after update");
  expect(next.relay.bridge("AGENT_ERROR")).toEqual([]);
});

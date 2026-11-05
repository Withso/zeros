import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { CloudRuntimeUpdateRequest, CloudRuntimeUpdateReply } from "@zeros/protocol/cloud-v2-relay";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { claudeNativeApi } from "../../../../packages/protocol/src/__tests__/fixtures/claude-native-api";
import { ClaudeDriver } from "../drivers/claude/driver";
import { runtimePermit } from "../runtime-permit";
import { CloudWorker } from "../worker";
import { CLIENT_A, WORKSPACE_ID, WORKSPACE_KEY, FakeRelay, browserFrame, config } from "./worker-fixtures";

it.each([false, true])("becomes quiet after a native Claude turn and disconnected client (reconnect=%s)", async reconnect => {
  const fixture = await claudeNativeApi(() => []);
  const directory = await mkdtemp(join(tmpdir(), "zeros-runtime-native-idle-"));
  const root = join(directory, "checkout");
  await mkdir(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--initial-branch=main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(root, "fixture.txt"), "fixture\n"); git("add", "."); git("commit", "-m", "fixture"); git("switch", "-c", "workspace/fixture");
  let clock = 0;
  const request = vi.fn(async (_input: CloudRuntimeUpdateRequest): Promise<CloudRuntimeUpdateReply> => ({ status: "current" }));
  const relay = Object.assign(new FakeRelay(), { runtimeUpdate: request });
  const configuration = { ...config, historyReplacement: 1 as const, agentInteractions: 1 as const, runtimeUpdate: 1 as const,
    codeReview: { userId: "33333333-3333-4333-8333-333333333333" },
    workspace: { ...config.workspace, checkoutPath: root }, agents: { claude: { apiKey: "offline-native-fixture-key" } } };
  const worker = new CloudWorker({ directory: join(directory, "state"), workspaceId: WORKSPACE_ID, transport: relay,
    homeDirectory: join(directory, "home"), runtimeClock: () => clock, runtimePermit: runtimePermit(join(directory, "state"), randomUUID()),
    prepareCheckout: async () => {}, drivers: { claude: () => new ClaudeDriver({ executable: fixture.executable, query: args => query({ ...args, options: {
      ...args.options, env: fixture.env, spawnClaudeCodeProcess: fixture.spawnClaudeCodeProcess, persistSession: false, settingSources: [], strictMcpConfig: true,
    } }) }) } });
  const send = async (type: string, fields: Record<string, unknown>) => {
    const frame = browserFrame(type, fields); await relay.request(CLIENT_A, frame); return frame.id;
  };
  try {
    worker.start(); await relay.receive(configuration); await relay.receive({ t: "open", clientId: CLIENT_A });
    await send("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: { id: "chat", folder: WORKSPACE_KEY, agentId: "claude", title: "Fixture", createdAt: 100 } } });
    const openId = await send("AGENT_NEW_SESSION", { agentId: "claude", chatId: "chat", cwd: WORKSPACE_KEY, workspaceId: WORKSPACE_ID });
    const opened = relay.response(openId) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(opened.type).toBe("AGENT_SESSION_CREATED");
    const promptId = await send("AGENT_PROMPT", { agentId: "claude", chatId: "chat", sessionId: opened.session.sessionId,
      executionId: opened.session.sessionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "Reply ready." }] });
    await expect.poll(() => relay.response(promptId), { timeout: 10_000 }).toMatchObject({ type: "AGENT_PROMPT_COMPLETE" });
    expect(fixture.requests.length).toBeGreaterThan(0);
    await relay.receive({ t: "close", clientId: CLIENT_A });
    if (reconnect) { relay.disconnect(); await relay.reconnect(); await relay.receive(configuration); }
    await expect.poll(() => worker.runtimeCensus, { timeout: 5000 }).toEqual({ clients: false, requests: false, agents: false, terminals: false,
      setup: false, checkout: false, configuration: false, prompts: false, attachments: false, storage: false, tools: false });
    await new Promise(resolve => setTimeout(resolve, 1100)); clock = 31_000;
    await expect.poll(() => request.mock.calls, { timeout: 5000 }).toContainEqual([{ op: "status" }, expect.any(AbortSignal)]);
  } finally { await worker.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_ID, WORKSPACE_KEY, browserFrame, config } from "./worker-fixtures";

const TOKEN = `zw2a_${"T".repeat(20)}fixture${"t".repeat(16)}`;
const api = { url: "https://api.example.test/api/v0", token: TOKEN };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(delivered?: typeof api) {
  const directory = await mkdtemp(join(tmpdir(), "workspace-api-")), root = join(directory, "checkout");
  await mkdir(root);
  const relay = new FakeRelay(), drivers: FakeDriver[] = [], reconfigured = vi.fn();
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, onReconfigure: reconfigured,
    drivers: { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
  cleanups.push(async () => { await worker.dispose(); await rm(directory, { recursive: true, force: true }); });
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root }, ...(delivered ? { api: delivered } : {}) };
  worker.start(); await relay.receive(configuration); await relay.receive({ t: "open", clientId: CLIENT_A });
  const request = async (type: string, fields: Record<string, unknown> = {}) => {
    const frame = browserFrame(type, { agentId: "codex", ...fields });
    await relay.request(CLIENT_A, frame); await worker.flush();
    return relay.response(frame.id)!;
  };
  return { directory, relay, worker, drivers, configuration, request, reconfigured };
}

it("advertises the negotiated feature so only a supporting worker is sent api", () => {
  expect(CLOUD_WORKER_FEATURES.split(",")).toContain("workspace-api-v1");
});

it("gives agents their workspace and chat identity, but no API variables, when the control plane sent no api", async () => {
  const f = await setup();
  await f.request("AGENT_NEW_SESSION", { chatId: "chat-a", cwd: WORKSPACE_KEY });
  await expect.poll(() => f.drivers[0]?.opened).toBeDefined();
  expect(f.drivers[0].opened!.zerosEnvironment).toEqual({ ZEROS_WORKSPACE_ID: WORKSPACE_ID, ZEROS_SESSION_ID: "chat-a" });
});

it("delivers the API base and token to agents and keeps the token out of history and the bridge", async () => {
  const f = await setup(api);
  const created = await f.request("AGENT_NEW_SESSION", { chatId: "chat-a", cwd: WORKSPACE_KEY });
  const sessionId = (created as { session: { sessionId: string } }).session.sessionId;
  const prompt = browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId, userMessageId: "user-1", prompt: [{ type: "text", text: "echo it" }] });
  await f.relay.request(CLIENT_A, prompt);
  await expect.poll(() => f.drivers[0]?.prompts.length).toBe(1);
  expect(f.drivers[0].opened!.zerosEnvironment).toEqual({ ZEROS_WORKSPACE_ID: WORKSPACE_ID, ZEROS_SESSION_ID: "chat-a",
    ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN });
  f.drivers[0].emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `the token is ${TOKEN} and ${JSON.stringify(TOKEN)}` } });
  f.drivers[0].complete();
  await expect.poll(() => f.relay.response(prompt.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
  await f.worker.flush();
  const window = await f.request("WORKSPACE_REQUEST", { op: "messages.window", params: { chatId: "chat-a" } });
  expect(JSON.stringify(window)).toContain("[redacted]");
  expect(JSON.stringify(window)).not.toContain(TOKEN);
  expect(JSON.stringify(f.relay.frames)).not.toContain(TOKEN);
  const sessions = join(f.directory, "sessions");
  for (const name of await readdir(sessions, { recursive: true }).catch(() => [] as string[])) {
    const content = await readFile(join(sessions, name), "utf8").catch(() => "");
    expect(content, name).not.toContain(TOKEN);
  }
});

it("treats a repeated configuration for the same boot as a no-op for the environment and its children", async () => {
  const f = await setup(api);
  await f.request("AGENT_NEW_SESSION", { chatId: "chat-a", cwd: WORKSPACE_KEY });
  await expect.poll(() => f.drivers[0]?.opened).toBeDefined();
  await f.relay.receive({ ...f.configuration }); await f.worker.flush();
  await f.relay.receive({ ...f.configuration, loginRevision: "0" }); await f.worker.flush();
  expect(f.reconfigured).not.toHaveBeenCalled();
  expect(f.drivers).toHaveLength(1);
  expect(f.drivers[0].disposed).toBe(false);
});

import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { CloudV2PromptDelivery } from "@zeros/protocol/cloud-v2-prompts";
import { CloudWorker } from "../worker";
import type { Agents } from "../agents";
import type { SessionStore } from "../sessions/session-store";
import { CLOUD_WORKER_FEATURES } from "../worker-features";
import { CLIENT_A, FakeDriver, FakeRelay, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const f = await repositoryFixture(), relay = new FakeRelay();
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport: relay, prepareCheckout: async () => {},
    workspaceServices: { watch: false }, drivers: { codex: () => new FakeDriver() } });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, workspace: f.scope.workspace });
  await relay.receive({ t: "open", clientId: CLIENT_A });
  const { agents, store } = worker as unknown as { agents: Agents; store: SessionStore };
  const deliver = (chatId: string, sessionName?: string, deliveryId = randomUUID(), userMessageId = `user-${chatId}`): Promise<unknown> => agents.receiveOutbox({ deliveryId,
    receipt: { workspaceId: WORKSPACE_ID, chatId, userMessageId, epoch: "1", sequence: "1", acceptedAt: new Date(0).toISOString(), workspaceState: "running" },
    payload: { chatId, userMessageId, agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Hello" }] },
    ...(sessionName === undefined ? {} : { sessionName }) } as CloudV2PromptDelivery);
  const title = (chatId: string) => store.metadata(chatId)?.chat?.title;
  return { f, relay, worker, agents, store, deliver, title };
}

it("advertises session-name-v1 so only a supporting worker is sent a session name", () => {
  expect(CLOUD_WORKER_FEATURES.split(",")).toContain("session-name-v1");
});

it("titles a chat that its first delivery creates, trimmed", async () => {
  const s = await setup();
  await s.deliver("api-chat", "  Fix the login flow  ");
  expect(s.title("api-chat")).toBe("Fix the login flow");
  const untitled = await setup();
  await untitled.deliver("plain-chat");
  expect(untitled.title("plain-chat")).toBe("");
});

it("never renames an existing chat, and a replayed delivery changes nothing", async () => {
  const s = await setup();
  await s.relay.request(CLIENT_A, browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "desktop-chat", cwd: s.f.scope.key }));
  await s.worker.flush();
  await s.deliver("desktop-chat", "From the API");
  expect(s.title("desktop-chat")).toBe("");
  const deliveryId = randomUUID();
  await s.deliver("api-chat", "First name", deliveryId);
  await s.deliver("api-chat", "Second name", deliveryId);
  await s.deliver("api-chat", "Third name", randomUUID(), "user-later");
  expect(s.title("api-chat")).toBe("First name");
});

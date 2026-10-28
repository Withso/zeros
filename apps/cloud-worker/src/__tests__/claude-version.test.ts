import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { CLAUDE_VERSION } from "../drivers/claude/driver";
import { CloudWorker } from "../worker";
import { CLIENT_A, FakeRelay, browserFrame, config } from "./worker-fixtures";

const require = createRequire(import.meta.url);
const pin = require("../../package.json").dependencies["@anthropic-ai/claude-agent-sdk"] as string;

it("keeps the Claude launcher pin aligned with the installed SDK and native package", () => {
  const sdk = require.resolve("@anthropic-ai/claude-agent-sdk");
  const native = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
  expect(CLAUDE_VERSION).toBe(pin);
  expect(require(join(dirname(sdk), "package.json")).version).toBe(pin);
  expect(require(join(dirname(native), "package.json")).version).toBe(pin);
});

it("advertises the packaged Claude version through worker initialization and listing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-version-"));
  const relay = new FakeRelay();
  const worker = new CloudWorker({ directory, transport: relay, prepareCheckout: async () => {}, drivers: {} });
  try {
    worker.start();
    await relay.receive({ ...config, agents: {} });
    await relay.receive({ t: "open", clientId: CLIENT_A });
    const initialize = browserFrame("AGENT_INIT_AGENT", { agentId: "claude" });
    await relay.request(CLIENT_A, initialize);
    expect(relay.response(initialize.id)).toMatchObject({ type: "AGENT_AGENT_INITIALIZED",
      initialize: { agentInfo: { name: "Claude", version: pin } } });
    const list = browserFrame("AGENT_LIST_AGENTS", {});
    await relay.request(CLIENT_A, list);
    expect(relay.response(list.id)).toMatchObject({ type: "AGENT_AGENTS_LIST",
      agents: expect.arrayContaining([expect.objectContaining({ id: "claude", version: pin, installedVersion: pin })]) });
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

import { expect, it } from "vitest";
import * as shared from "@zeros/protocol/cloud-v2-relay";
// Test-only: the control plane deploys independently and mirrors Zod 4 in Zod 3.
import * as control from "../../../control-plane/src/cloud/contract";
import * as sharedPrompts from "@zeros/protocol/cloud-v2-prompts";
import * as controlPrompts from "../../../control-plane/src/cloud/prompt-contract";
import { CLIENT_A, WORKSPACE_ID, config } from "./worker-fixtures";

it("keeps the standalone control-plane constants identical to the worker contract", () => {
  for (const name of ["CLOUD_V2_RELAY_PROTOCOL", "CLOUD_V2_WORKER_PORT", "CLOUD_V2_WORKER_BRIDGE_PATH", "CLOUD_V2_WORKER_BRIDGE_PROTOCOL", "CLOUD_V2_MAX_FRAME_BYTES", "CLOUD_V2_MAX_HISTORY_ROWS"] as const)
    expect(control[name]).toBe(shared[name]);
});

const history = { t: "history", messages: { chatId: "native-chat", rows: [{ msgId: "native-row", kind: "user", payload: "{}", createdAt: 1 }] } };
const cases = {
  CloudV2WorkerFrameSchema: [
    { t: "hello", protocol: 2, workerVersion: "fixture", capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex", "claude", "cursor"] } },
    { t: "frame", clientId: "*", frame: { type: "DB_CHANGED" } }, history,
    { t: "idle", idle: true }, { t: "request", id: CLIENT_A, kind: "github-token" }, { t: "stop-ack", id: CLIENT_A },
  ],
  CloudV2ControlFrameSchema: [config, { ...config, promptOutbox: 1 }, { t: "prompts" }, { t: "open", clientId: CLIENT_A }, { t: "close", clientId: CLIENT_A },
    { t: "frame", clientId: CLIENT_A, frame: { type: "AGENT_CANCEL" } }, { t: "stop", id: CLIENT_A },
    { t: "reply", id: CLIENT_A, token: "synthetic-github-token", expiresAt: 1 }, { t: "refusal", id: CLIENT_A, code: "unavailable" }],
  CloudV2WorkerHelloSchema: [{ protocol: 2, bootId: WORKSPACE_ID, runtimeSha256: "a".repeat(64) }],
  CloudV2WorkerHistorySchema: [{ ...history, bootId: WORKSPACE_ID, sequence: 1 }],
  CloudV2WorkerActivitySchema: [{ idle: false }],
  CloudV2WorkerActivityReplySchema: [{ loginRevision: "3", state: "running" }],
  CloudV2WorkerTimingSchema: [{ phase: "worker_checkout", durationMs: 42 }],
  RuntimeMcpServerSchema: [
    { id: WORKSPACE_ID, name: "fixture", transport: "stdio", command: "tool", args: ["literal arg"], cwd: "~", env: { KEY: "fixture" }, listen_url: "http://127.0.0.1:3333/mcp" },
    { id: WORKSPACE_ID, name: "fixture", transport: "http", url: "https://example.test/mcp", headers: { "X-Key": "fixture" }, auth: "oauth", disabled_tools: ["blocked"] },
    { id: WORKSPACE_ID, name: "fixture", transport: "sse", url: "https://example.test/sse" },
  ],
} as const;

it.each(Object.keys(cases) as Array<keyof typeof cases>)("keeps %s acceptance and strictness in sync", name => {
  for (const value of cases[name]) {
    expect(shared[name].safeParse(value).success).toBe(true);
    expect(control[name].parse(value)).toEqual(shared[name].parse(value));
    for (const invalid of [null, {}, { ...value, unrelated: true }]) {
      expect(shared[name].safeParse(invalid).success).toBe(false);
      expect(control[name].safeParse(invalid).success).toBe(false);
    }
  }
});

it("keeps optional MCP capability/config bounds identical and rejects secret-bearing extension fields", () => {
  const server = cases.RuntimeMcpServerSchema[1];
  const capabilities = cases.CloudV2WorkerFrameSchema[0].capabilities;
  for (const contract of [shared, control]) {
    expect(contract.CloudV2WorkerFrameSchema.safeParse({ ...cases.CloudV2WorkerFrameSchema[0], capabilities: { ...capabilities, mcp: 1 } }).success).toBe(true);
    expect(contract.CloudV2WorkerFrameSchema.safeParse({ ...cases.CloudV2WorkerFrameSchema[0], capabilities: { ...capabilities, mcp: 2 } }).success).toBe(false);
    expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, mcpServers: cases.RuntimeMcpServerSchema }).success).toBe(true);
    expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, mcpServers: Array.from({ length: 129 }, () => server) }).success).toBe(false);
    for (const patch of [{ name: "x".repeat(129) }, { id: "11111111-1111-9111-1111-111111111111" }, { refresh_token: "forbidden" },
      { headers: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`KEY_${i}`, "fixture"])) }, { headers: { KEY: "x".repeat(16385) } }])
      expect(contract.RuntimeMcpServerSchema.safeParse({ ...server, ...patch }).success).toBe(false);
  }
});

it("rejects stale protocol, malformed revisions and oversized or unordered history inputs on both sides", () => {
  for (const contract of [shared, control]) {
    expect(contract.CloudV2WorkerHelloSchema.safeParse({ ...cases.CloudV2WorkerHelloSchema[0], protocol: 1 }).success).toBe(false);
    for (const loginRevision of ["-1", "01", "", 1])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, loginRevision }).success).toBe(false);
    for (const sequence of [-1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(contract.CloudV2WorkerHistorySchema.safeParse({ ...cases.CloudV2WorkerHistorySchema[0], sequence }).success).toBe(false);
    expect(contract.CloudV2WorkerHistorySchema.safeParse({ ...cases.CloudV2WorkerHistorySchema[0],
      messages: { ...history.messages, rows: Array.from({ length: 501 }, () => history.messages.rows[0]) } }).success).toBe(false);
  }
});

it("keeps optional workspace setup and its bounds identical on both config schemas", () => {
  for (const contract of [shared, control]) {
    for (const setup of [undefined, "", "pnpm install", "x".repeat(8000)])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, workspace: { ...config.workspace, setup } }).success).toBe(true);
    for (const setup of ["x".repeat(8001), null, 1])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, workspace: { ...config.workspace, setup } }).success).toBe(false);
  }
});

it("keeps the optional checkout-v2 base commit identical on both config schemas", () => {
  for (const contract of [shared, control]) {
    for (const baseCommit of [undefined, "a".repeat(40)])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, workspace: { ...config.workspace, baseCommit } }).success).toBe(true);
    for (const baseCommit of ["", "a".repeat(39), "a".repeat(41), "A".repeat(40), "g".repeat(40), "main", null, 1])
      expect(contract.CloudV2ControlFrameSchema.safeParse({ ...config, workspace: { ...config.workspace, baseCommit } }).success).toBe(false);
  }
});

it("keeps durable HTTP prompt bounds and strict schemas identical across Zod versions", () => {
  const payload = { chatId: "chat", userMessageId: CLIENT_A, agentId: "codex", model: "gpt-6-luna", effort: "low",
    prompt: [{ type: "text", text: "ok" }], startedAt: 1 };
  const receipt = { workspaceId: WORKSPACE_ID, chatId: "chat", userMessageId: CLIENT_A,
    sequence: "1", epoch: "0", workspaceState: "running", acceptedAt: new Date(0).toISOString() };
  const examples = {
    CloudV2PromptSchema: payload,
    CloudV2PromptReceiptSchema: receipt,
    CloudV2PromptPullSchema: { waitMs: 25_000, held: [CLIENT_A] },
    CloudV2PromptPullReplySchema: { prompts: [{ payload, receipt, deliveryId: CLIENT_A }], stops: [] },
    CloudV2PromptBeginSchema: { userMessageId: CLIENT_A, deliveryId: CLIENT_A, dispatchId: WORKSPACE_ID },
    CloudV2PromptOutcomeSchema: { userMessageId: CLIENT_A, dispatchId: WORKSPACE_ID, state: "completed" },
    CloudV2PromptStopSchema: { chatId: "chat", throughEpoch: "1" },
  };
  expect(controlPrompts.CLOUD_V2_MAX_PROMPT_BYTES).toBe(sharedPrompts.CLOUD_V2_MAX_PROMPT_BYTES);
  for (const key of Object.keys(examples) as Array<keyof typeof examples>) {
    expect(controlPrompts[key].parse(examples[key])).toEqual(sharedPrompts[key].parse(examples[key]));
    for (const invalid of [null, {}, { ...examples[key], unknown: true }]) {
      expect(controlPrompts[key].safeParse(invalid).success).toBe(false);
      expect(sharedPrompts[key].safeParse(invalid).success).toBe(false);
    }
  }
  for (const schemas of [controlPrompts, sharedPrompts]) {
    expect(schemas.CloudV2PromptSchema.safeParse({ ...payload, chatId: "cloud:foreign" }).success).toBe(false);
    expect(schemas.CloudV2PromptPullSchema.safeParse({ waitMs: 25_001 }).success).toBe(false);
    expect(schemas.CloudV2PromptOutcomeSchema.safeParse({ userMessageId: CLIENT_A, deliveryId: CLIENT_A, state: "accepted" }).success).toBe(false);
  }
});

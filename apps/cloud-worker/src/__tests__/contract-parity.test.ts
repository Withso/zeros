import { expect, it } from "vitest";
import * as shared from "@zeros/protocol/cloud-v2-relay";
// Test-only: the control plane deploys independently and mirrors Zod 4 in Zod 3.
import * as control from "../../../control-plane/src/cloud/contract";
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
  CloudV2ControlFrameSchema: [config, { t: "open", clientId: CLIENT_A }, { t: "close", clientId: CLIENT_A },
    { t: "frame", clientId: CLIENT_A, frame: { type: "AGENT_CANCEL" } }, { t: "stop", id: CLIENT_A },
    { t: "reply", id: CLIENT_A, token: "synthetic-github-token", expiresAt: 1 }, { t: "refusal", id: CLIENT_A, code: "unavailable" }],
  CloudV2WorkerHelloSchema: [{ protocol: 2, bootId: WORKSPACE_ID, runtimeSha256: "a".repeat(64) }],
  CloudV2WorkerHistorySchema: [{ ...history, bootId: WORKSPACE_ID, sequence: 1 }],
  CloudV2WorkerActivitySchema: [{ idle: false }],
  CloudV2WorkerActivityReplySchema: [{ loginRevision: "3", state: "running" }],
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

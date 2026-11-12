import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as mirrored from "../contract.js";

const root = new URL(process.env.CLOUD_EXECUTION_TEST_CLIENT_ROOT ?? "../../../../../", import.meta.url);
type Parser = { safeParse(value: unknown): { success: boolean; data?: unknown } };
describe("acting-user standalone protocol parity", () => {
  let protocol: Record<string, Parser>;
  beforeAll(async () => { protocol = await import(new URL("packages/protocol/src/cloud-v2-relay.ts", root).href); });
  const uuid = randomUUID(), other = randomUUID();
  const actor = { userId: uuid, generation: "1", userMessageId: "message" };
  const base = { contextId: uuid, userId: other, expiresAt: 42, gitIdentity: null };
  const matrices: Array<[string, unknown[]]> = [
    ["CloudV2GenerationSchema", ["1", "9223372036854775806", "9223372036854775807", "0", "01", "-1", "not-a-number", "1e3", " 1", 1]],
    ["CloudV2ContextReasonSchema", ["cancelled", "completed", "access_revoked", "worker_changed", "unavailable", "expired"]],
    ["CloudV2ActorSchema", [actor, { ...actor, generation: 1 }, { ...actor, contextId: uuid }, { ...actor, userMessageId: "cloud:bad" }]],
    ["CloudV2BeginLegacyReplySchema", [{ dispatch: false, state: "completed" }, { dispatch: true, state: "dispatching" }, { dispatch: false, state: "cancelled", actingUser: actor }]],
    ["CloudV2BeginActiveReplySchema", [
      { dispatch: true, state: "dispatching", actingUser: actor, contextId: uuid, mode: "prompt" },
      { dispatch: true, state: "dispatching", actingUser: actor, contextId: uuid, parentContextId: uuid, mode: "steer" },
      { dispatch: true, state: "dispatching", actingUser: actor, contextId: uuid, parentContextId: other, mode: "steer" },
      { dispatch: true, state: "dispatching", actingUser: actor, contextId: uuid, parentContextId: uuid, mode: "prompt" },
    ]],
    ["CloudV2TurnLeaseRequestSchema", [
      { chatId: "chat", userMessageId: "message", dispatchId: uuid, contextId: other, generation: "1" },
      { chatId: "chat", userMessageId: "message", dispatchId: uuid, contextId: other, generation: "0" },
      { chatId: "chat", userMessageId: "message", dispatchId: uuid, contextId: other, generation: "1", userId: uuid },
    ]],
    ["CloudV2TurnLeaseSchema", [
      { ...base, generation: "1", agents: { claude: { apiKey: "synthetic-credential" } } },
      { ...base, generation: "1", agents: { claude: { apiKey: "synthetic-credential" }, cursor: { apiKey: "synthetic-credential" } } },
      { ...base, generation: "1", agents: {} }, { ...base, generation: 1, agents: {} },
    ]],
    ["CloudV2TerminalLeaseRequestSchema", [{ clientId: uuid, terminalId: "terminal", requestId: "request" }, { clientId: uuid, terminalId: "terminal", requestId: "request", userId: other }]],
    ["CloudV2TerminalLeaseSchema", [base, { ...base, environment: { variables: {}, files: [] } }, { ...base, agents: {} }]],
    ["CloudV2ClientLeaseRequestSchema", mirrored.CLOUD_V2_CLIENT_OPERATIONS.map(operation => ({ clientId: uuid, requestId: "request", operation })).concat([{ clientId: uuid, requestId: "request", operation: "git.fake" as any }])],
    ["CloudV2ClientLeaseSchema", [base, { ...base, environment: {} }]],
    ["CloudV2BootstrapLeaseRequestSchema", [{ contextId: uuid }, { contextId: uuid, userId: other }]],
    ["CloudV2BootstrapLeaseSchema", [base, { ...base, api: { url: "https://api.example.test", token: `zw2x_${"a".repeat(43)}` } }]],
    ["CloudV2RenewRequestSchema", [{ contextIds: [uuid] }, { contextIds: [uuid, uuid] }, { contextIds: [] }, { contextIds: Array.from({ length: 129 }, () => randomUUID()) }]],
    ["CloudV2RenewReplySchema", [{ leases: [{ contextId: uuid, expiresAt: 123 }] }, { leases: [{ contextId: uuid, refused: "cancelled" }] }, { leases: [{ contextId: uuid, expiresAt: 123, refused: "cancelled" }] }]],
    ["CloudV2RetiredRequestSchema", [{ retirementId: uuid, reason: "outcome", processes: 0 }, { retirementId: uuid, reason: "revoked", processes: 2147483647 }, { retirementId: uuid, reason: "stop", processes: -1 }]],
    ["CloudV2RetiredReplySchema", [{ retired: true }, { retired: false }, { retired: 1 }]],
    ["CloudV2BootCleanRequestSchema", [
      { retirementId: uuid, processes: 0 }, { retirementId: uuid, processes: 2147483647 },
      ...["none", "removed", "refused", "unknown", null, true].map(legacyMaterial => ({ retirementId: uuid, processes: 0, legacyMaterial })),
      { retirementId: uuid, processes: 2147483648 }, { retirementId: uuid, processes: 0, bootId: other },
    ]],
    ["CloudV2BootCleanReplySchema", [{ retired: 0 }, { retired: 128 }, { retired: -1 }, { retired: true }]],
  ];
  it.each(matrices)("keeps %s identical on accepted, rejected and strict extra-field inputs", (name, values) => {
    const cp = (mirrored as unknown as Record<string, Parser>)[name];
    expect(cp, name).toBeDefined(); expect(protocol[name], name).toBeDefined();
    for (const value of values) {
      const actual = cp!.safeParse(value), expected = protocol[name]!.safeParse(value);
      expect(actual.success, `${name}: ${JSON.stringify(value)}`).toBe(expected.success);
      if (actual.success) expect(actual.data).toEqual(expected.data);
    }
  });
});

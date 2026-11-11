import { describe, expect, it } from "vitest";
import { CloudV2PromptDeliverySchema } from "../cloud-v2-prompts";
import { ACTING_USER_FEATURE, CLOUD_V2_CLIENT_OPERATIONS, CloudV2BeginActiveReplySchema, CloudV2BeginLegacyReplySchema, CloudV2ControlFrameSchema,
  CloudV2GenerationSchema, CloudV2RenewReplySchema, CloudV2RenewRequestSchema, CloudV2RetiredRequestSchema, CloudV2TurnLeaseSchema } from "../cloud-v2-relay";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";

describe("team sharing slice B shapes", () => {
  it("names the feature and keeps generation a bounded decimal string", () => {
    expect(ACTING_USER_FEATURE).toBe("acting-user-v1");
    for (const ok of ["1", "42", "9223372036854775806"]) expect(CloudV2GenerationSchema.safeParse(ok).success, ok).toBe(true);
    // Invalid input never throws (a 400, not a crash): the range check runs only on a decimal.
    for (const bad of ["0", "01", "9223372036854775807", 1, "-1", "not-a-number", "1e3", " 1"]) expect(CloudV2GenerationSchema.safeParse(bad).success, String(bad)).toBe(false);
  });

  it("reads the legacy begin reply unchanged, and an activated one only with its actor, context and a coherent mode", () => {
    expect(CloudV2BeginLegacyReplySchema.parse({ state: "dispatching", dispatch: true })).toEqual({ state: "dispatching", dispatch: true });
    const active = { dispatch: true, state: "dispatching", actingUser: { userId: A, generation: "3", userMessageId: "m1" }, contextId: B, mode: "prompt" };
    expect(CloudV2BeginActiveReplySchema.safeParse(active).success).toBe(true);
    expect(CloudV2BeginActiveReplySchema.safeParse({ ...active, mode: "steer", parentContextId: B }).success).toBe(true);
    expect(CloudV2BeginActiveReplySchema.safeParse({ ...active, mode: "steer" }).success).toBe(false);
    expect(CloudV2BeginActiveReplySchema.safeParse({ ...active, parentContextId: B }).success).toBe(false);
    expect(CloudV2BeginActiveReplySchema.safeParse({ ...active, dispatch: false }).success).toBe(false);
  });

  it("allows exactly one agent in a turn lease and only context API tokens", () => {
    const lease = { contextId: B, userId: A, generation: "3", expiresAt: 1_700_000_030_000, agents: { claude: { apiKey: "k".repeat(20) } }, gitIdentity: null,
      api: { url: "https://api.example.test", token: `zw2x_${"a".repeat(43)}` } };
    expect(CloudV2TurnLeaseSchema.safeParse(lease).success).toBe(true);
    expect(CloudV2TurnLeaseSchema.safeParse({ ...lease, agents: {} }).success).toBe(false);
    expect(CloudV2TurnLeaseSchema.safeParse({ ...lease, agents: { ...lease.agents, cursor: { apiKey: "c" } } }).success).toBe(false);
    expect(CloudV2TurnLeaseSchema.safeParse({ ...lease, api: { ...lease.api, token: `zw2a_${"a".repeat(43)}` } }).success).toBe(false);
  });

  it("renews unique ids, answers each once (an expiry or a refusal), and retires with a process count", () => {
    expect(CloudV2RenewRequestSchema.safeParse({ contextIds: [A, A] }).success).toBe(false);
    expect(CloudV2RenewReplySchema.parse({ leases: [{ contextId: A, expiresAt: 1 }, { contextId: B, refused: "access_revoked" }] }).leases).toHaveLength(2);
    expect(CloudV2RenewReplySchema.safeParse({ leases: [{ contextId: A, refused: "nope" }] }).success).toBe(false);
    expect(CloudV2RetiredRequestSchema.safeParse({ retirementId: A, reason: "outcome", processes: 0 }).success).toBe(true);
    expect(CloudV2RetiredRequestSchema.safeParse({ retirementId: A, reason: "outcome", processes: -1 }).success).toBe(false);
  });

  it("carries revoke-context and the CP-authored open identity, and lists the real client mutations", () => {
    expect(CloudV2ControlFrameSchema.safeParse({ t: "revoke-context", contextId: A, reason: "access_revoked" }).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ t: "open", clientId: A, userId: B, contextId: A }).success).toBe(true);
    expect(CloudV2ControlFrameSchema.safeParse({ t: "open", clientId: A }).success).toBe(true);
    expect(CLOUD_V2_CLIENT_OPERATIONS).toContain("git.push");
    expect(CLOUD_V2_CLIENT_OPERATIONS).not.toContain("git.status");
  });

  it("lets an activated pull name the sender, as an optional uuid", () => {
    expect(CloudV2PromptDeliverySchema.shape.senderUserId.safeParse(undefined).success).toBe(true);
    expect(CloudV2PromptDeliverySchema.shape.senderUserId.safeParse(A).success).toBe(true);
    expect(CloudV2PromptDeliverySchema.shape.senderUserId.safeParse("x").success).toBe(false);
  });
});

it("boot-clean carries only a receipt id and the survivors' count (§7a)", async () => {
  const { CloudV2BootCleanRequestSchema, CloudV2BootCleanReplySchema } = await import("../cloud-v2-relay");
  const retirementId = "66666666-6666-4666-8666-666666666666";
  expect(CloudV2BootCleanRequestSchema.parse({ retirementId, processes: 0 })).toEqual({ retirementId, processes: 0 });
  expect(CloudV2BootCleanRequestSchema.safeParse({ retirementId, processes: 0, bootId: retirementId }).success).toBe(false);
  expect(CloudV2BootCleanRequestSchema.safeParse({ retirementId, processes: -1 }).success).toBe(false);
  expect(CloudV2BootCleanReplySchema.parse({ retired: 3 })).toEqual({ retired: 3 });
  expect(CloudV2BootCleanReplySchema.safeParse({ retired: -1 }).success).toBe(false);
});

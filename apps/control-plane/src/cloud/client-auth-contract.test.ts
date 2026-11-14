import { describe, expect, it } from "vitest";
import { CloudConnectionAuthSchema, CloudConnectionHoldFrameSchema, CloudConnectionResumedFrameSchema, CloudConnectionRenewSchema, CloudConnectionRenewedSchema, clientAuthenticationSchedule } from "./client-auth-contract.js";
import { CloudV2ControlFrameSchema } from "./contract.js";

const id = "11111111-1111-4111-8111-111111111111";
it("keeps negotiated carrier notices and opens strict on both protocol boundaries", async () => {
  const protocol = await import(new URL("../../../../packages/protocol/src/cloud-v2-relay.ts", import.meta.url).href);
  const parity = (local: { safeParse(value: unknown): { success: boolean; data?: unknown } }, remote: typeof local, value: unknown, accepted: boolean) => {
    const left = local.safeParse(value), right = remote.safeParse(value);
    expect(left.success).toBe(accepted);
    expect(right.success).toBe(accepted);
    if (accepted) expect(left.data).toEqual(right.data);
  };
  for (const remainingMs of [0, 1, 12_000, 20_000, 20_001, 1.5, "1000"])
    parity(CloudConnectionHoldFrameSchema, protocol.CloudConnectionHoldFrameSchema,
      { type: "CLOUD_CONNECTION_HOLD", remainingMs }, Number.isInteger(remainingMs) && Number(remainingMs) >= 1 && Number(remainingMs) <= 20_000);
  parity(CloudConnectionHoldFrameSchema, protocol.CloudConnectionHoldFrameSchema,
    { type: "CLOUD_CONNECTION_HOLD", remainingMs: 1, until: 123 }, false);
  parity(CloudConnectionResumedFrameSchema, protocol.CloudConnectionResumedFrameSchema, { type: "CLOUD_CONNECTION_RESUMED" }, true);
  parity(CloudConnectionResumedFrameSchema, protocol.CloudConnectionResumedFrameSchema, { type: "CLOUD_CONNECTION_RESUMED", remainingMs: 1 }, false);
  const open = { t: "open", clientId: id, userId: id, contextId: id };
  parity(CloudV2ControlFrameSchema, protocol.CloudV2ControlFrameSchema, open, true);
  for (const carrierHold of [true, false, 1, "true"])
    parity(CloudV2ControlFrameSchema, protocol.CloudV2ControlFrameSchema, { ...open, carrierHold }, carrierHold === true);
});

describe("client authentication rollover wire", () => {
  it("keeps the absolute deadline and schedules refresh and retry before it", () => {
    const schedule = clientAuthenticationSchedule(301_000, 1000);
    expect(schedule).toEqual({ expiresAt: 301_000, refreshAt: 181_000, retryUntil: 271_000 });
    expect(CloudConnectionAuthSchema.parse({ type: "CLOUD_CONNECTION_AUTH", ...schedule })).toMatchObject(schedule);
    expect(CloudConnectionRenewedSchema.parse({ type: "CLOUD_CONNECTION_RENEWED", requestId: id, ...schedule })).toMatchObject(schedule);
  });
  it("accepts only a bounded single-use ticket request and closed refusal", () => {
    const request = { type: "CLOUD_CONNECTION_RENEW", id, ticket: `zw2c_${"a".repeat(43)}` };
    expect(CloudConnectionRenewSchema.safeParse(request).success).toBe(true);
    for (const change of [{ id: "other" }, { userId: id }, { ticket: "Bearer private" }, { ticket: `zw2c_${"a".repeat(44)}` }])
      expect(CloudConnectionRenewSchema.safeParse({ ...request, ...change }).success).toBe(false);
    for (const code of ["invalid_ticket", "binding_changed", "token_not_advanced", "temporarily_unavailable"])
      expect(CloudConnectionRenewedSchema.safeParse({ type: "CLOUD_CONNECTION_RENEWED", requestId: id, error: { code } }).success).toBe(true);
    expect(CloudConnectionRenewedSchema.safeParse({ type: "CLOUD_CONNECTION_RENEWED", requestId: id, error: { code: "raw-provider-message" } }).success).toBe(false);
  });
});

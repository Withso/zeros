import { describe, expect, it } from "vitest";
import { CloudConnectionAuthSchema, CloudConnectionRenewSchema, CloudConnectionRenewedSchema, clientAuthenticationSchedule } from "./client-auth-contract.js";

const id = "11111111-1111-4111-8111-111111111111";
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

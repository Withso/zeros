import { z } from "zod";

export const CLOUD_CLIENT_ROLLOVER_FEATURE = "client-token-rollover-v1";
export const CLOUD_CLIENT_ROLLOVER_PROTOCOL = `zeros.cloud.v2.${CLOUD_CLIENT_ROLLOVER_FEATURE}`;
const time = z.number().int().positive().safe();
const schedule = { expiresAt: time, refreshAt: time, retryUntil: time };
export const CloudConnectionRenewSchema = z.object({ type: z.literal("CLOUD_CONNECTION_RENEW"), id: z.uuid(),
  ticket: z.string().regex(/^zw2c_[A-Za-z0-9_-]{43}$/) }).strict();
export const CloudConnectionAuthSchema = z.object({ type: z.literal("CLOUD_CONNECTION_AUTH"), ...schedule }).strict();
export const CloudConnectionRenewedSchema = z.union([
  z.object({ type: z.literal("CLOUD_CONNECTION_RENEWED"), requestId: z.uuid(), ...schedule }).strict(),
  z.object({ type: z.literal("CLOUD_CONNECTION_RENEWED"), requestId: z.uuid(), error: z.object({
    code: z.enum(["invalid_ticket", "binding_changed", "token_not_advanced", "temporarily_unavailable"]),
  }).strict() }).strict(),
]);
export function clientAuthenticationSchedule(expiresAt: number, now = Date.now()) {
  return { expiresAt, refreshAt: Math.floor(now + (expiresAt - now) * 0.6), retryUntil: Math.floor(now + (expiresAt - now) * 0.9) };
}

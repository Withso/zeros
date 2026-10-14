import { z } from "zod";

const delay = z.number().int().min(1000).max(300_000).multipleOf(1000);
const failure = z.object({ status: z.literal(503), code: z.literal("cloud_runtime_temporarily_unavailable"),
  phase: z.literal("provider_endpoint"), retryAfterMs: delay }).strict();
/** One shared-client admission call. Sequence distinguishes later refreshes;
 * these are executed retries, not scheduled sleeps or lifecycle attempts. */
export const AdmissionObservationSchema = z.object({
  sequence: z.number().int().positive().safe(), firstFailure: failure,
  retryCount: z.number().int().min(0).max(2),
  retries: z.array(failure.extend({ attempt: z.union([z.literal(2), z.literal(3)]), delayMs: delay }).strict()).max(2),
}).strict().refine(value => value.retryCount === value.retries.length && value.retries.every((retry, index) =>
  retry.attempt === index + 2 && retry.delayMs === retry.retryAfterMs));
export type AdmissionObservation = z.infer<typeof AdmissionObservationSchema>;

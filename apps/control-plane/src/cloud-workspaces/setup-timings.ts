import { randomUUID } from "node:crypto";
import { z } from "zod";

// Mirror the shipped helper contract and additive database constraint. These
// labels describe observations, never authority or readiness evidence.
export const setupTimingSources = ["control_plane", "boat_transport", "setup", "attester_preflight", "attester_launch"] as const;
export const setupTimingStages = ["admission", "provider_command", "admission_revoke", "bootstrap_probe", "ssh_transport", "supervisor",
  "template_verify", "image_preflight", "repository", "credential_projection", "image_launch", "engine_launch", "engine_readiness",
  "lock", "verify_tree", "qualify_engine", "run_setup", "publish_proof"] as const;
const offset = z.number().int().min(0).max(3_600_000);
const span = z.object({ stage: z.enum(setupTimingStages), startMs: offset, endMs: offset,
  outcome: z.enum(["passed", "failed", "cancelled"]) }).strict().refine(value => value.endMs >= value.startMs);
const clock = z.object({ source: z.enum(setupTimingSources), clockId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), startedAt: z.string().datetime({ precision: 3 }).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
  spans: z.array(span).max(32) }).strict();
export const setupTimingsSchema = z.object({ version: z.literal(1), clocks: z.array(clock).max(5) }).strict().refine(value =>
  value.clocks.reduce((total, item) => total + item.spans.length, 0) <= 32 &&
  new Set(value.clocks.map(item => item.clockId)).size === value.clocks.length &&
  new Set(value.clocks.map(item => item.source)).size === value.clocks.length &&
  Buffer.byteLength(JSON.stringify(value)) <= 8192);
export type SetupTimings = z.infer<typeof setupTimingsSchema>;
export type SetupTimingClock = SetupTimings["clocks"][number];

export function parseSetupTimings(value: unknown): SetupTimings | undefined {
  const parsed = setupTimingsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function mergeSetupTimings(...values: unknown[]): SetupTimings | undefined {
  const clocks = values.flatMap(value => parseSetupTimings(value)?.clocks ?? []);
  return clocks.length ? parseSetupTimings({ version: 1, clocks }) : undefined;
}

export function setupTimingClock(source: SetupTimingClock["source"]) {
  const started = performance.now();
  const clock: SetupTimingClock = { source, clockId: randomUUID(), startedAt: new Date().toISOString(), spans: [] };
  const elapsed = () => Math.min(3_600_000, Math.max(0, Math.round(performance.now() - started)));
  return {
    snapshot: (): SetupTimings => ({ version: 1, clocks: [{ ...clock, spans: [...clock.spans] }] }),
    start(stage: SetupTimingClock["spans"][number]["stage"]) {
      const startMs = elapsed();
      let ended = false;
      return (outcome: SetupTimingClock["spans"][number]["outcome"] = "passed") => {
        if (ended || clock.spans.length >= 32) return;
        ended = true;
        clock.spans.push({ stage, startMs, endMs: Math.max(startMs, elapsed()), outcome });
      };
    },
  };
}

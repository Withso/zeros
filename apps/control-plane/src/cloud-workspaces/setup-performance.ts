import { z } from "zod";

// CP-only observations, separate from readiness and the immutable stage_timings
// contract. A completed request is not proof that its response authorizes setup.
const readinessStages = ["total", "status_request", "sleep", "host_stopped", "boot_pending", "server_retryable",
  "status_timeout", "definitive_response"] as const;
const transportStages = ["channel_open", "prepare", "host_key", "endpoint", "key_install", "ssh_command",
  "key_revoke", "channel_dispose"] as const;
const stages = [...readinessStages, ...transportStages] as const;
const sources = ["readiness", "transport"] as const;
const allowed = { readiness: new Set<string>(readinessStages), transport: new Set<string>(stages) };
const MAX_MS = 3_600_000, MAX_COUNT = 4096;
const milliseconds = z.number().int().min(0).max(MAX_MS);
const metric = z.object({ stage: z.enum(stages), count: z.number().int().min(1).max(MAX_COUNT),
  totalMs: milliseconds, maxMs: milliseconds, lastOutcome: z.enum(["passed", "failed", "cancelled"]),
}).strict().refine(value => value.maxMs <= value.totalMs);
const group = z.object({ source: z.enum(sources), stages: z.array(metric).min(1).max(64) }).strict().refine(value =>
  new Set(value.stages.map(item => item.stage)).size === value.stages.length &&
  value.stages.every(item => allowed[value.source].has(item.stage)));
export const setupPerformanceSchema = z.object({ version: z.literal(1), truncated: z.boolean(),
  groups: z.array(group).max(6),
}).strict().refine(value => new Set(value.groups.map(item => item.source)).size === value.groups.length &&
  value.groups.reduce((total, item) => total + item.stages.length, 0) <= 64 && Buffer.byteLength(JSON.stringify(value)) <= 8192);
export type SetupPerformance = z.infer<typeof setupPerformanceSchema>;
type Source = typeof sources[number];
type Stage = typeof stages[number];
type Metric = z.infer<typeof metric>;
type Outcome = Metric["lastOutcome"];
export type SetupPerformanceObserver = (value: unknown) => void;

export function parseSetupPerformance(value: unknown): SetupPerformance | undefined {
  try {
    // Bound traversal before the schema visits array entries. Never stringify
    // an unknown diagnostic or copy arbitrary fields into an audit subject.
    if (!value || typeof value !== "object" || !("groups" in value) || !Array.isArray(value.groups) || value.groups.length > 6)
      return undefined;
    let entries = 0;
    for (const item of value.groups) {
      if (!item || !Array.isArray(item.stages) || (entries += item.stages.length) > 64) return undefined;
    }
    const parsed = setupPerformanceSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

export function mergeSetupPerformance(...values: unknown[]): SetupPerformance | undefined {
  const groups = new Map<Source, SetupPerformance["groups"][number]>();
  let truncated = false;
  for (const value of values) {
    const parsed = parseSetupPerformance(value);
    if (!parsed) continue;
    truncated ||= parsed.truncated;
    for (const item of parsed.groups) groups.set(item.source, item);
  }
  return groups.size ? parseSetupPerformance({ version: 1, truncated, groups: [...groups.values()] }) : undefined;
}

export function setupPerformance(source: Source, now: () => number = () => performance.now()) {
  const metrics = new Map<Stage, Metric>();
  let truncated = false;
  const read = () => {
    try { const value = now(); if (Number.isFinite(value) && value >= 0) return value; } catch { /* Observation only. */ }
    truncated = true;
    return null;
  };
  const record = (stage: Stage, ms: number, outcome: Outcome) => {
    if (!allowed[source].has(stage)) { truncated = true; return; }
    const prior = metrics.get(stage), count = (prior?.count ?? 0) + 1, total = (prior?.totalMs ?? 0) + ms;
    if (count > MAX_COUNT || total > MAX_MS || ms > MAX_MS) truncated = true;
    metrics.set(stage, { stage, count: Math.min(MAX_COUNT, count), totalMs: Math.min(MAX_MS, total),
      maxMs: Math.min(MAX_MS, Math.max(prior?.maxMs ?? 0, ms)), lastOutcome: outcome });
  };
  return {
    snapshot: (): SetupPerformance => ({ version: 1, truncated,
      groups: metrics.size ? [{ source, stages: [...metrics.values()].map(item => ({ ...item })) }] : [] }),
    count(stage: Stage) { record(stage, 0, "passed"); },
    start(stage: Stage) {
      const started = read();
      let ended = false;
      return (outcome: Outcome = "passed") => {
        if (ended) return;
        ended = true;
        const end = read();
        if (started !== null && end !== null) record(stage, Math.max(0, Math.round(end - started)), outcome);
      };
    },
  };
}
export type SetupPerformanceRecorder = ReturnType<typeof setupPerformance>;

export async function measureSetupPerformance<T>(recorder: SetupPerformanceRecorder | undefined, stage: Stage,
  operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const finish = recorder?.start(stage);
  try { const result = await operation(); finish?.(); return result; }
  catch (error) { finish?.(signal?.aborted ? "cancelled" : "failed"); throw error; }
}

export function reportSetupPerformance(observer: SetupPerformanceObserver | undefined, recorder: SetupPerformanceRecorder | undefined) {
  try {
    if (observer && recorder) observer(recorder.snapshot());
  } catch { /* A diagnostic observer cannot change setup or cleanup. */ }
}

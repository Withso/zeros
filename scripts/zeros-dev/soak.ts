import { createHash } from "node:crypto";
import { z } from "zod";
import { verifyPublicHourlyArtifact, PublicHourlyTrustSchema, type PublicHourlyTrust } from "./hourly-artifact";
import { trustedHourlyRun, lifecycleJob, productCompleted, REPO } from "./hourly-actions.mjs";
import { summarizeSoakEvidence, type SoakEvidence } from "./soak-metrics";
import { ZerosDevError, type ErrorCode } from "./errors";
import type { EvidenceEvent } from "./evidence";
import { beforeDeadline } from "./transport";
import type { Gate0 } from "./gate0-contract";
import type { CleanupSummary } from "./cleanup-contract";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const runSchema = z.object({ id: z.number().int().positive().safe(), run_number: z.number().int().positive().safe(),
  run_attempt: z.number().int().min(1).max(100), head_sha: z.string().regex(/^[a-f0-9]{40}$/), head_branch: z.literal("main"),
  name: z.literal("Zeros dev E2E"), path: z.literal(".github/workflows/zeros-dev-e2e.yml"), event: z.enum(["schedule", "workflow_dispatch"]),
  status: z.enum(["completed", "queued", "waiting", "requested", "pending", "in_progress"]), conclusion: z.string().nullable(),
  created_at: z.string().datetime(), repository: z.object({ full_name: z.literal("Withso/zeros") }), head_repository: z.object({ full_name: z.literal("Withso/zeros") }) });
export type SoakWorkflowRun = z.infer<typeof runSchema>;
type Api = { get(endpoint: string): Promise<unknown> };
type Profile = "hourly" | "gate0" | "unknown";
type Attempt = {
  workflowRunId: string; attempt: number; sourceSha: string; createdAt: string; completedAt?: string;
  profile: Profile; status: "passed" | "failed" | "incomplete";
  code: ErrorCode | "run_incomplete" | "attempt_unavailable" | null;
  artifactSha256?: string; firstFailure?: { phase: EvidenceEvent["phase"] | "orchestration"; code: ErrorCode };
  phases?: EvidenceEvent[]; admission?: ReturnType<typeof summarizeSoakEvidence>["admission"];
  rehearsal?: Gate0;
  cleanup?: CleanupSummary;
};
export type SoakOptions = { api: Api; read(run: SoakWorkflowRun, artifact: Record<string, unknown>): Promise<unknown>;
  trust: PublicHourlyTrust; end: string; now?: () => number; signal?: AbortSignal };
const collection = (value: unknown, key: string) => {
  const shape = z.object({ total_count: z.number().int().nonnegative().safe(), [key]: z.array(z.unknown()).max(100) }).parse(value);
  const rows = shape[key] as unknown[];
  if (shape.total_count as number < rows.length) throw new ZerosDevError("artifact_invalid");
  return { count: shape.total_count as number, rows };
};

/** A historical report only. Never dispatch, rerun, log in, select credentials,
 * create a workspace or read .env.agent to collect public Actions evidence. */
export async function collectSoak(options: SoakOptions) {
  const now = (options.now ?? Date.now)(), end = Date.parse(options.end), trust = PublicHourlyTrustSchema.parse(options.trust);
  if (!Number.isSafeInteger(end) || end % HOUR !== 0 || end > now || end < DAY) throw new ZerosDevError("invalid_request");
  const start = end - DAY, from = new Date(start).toISOString(), to = new Date(end).toISOString();
  const runs: SoakWorkflowRun[] = [], attempts: Attempt[] = [], samples: SoakEvidence[] = [];
  const deadline = AbortSignal.timeout(180_000), signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const api = { get: (endpoint: string) => {
    if (signal.aborted) throw new ZerosDevError("deadline");
    return beforeDeadline(options.api.get(endpoint), signal);
  } };
  let state: "complete" | "unavailable" | "limit" = "complete";
  const seen = new Set<number>();
  try {
    for (let page = 1; page <= 4; page++) {
      const value = collection(await api.get(`${REPO}/actions/workflows/zeros-dev-e2e.yml/runs?branch=main&created=${encodeURIComponent(`${from}..${to}`)}&per_page=100&page=${page}`), "workflow_runs");
      for (const raw of value.rows) {
        const run = runSchema.parse(raw);
        if (!trustedHourlyRun(run) || seen.has(run.id)) throw new ZerosDevError("artifact_invalid");
        seen.add(run.id);
        if (Date.parse(run.created_at) >= start && Date.parse(run.created_at) < end) runs.push(run);
      }
      if (value.count === seen.size) break;
      if (value.count < seen.size || value.rows.length < 100) throw new ZerosDevError("artifact_invalid");
      if (page === 4) state = "limit";
    }
  } catch { state = "unavailable"; }
  runs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  let totalAttempts = 0;
  for (const latest of runs) {
    for (let number = 1; number <= latest.run_attempt; number++) {
      if (signal.aborted) { state = "unavailable"; break; }
      if (++totalAttempts > 200) { state = "limit"; break; }
      const entry: Attempt = { workflowRunId: String(latest.id), attempt: number, sourceSha: latest.head_sha,
        createdAt: latest.created_at, profile: "unknown", status: "incomplete", code: "attempt_unavailable" };
      attempts.push(entry);
      try {
        const run = number === latest.run_attempt ? latest : runSchema.parse(await api.get(`${REPO}/actions/runs/${latest.id}/attempts/${number}`));
        if (!trustedHourlyRun(run) || run.id !== latest.id || run.run_number !== latest.run_number || run.run_attempt !== number ||
          run.head_sha !== latest.head_sha || run.created_at !== latest.created_at) throw new ZerosDevError("artifact_invalid");
        if (run.status !== "completed") { entry.code = "run_incomplete"; continue; }
        const job = await lifecycleJob(api, run);
        entry.profile = job.name === "gate0" ? "gate0" : "hourly";
        if (!Number.isFinite(Date.parse(job.completed_at)) || Date.parse(job.completed_at) > now + 60_000) throw new ZerosDevError("artifact_invalid");
        entry.completedAt = job.completed_at;
        if (Date.parse(job.completed_at) > end) { entry.code = "run_incomplete"; continue; }
        const listed = collection(await api.get(`${REPO}/actions/runs/${run.id}/artifacts?per_page=100`), "artifacts");
        if (listed.rows.length !== listed.count) throw new ZerosDevError("artifact_invalid");
        const artifacts = listed.rows.map(row => z.object({ id: z.number().int().positive().safe(), name: z.string(), expired: z.boolean(), size_in_bytes: z.number().int().positive(),
          digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), workflow_run: z.object({ id: z.number().int().positive().safe(), head_sha: z.string() }) }).parse(row))
          .filter(row => row.name === `zeros-dev-receipt-${run.id}-${number}`);
        const artifact = artifacts[0];
        if (artifacts.length !== 1 || artifact.expired || artifact.size_in_bytes > 2 * 1024 * 1024 ||
          artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha) throw new ZerosDevError("artifact_invalid");
        if (signal.aborted) throw new ZerosDevError("deadline");
        const payload = verifyPublicHourlyArtifact(await beforeDeadline(options.read(run, artifact), signal), trust,
          { workflowRunId: String(run.id), attempt: number, sourceSha: run.head_sha });
        const primary = payload.runs.find(row => row.runId === payload.result.runId);
        if (Date.parse(payload.completedAt) < Date.parse(run.created_at) - 60_000 ||
          Date.parse(payload.completedAt) > Date.parse(job.completed_at) + 60_000 ||
          primary && (entry.profile === "gate0") !== Boolean(primary.hourly?.rehearsal)) throw new ZerosDevError("artifact_invalid");
        entry.artifactSha256 = artifact.digest.slice("sha256:".length);
        if (payload.schema === "zeros.dev-hourly/v2") entry.cleanup = payload.cleanup;
        const passed = payload.result.success && run.conclusion === "success" &&
          (entry.profile === "hourly" ? productCompleted(job) : job.conclusion === "success");
        entry.status = passed ? "passed" : "failed"; entry.code = passed ? null : payload.result.code ?? "internal";
        const first = primary?.evidence.find(row => row.outcome === "failed");
        if (!passed) entry.firstFailure = { phase: first?.phase ?? "orchestration", code: first?.code ?? entry.code! as ErrorCode };
        if (primary) {
          entry.phases = primary.evidence;
          if (primary.hourly?.rehearsal) entry.rehearsal = primary.hourly.rehearsal;
          const sample = { run: primary, result: payload.result, startedAt: run.created_at, completedAt: job.completed_at };
          entry.admission = summarizeSoakEvidence([sample]).admission;
          if (entry.profile === "hourly") samples.push(sample);
        }
      } catch (error) { entry.status = "incomplete"; entry.code = error instanceof ZerosDevError ? error.code : "artifact_invalid"; }
    }
    if (totalAttempts > 200 || signal.aborted) break;
  }
  const slots = Array.from({ length: 24 }, (_, index) => {
    const begins = start + index * HOUR, ends = begins + HOUR;
    const rows = attempts.filter(row => row.profile !== "gate0" && Date.parse(row.createdAt) >= begins && Date.parse(row.createdAt) < ends);
    const status = rows.some(row => row.status === "failed") ? "failed" : !rows.length ? "missing"
      : rows.some(row => row.status !== "passed" || row.profile !== "hourly") ? "incomplete" : "passed";
    return { startedAt: new Date(begins).toISOString(), completedAt: new Date(ends).toISOString(), status,
      executions: rows.map(row => ({ workflowRunId: row.workflowRunId, attempt: row.attempt })) };
  });
  const metrics = summarizeSoakEvidence(samples, state !== "complete" || attempts.some(row => row.profile !== "gate0" && row.status === "incomplete"));
  const status = slots.some(row => row.status === "failed") ? "failed" : state === "complete" && slots.every(row => row.status === "passed") &&
    metrics.transport.coverage === "complete" && metrics.admission.coverage === "complete" && metrics.active.coverage === "complete" ? "passed" : "incomplete";
  return { schema: "zeros.dev-soak/v1" as const, generatedAt: new Date(now).toISOString(), window: { from, to, hours: 24 }, status, collection: state,
    publicKeySha256: createHash("sha256").update(Buffer.from(trust.publicKey, "base64url")).digest("hex"), slots, attempts, metrics,
    external: { idleDatabase: "unverified", databaseCpu: "unverified", actorConfirm: "unverified", controlPlaneEgress: "unverified", nativeUi: "unverified", betaLocal: "unverified" } };
}

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createCloudReplicaDeviceCredential } from "../../apps/desktop/src/engine/cloud-replica-device";
import { RunSchema } from "../zeros-dev/receipts";
import { collectSoak } from "../zeros-dev/soak";

function fixture() {
  const end = "2026-10-15T00:00:00.000Z", start = Date.parse(end) - 24 * 3_600_000;
  const credential = { ...createCloudReplicaDeviceCredential(randomUUID()), deviceId: randomUUID() };
  const trust = { deviceId: credential.deviceId, publicKey: credential.publicKey };
  const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: credential.publicKey, d: credential.privateKey } });
  const runs: any[] = [], jobs = new Map<string, any>(), payloads = new Map<string, any>(), artifacts = new Map<number, any[]>(), attempts = new Map<string, any>();
  const signPayload = (payload: any) => ({ payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64url") });
  const install = (run: any, profile = "lifecycle", failed = false) => {
    const id = `${run.id}/${run.run_attempt}`, completedAt = new Date(Date.parse(run.created_at) + 120_000).toISOString();
    jobs.set(id, { name: profile, run_attempt: run.run_attempt, status: "completed", conclusion: failed ? "failure" : "success", completed_at: completedAt,
      started_at: run.created_at, steps: ["Execute Alpha product lifecycle", "Save signed cleanup receipt"].map(name => ({ name, status: "completed", conclusion: name.startsWith("Execute") && failed ? "failure" : "success" })) });
    const execution = { workflowRunId: String(run.id), attempt: run.run_attempt, sourceSha: run.head_sha };
    const local = RunSchema.parse({ version: 1, runId: randomUUID(), deviceId: credential.deviceId, fixtureSha256: "a".repeat(64), createdAt: run.created_at,
      source: { revision: run.head_sha, dirty: false }, deletionConfirmed: true, prompts: [], lifecycle: [], evidence: [
        { phase: "workspace_create_wait", outcome: "ok", durationMs: 80_000 },
        { phase: "workspace_resume_wait", outcome: failed ? "failed" : "ok", durationMs: failed ? 180_000 : 20_000, ...(failed ? { code: "deadline" } : {}) },
        { phase: "runtime_transport", outcome: "ok", durationMs: 0, transport: { connectionId: randomUUID(), coverage: "complete", directAttempts: 2, directReady: 2,
          relayAttempts: 0, relayReady: 0, lostConnections: 0, authorityCloses: 0, unexplainedAuthorityCloses: 0 } },
      ], hourly: { version: 1, ...execution, complete: !failed, startedAt: run.created_at, credentials: [], histories: [],
        activeWindows: [{ readyObservedAt: new Date(Date.parse(run.created_at) + 80_000).toISOString(), workCompletedAt: completedAt, durationMs: 40_000 }] } });
    payloads.set(id, { schema: "zeros.dev-hourly/v1", execution, deviceId: credential.deviceId,
      result: { success: !failed, code: failed ? "deadline" : null, runId: local.runId }, runs: [local], completedAt });
    artifacts.set(run.id, [...(artifacts.get(run.id) ?? []).filter(a => a.name !== `zeros-dev-receipt-${run.id}-${run.run_attempt}`), {
      id: run.id * 100 + run.run_attempt, name: `zeros-dev-receipt-${run.id}-${run.run_attempt}`, digest: `sha256:${"d".repeat(64)}`,
      expired: false, size_in_bytes: 2048, workflow_run: { id: run.id, head_sha: run.head_sha },
    }]);
    attempts.set(id, { ...run, conclusion: failed ? "failure" : "success" });
    return payloads.get(id);
  };
  for (let n = 0; n < 24; n++) {
    const run = { id: n + 100, run_number: n + 1, run_attempt: 1, head_sha: "b".repeat(40), head_branch: "main",
      path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E", event: "schedule", status: "completed", conclusion: "success",
      repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" },
      created_at: new Date(start + n * 3_600_000 + 23 * 60_000).toISOString() };
    runs.push(run); install(run);
  }
  const api = { get: vi.fn(async (endpoint: string) => {
    if (endpoint.includes("/workflows/zeros-dev-e2e.yml/runs?")) return { total_count: runs.length, workflow_runs: [...runs].reverse() };
    let match = endpoint.match(/\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/);
    if (match) return { total_count: 1, jobs: [jobs.get(`${match[1]}/${match[2]}`)] };
    match = endpoint.match(/\/runs\/(\d+)\/attempts\/(\d+)$/);
    if (match) return attempts.get(`${match[1]}/${match[2]}`);
    match = endpoint.match(/\/runs\/(\d+)\/artifacts\?/);
    if (match) return { total_count: artifacts.get(Number(match[1]))!.length, artifacts: artifacts.get(Number(match[1])) };
    throw new Error("unexpected fixture read");
  }) };
  const read = vi.fn(async (run: any) => signPayload(payloads.get(`${run.id}/${run.run_attempt}`)));
  const options = { api, read, trust, end, now: () => Date.parse(end) + 60_000 };
  return { options, runs, jobs, payloads, artifacts, attempts, install, read, api, trust, credential };
}

describe("read-only signed 24-hour soak report", () => {
  it("requires every hour and exposes timings, verified UTC active windows and separate transport denominators", async () => {
    const f = fixture(), report = await collectSoak(f.options);
    expect(report.status).toBe("passed"); expect(report.slots).toHaveLength(24);
    expect(report.slots.every((slot: any) => slot.status === "passed")).toBe(true);
    expect(report.metrics.transport).toMatchObject({ coverage: "complete", directAttempts: 48, directReady: 48, directSuccessRate: 1, unexplainedAuthorityCloses: 0 });
    expect(report.metrics.active.durationMs).toBe(24 * 40_000);
    expect(report.metrics.phases.workspace_resume_wait).toMatchObject({ samples: 24, p99Ms: 20_000 });
    expect(report.external).toMatchObject({ idleDatabase: "unverified", actorConfirm: "unverified", controlPlaneEgress: "unverified", nativeUi: "unverified" });
    expect(JSON.stringify(report)).not.toContain(f.credential.privateKey);
  });
  it("does not let a green rerun erase the failed original attempt", async () => {
    const f = fixture(), run = f.runs[3]; f.install({ ...run }, "lifecycle", true);
    run.run_attempt = 2; f.install(run);
    const report = await collectSoak(f.options), rows = report.attempts.filter((row: any) => row.workflowRunId === String(run.id));
    expect(report.status).toBe("failed"); expect(rows.map((row: any) => row.status)).toEqual(["failed", "passed"]);
    expect(rows[0].firstFailure).toMatchObject({ phase: "workspace_resume_wait", code: "deadline" });
  });
  it("names missing hours and refuses rehearsals as hourly soak coverage", async () => {
    const f = fixture(); f.runs.splice(5, 1);
    const run = f.runs[8]; run.event = "workflow_dispatch"; f.jobs.get(`${run.id}/1`).name = "gate0";
    // A forged green rehearsal without its strict completed proof is invalid,
    // and still never substitutes for a missing scheduled hourly run.
    const report = await collectSoak(f.options);
    expect(report.status).toBe("incomplete");
    expect(report.slots.filter((row: any) => row.status === "missing")).toHaveLength(2);
    expect(report.attempts.find((row: any) => row.workflowRunId === String(run.id)).profile).toBe("gate0");
  });
  it.each(["signature", "producer", "digest", "expired"])("refuses %s artifact evidence without raw diagnostic output", async kind => {
    const f = fixture(), run = f.runs[2];
    if (kind === "signature") f.read.mockImplementationOnce(async () => ({ payload: {}, signature: "synthetic-private" }));
    if (kind === "producer") f.artifacts.get(run.id)![0].workflow_run.head_sha = "f".repeat(40);
    if (kind === "digest") delete f.artifacts.get(run.id)![0].digest;
    if (kind === "expired") f.artifacts.get(run.id)![0].expired = true;
    const report = await collectSoak(f.options);
    expect(report.status).toBe("incomplete");
    expect(report.attempts.some((row: any) => row.code === "artifact_invalid")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("synthetic-private");
  });
  it("deduplicates admission snapshots by connection/call and keeps their first failures after success", async () => {
    const f = fixture(), run = f.payloads.get(`${f.runs[0].id}/1`).runs[0], connectionId = run.evidence[2].transport.connectionId;
    const firstFailure = { status: 503, code: "cloud_runtime_temporarily_unavailable", phase: "provider_endpoint", retryAfterMs: 1000 };
    const admission = { connectionId, sequence: 1, firstFailure, retryCount: 1, retries: [{ ...firstFailure, attempt: 2, delayMs: 1000 }] };
    run.evidence.push({ phase: "runtime_admission", outcome: "pending", durationMs: 0, admission: { ...admission, retryCount: 0, retries: [] } },
      { phase: "runtime_admission", outcome: "pending", durationMs: 1000, admission }, { phase: "runtime_connect", outcome: "ok", durationMs: 1200, admission });
    const report = await collectSoak(f.options);
    expect(report.metrics.admission).toMatchObject({ coverage: "complete", failedCalls: 1, retries: 1 });
    expect(report.attempts[0].admission.failures).toHaveLength(1);
    expect(report.metrics.transport.directAttempts).toBe(48);
  });
  it("marks legacy missing counters unknown and never invents a zero error or 100% rate", async () => {
    const f = fixture(); for (const payload of f.payloads.values()) payload.runs[0].evidence.splice(2, 1);
    const report = await collectSoak(f.options);
    expect(report.status).toBe("incomplete");
    expect(report.metrics.transport).toMatchObject({ coverage: "unavailable", directSuccessRate: null });
    expect(report.metrics.admission.coverage).toBe("unavailable");
  });
  it("reports an in-progress attempt and bounded collection failure as incomplete", async () => {
    const f = fixture(), run = f.runs[23]; run.status = "in_progress"; run.conclusion = null;
    const report = await collectSoak(f.options);
    expect(report.status).toBe("incomplete"); expect(report.attempts.at(-1)).toMatchObject({ code: "run_incomplete" });
    f.api.get.mockRejectedValue(new Error("synthetic-private-provider-body"));
    const unavailable = await collectSoak(f.options);
    expect(unavailable.collection).toBe("unavailable"); expect(unavailable.slots.every((slot: any) => slot.status === "missing")).toBe(true);
    expect(JSON.stringify(unavailable)).not.toContain("synthetic-private");
  });
  it("cannot backfill a historical hour with work completed after the selected window", async () => {
    const f = fixture(), run = f.runs[23], late = new Date(Date.parse(f.options.end) + 3_600_000).toISOString();
    f.jobs.get(`${run.id}/1`).completed_at = late;
    f.payloads.get(`${run.id}/1`).completedAt = late;
    f.options.now = () => Date.parse(late) + 60_000;
    const report = await collectSoak(f.options);
    expect(report.status).toBe("incomplete");
    expect(report.attempts.at(-1)).toMatchObject({ code: "run_incomplete", status: "incomplete" });
  });
});

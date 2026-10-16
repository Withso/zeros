import { describe, expect, it, vi } from "vitest";
import { planHourly, planMain, planOutputs, hourlyContext, actionsProfile, hourlySnapshot, decideHourlyGate, lifecycleJob } from "../zeros-dev/hourly-actions.mjs";
import { CHAIN_RESTART } from "../zeros-dev/chain-restart.mjs";

const run = (id: number, overrides = {}) => ({ id, run_number: id, run_attempt: 1, path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E",
  head_sha: "a".repeat(40), head_branch: "main", event: "schedule", status: "completed", conclusion: "success",
  repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" },
  created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:08:00Z", ...overrides });
const context = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
// Exact API name from the skipped scheduled run 38666579898.
const skippedExpression = "inputs.profile == 'gate0' && 'gate0' || 'lifecycle'";
const infrastructureExpression = "(inputs.profile == 'infrastructure' || (github.event_name == 'schedule' && vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true')) && 'infrastructure' || (inputs.profile == 'gate0' && 'gate0' || 'lifecycle')";
const completedJob = (overrides = {}) => ({ name: "lifecycle", status: "completed", conclusion: "success", run_attempt: 1,
  completed_at: "2026-10-14T00:08:00Z", steps: [
    { name: "Execute Alpha product lifecycle", status: "completed", conclusion: "success" },
    { name: "Save signed cleanup receipt", status: "completed", conclusion: "success" },
  ], ...overrides });
function api(rows = [run(17, { status: "in_progress", conclusion: null }), run(16)]) {
  return { get: vi.fn(async (url: string): Promise<unknown> => {
    if (url.endsWith("/actions/runs/17")) return rows[0];
    if (url.includes("/artifacts")) return { total_count: 1, artifacts: [{ id: 99, name: "zeros-dev-receipt-16-1", expired: false, size_in_bytes: 100,
      digest: `sha256:${"c".repeat(64)}`, workflow_run: { id: 16, head_sha: "a".repeat(40) } }] };
    return { total_count: rows.length, workflow_runs: rows };
  }) };
}
describe("hourly Actions predecessor and gate policy", () => {
  it.each(["schedule", "workflow_dispatch"])("accepts the explicit infrastructure profile for %s without calling it hourly", event => {
    expect(actionsProfile({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_EVENT_NAME: event,
      GITHUB_RUN_ID: "17", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40), ZEROS_DEV_PROFILE: "infrastructure" })).toBe("infrastructure");
  });
  it.each(["success", "failure"])("never activates or replaces hourly with a completed %s infrastructure run", async conclusion => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success")
      ? { total_count: conclusion === "success" ? 2 : 1, workflow_runs: conclusion === "success" ? [run(17), run(16)] : [run(16)] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob(url.includes("/runs/17/") ? { name: "infrastructure", conclusion } : {})] }
      : { total_count: 2, workflow_runs: [run(17, { conclusion }), run(16)] }) };
    const snapshot = await hourlySnapshot(f);
    expect(snapshot).toMatchObject({ activated: true, latest: { id: 16 } });
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T00:38:00Z"))).toMatchObject({ allowed: true, code: "hourly_green" });
    f.get.mockImplementation(async (url: string) => url.includes("/jobs")
      ? { total_count: 1, jobs: [completedJob({ name: "infrastructure" })] }
      : { total_count: 1, workflow_runs: [run(17)] });
    expect(await hourlySnapshot(f)).toMatchObject({ activated: false, latest: null });
  });
  it("keeps an unevaluated infrastructure profile expression skipped and cannot infer a green profile", async () => {
    const current = run(17, { status: "in_progress", conclusion: null }), skipped = run(16, { conclusion: "skipped" });
    const f = api([current, skipped]), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({ name: infrastructureExpression, conclusion: "skipped", steps: [] })] } : original(url));
    expect(await planHourly(f, context)).toMatchObject({ bootstrap: true, previous: null });
    expect(await lifecycleJob(f, skipped)).toMatchObject({ name: "unselected", conclusion: "skipped" });
    const malformed = { get: vi.fn(async () => ({ total_count: 1, jobs: [completedJob({ name: infrastructureExpression })] })) };
    await expect(lifecycleJob(malformed, run(16))).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it.each(["success", "failure"])("does not let a completed %s Gate 0 rehearsal replace the last hourly result", async conclusion => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success")
      ? { total_count: conclusion === "success" ? 2 : 1, workflow_runs: conclusion === "success" ? [run(17, { event: "workflow_dispatch" }), run(16)] : [run(16)] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob(url.includes("/runs/17/") ? { name: "gate0", conclusion } : {})] }
      : { total_count: 2, workflow_runs: [run(17, { event: "workflow_dispatch", conclusion }), run(16)] }) };
    const snapshot = await hourlySnapshot(f);
    expect(snapshot).toMatchObject({ activated: true, latest: { id: 16 }, completedAt: "2026-10-14T00:08:00Z" });
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T00:38:00Z"))).toMatchObject({ allowed: true, code: "hourly_green" });
  });
  it("a green rehearsal cannot activate hourly admission or conceal a completed red hourly run", async () => {
    const jobs = (url: string) => ({ total_count: 1, jobs: [completedJob(url.includes("/runs/17/") ? { name: "gate0" } : { conclusion: "failure" })] });
    const f = { get: vi.fn(async (url: string) => url.includes("/jobs") ? jobs(url)
      : url.includes("status=success") ? { total_count: 1, workflow_runs: [run(17, { event: "workflow_dispatch" })] }
      : { total_count: 2, workflow_runs: [run(17, { event: "workflow_dispatch" }), run(16, { conclusion: "failure" })] }) };
    expect(await hourlySnapshot(f)).toMatchObject({ activated: false, latest: { id: 16, conclusion: "failure" } });
  });
  it("preserves the signed rehearsal predecessor for the next hourly cleanup", async () => {
    const f = api([run(17, { status: "in_progress", conclusion: null }), run(16, { event: "workflow_dispatch" })]);
    expect(await planHourly(f, context)).toMatchObject({ previous: { workflowRunId: "16", attempt: 1 }, artifactId: "99", bootstrap: false });
  });
  it("selects only the exact immediately preceding main artifact and never makes a network write", async () => {
    const f = api(); expect(await planHourly(f, context)).toMatchObject({ previous: { workflowRunId: "16", attempt: 1 }, artifactId: "99", bootstrap: false });
    expect(f.get.mock.calls.every(([url]) => url.startsWith("/repos/Withso/zeros/"))).toBe(true);
  });
  it("fails closed on a missing predecessor receipt", async () => {
    const f = api(); const get = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] } : get(url));
    await expect(planHourly(f, context)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it("retains the exact owner-reviewed prestart incident when crossing its missing receipt", async () => {
    const current = run(17, { status: "in_progress", conclusion: null }), previous = run(38682977049, {
      run_number: 16, event: "workflow_dispatch", conclusion: "failure", head_sha: "bb8455571cb27026060ad728f245e700151fdf38" });
    const f = api([current, previous]), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({ id: 116251429975, name: "gate0", conclusion: "failure",
        steps: ["Execute Alpha product lifecycle", "Save signed cleanup receipt"].map(name => ({ name, status: "completed", conclusion: "failure" })) })] }
      : original(url));
    expect(await planHourly(f, context)).toMatchObject({ bootstrap: true, previous: null, prestartRecovery: {
      version: 1, workflowRunId: "38682977049", attempt: 1, sourceSha: previous.head_sha, jobId: "116251429975", cause: "module_transform_before_evaluation",
    } });
  });
  it.each(["run", "attempt", "source", "event", "job", "executed", "upload"])("refuses a prestart recovery with changed %s", async change => {
    const current = run(17, { status: "in_progress", conclusion: null }), previous = run(change === "run" ? 38682977050 : 38682977049, {
      run_number: 16, event: change === "event" ? "schedule" : "workflow_dispatch", conclusion: "failure",
      head_sha: change === "source" ? "f".repeat(40) : "bb8455571cb27026060ad728f245e700151fdf38", run_attempt: change === "attempt" ? 2 : 1 });
    const f = api([current, previous]), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({ id: change === "job" ? 116251429976 : 116251429975,
        name: "gate0", conclusion: "failure", run_attempt: previous.run_attempt,
        steps: [{ name: "Execute Alpha product lifecycle", status: "completed", conclusion: change === "executed" ? "success" : "failure" },
          { name: "Save signed cleanup receipt", status: "completed", conclusion: change === "upload" ? "success" : "failure" }] })] } : original(url));
    await expect(planHourly(f, context)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  const restartRun = (overrides = {}) => run(38737559526, { run_number: 11, event: "workflow_dispatch", conclusion: "failure",
    head_sha: "a57a361d35275279dea209f85f9df9aaec8805b2", ...overrides });
  const restartArtifact = (previous: ReturnType<typeof run>, overrides = {}) => ({ id: 11977255852, name: `zeros-dev-receipt-${previous.id}-${previous.run_attempt}`,
    expired: false, size_in_bytes: 12919, digest: "sha256:dedd838cf5e53c4a9146331f11a794a983153792d59350c3a173b5fe54e8bee4",
    workflow_run: { id: previous.id, head_sha: previous.head_sha }, ...overrides });
  function restartApi(rows: ReturnType<typeof run>[], artifacts: (id: number) => unknown[], jobs: (id: number) => unknown = () => completedJob()) {
    const f = api(rows), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => {
      const id = Number(/\/runs\/([0-9]+)\//.exec(url)?.[1]);
      if (url.includes("/artifacts")) { const rows = artifacts(id); return { total_count: rows.length, artifacts: rows }; }
      return url.includes("/jobs") ? { total_count: 1, jobs: [jobs(id)] } : original(url);
    });
    return f;
  }
  it("restarts the chain only from the exact owner-reviewed receipt of the lost device", async () => {
    const previous = restartRun(), f = restartApi([run(17, { status: "in_progress", conclusion: null }), previous], () => [restartArtifact(previous)]);
    expect(await planHourly(f, context)).toEqual({ execution: context, bootstrap: true, previous: null, artifactId: null, chainRestart: CHAIN_RESTART });
    expect(CHAIN_RESTART).toEqual({ version: 1, workflowRunId: "38737559526", attempt: 1, sourceSha: "a57a361d35275279dea209f85f9df9aaec8805b2",
      artifactId: "11977255852", artifactDigest: "sha256:dedd838cf5e53c4a9146331f11a794a983153792d59350c3a173b5fe54e8bee4",
      receiptSha256: "2a2abb9eb07b460ae07a21719aaf4229b36e589f606a100746d7f5f5fef9c5c3", retiredDeviceId: "d5d457f9-86e6-4611-a757-88e0ad2df64a",
      approvedOn: "2026-10-16", reason: "fixture device key lost with its host; owner-approved restart" });
    expect(Object.isFrozen(CHAIN_RESTART)).toBe(true);
    expect(planOutputs({ ...await planHourly(f, context), profile: "infrastructure" }))
      .toMatch(/\nprevious_run=38737559526\nartifact_id=11977255852\n$/);
  });
  it("crosses only product-skipped runs between the restart receipt and the first new-chain run", async () => {
    const previous = restartRun(), skipped = run(16, { conclusion: "skipped" });
    const f = restartApi([run(17, { status: "in_progress", conclusion: null }), skipped, previous], id => id === previous.id ? [restartArtifact(previous)] : [],
      () => completedJob({ name: infrastructureExpression, conclusion: "skipped", steps: [] }));
    expect(await planHourly(f, context)).toMatchObject({ bootstrap: true, previous: null, chainRestart: CHAIN_RESTART });
  });
  it.each([
    { change: "attempt", run: { run_attempt: 2 }, artifact: {} },
    { change: "source", run: { head_sha: "f".repeat(40) }, artifact: {} },
    { change: "event", run: { event: "schedule" }, artifact: {} },
    { change: "conclusion", run: { conclusion: "success" }, artifact: {} },
    { change: "artifact id", run: {}, artifact: { id: 11977255853 } },
    { change: "artifact digest", run: {}, artifact: { digest: `sha256:${"d".repeat(64)}` } },
    { change: "run with the pinned artifact", run: { id: 38737559527 }, artifact: {} },
    { change: "run with the pinned digest", run: { id: 38737559527 }, artifact: { id: 11977255853 } },
  ])("fails closed instead of bootstrapping when only the $change differs", async ({ run: changes, artifact }) => {
    const previous = restartRun(changes), f = restartApi([run(17, { status: "in_progress", conclusion: null }), previous],
      () => [restartArtifact(previous, artifact)]);
    await expect(planHourly(f, context)).rejects.toThrow("zeros_dev_chain_restart_mismatch");
  });
  it("names a partial restart match in the planner's closed error without writing a plan", async () => {
    const previous = restartRun(), f = restartApi([run(17, { status: "in_progress", conclusion: null }), previous],
      () => [restartArtifact(previous, { digest: `sha256:${"d".repeat(64)}` })]);
    const errors: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { const target = new URL(url); return Response.json(await f.get(target.pathname + target.search)); }));
    vi.spyOn(process.stderr, "write").mockImplementation(chunk => { errors.push(String(chunk)); return true; });
    try {
      expect(await planMain({ GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule",
        GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_RUN_ID: "17", GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "a".repeat(40), GITHUB_TOKEN: "synthetic-token", GITHUB_OUTPUT: "/nonexistent/zeros-dev-output" })).toBe(1);
      expect(errors).toEqual(['{"schema":"zeros.dev-error/v1","code":"chain_restart_mismatch"}\n']);
    } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });
  it("chains normally to the first new-chain receipt and never applies the restart again", async () => {
    const restart = restartRun(), first = run(16, { event: "workflow_dispatch", conclusion: "failure" });
    const f = restartApi([run(17, { status: "in_progress", conclusion: null }), first, restart],
      id => id === restart.id ? [restartArtifact(restart)] : id === 16 ? [{ id: 99, name: "zeros-dev-receipt-16-1", expired: false, size_in_bytes: 100,
        digest: `sha256:${"c".repeat(64)}`, workflow_run: { id: 16, head_sha: "a".repeat(40) } }] : []);
    const plan = await planHourly(f, context);
    expect(plan).toEqual({ execution: context, bootstrap: false, previous: { workflowRunId: "16", attempt: 1, sourceSha: "a".repeat(40) }, artifactId: "99" });
    expect(f.get.mock.calls.some(([url]) => url.includes(`/runs/${restart.id}/`))).toBe(false);
    expect(planOutputs({ ...plan, profile: "hourly" })).toMatch(/\nprevious_run=16\nartifact_id=99\n$/);
  });
  it.each(["lifecycle", skippedExpression])("can start after a disabled schedule with job name %s only when the product never ran", async name => {
    const current = run(17, { status: "in_progress", conclusion: null }), skipped = run(16, { conclusion: "skipped" });
    const f = api([current, skipped]), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({name,conclusion:"skipped",steps:[]})] } : original(url));
    expect(await planHourly(f, context)).toMatchObject({ bootstrap: true, previous: null });
  });
  it.each([
    { label: "manual dispatch", runOverrides: { event: "workflow_dispatch" }, jobOverrides: {} },
    { label: "unfinished run", runOverrides: { status: "in_progress" }, jobOverrides: {} },
    { label: "successful job", runOverrides: {}, jobOverrides: { conclusion: "success" } },
    { label: "failed job", runOverrides: {}, jobOverrides: { conclusion: "failure" } },
    { label: "unfinished job", runOverrides: {}, jobOverrides: { status: "in_progress" } },
    { label: "nonempty steps", runOverrides: {}, jobOverrides: { steps: [{ name: "Execute Alpha product lifecycle", status: "completed", conclusion: "skipped" }] } },
    { label: "different attempt", runOverrides: {}, jobOverrides: { run_attempt: 2 } },
    { label: "different expression", runOverrides: {}, jobOverrides: { name: `${skippedExpression} ` } },
  ])("rejects a raw job name with $label", async ({ runOverrides, jobOverrides }) => {
    const f = { get: vi.fn(async () => ({ total_count: 1, jobs: [completedJob({ name: skippedExpression, conclusion: "skipped", steps: [], ...jobOverrides })] })) };
    await expect(lifecycleJob(f, run(16, runOverrides))).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it("bootstraps only when this is the first authoritative main run", async () => {
    expect(await planHourly(api([run(17, { status: "in_progress", conclusion: null })]), context)).toMatchObject({ bootstrap: true, previous: null });
    const f = api(); f.get.mockResolvedValueOnce(run(17, { head_branch: "foreign" }));
    await expect(planHourly(f, context)).rejects.toThrow("zeros_dev_actions_required");
  });
  it("refuses non-main invocations before accessing credentials", () => {
    expect(() => hourlyContext({ GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/repair" })).toThrow("zeros_dev_actions_required");
  });
  it.each(["failure", "cancelled", "timed_out"])("never falls back to an older green when the newest run is %s", conclusion => {
    const result = decideHourlyGate({ activated: true, latest: run(17, { conclusion }), completedAt: "2026-10-14T00:08:00Z" }, true, Date.parse("2026-10-14T00:09:00Z"));
    expect(result).toMatchObject({ allowed: false, code: "hourly_failed" });
  });
  it("requires freshness after first green and only alerts noncloud changes", () => {
    const snapshot = { activated: true, latest: run(17), completedAt: "2026-10-14T00:08:00Z", executed: true };
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T02:08:00Z"))).toMatchObject({ allowed: false, code: "hourly_stale" });
    expect(decideHourlyGate(snapshot, false, Date.parse("2026-10-14T02:08:00Z"))).toMatchObject({ allowed: true, alert: true });
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T00:09:00Z"))).toMatchObject({ allowed: true, code: "hourly_green" });
    expect(decideHourlyGate({ activated: false, latest: null }, true)).toMatchObject({ allowed: true, code: "hourly_not_live" });
  });
  it("queries successes independently of recent red history before deciding activation", async () => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success") ? { total_count: 1, workflow_runs: [run(1)] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob()] }
      : { total_count: 1, workflow_runs: [run(17, { conclusion: "failure" })] }) };
    expect(await hourlySnapshot(f)).toMatchObject({ activated: true, latest: { id: 17, conclusion: "failure" } });
  });
  it.each(["success", "failure"])("uses the latest completed %s while a newer run is in progress", async conclusion => {
    const completed = run(16, { conclusion });
    const f = { get: vi.fn(async (url: string) => url.includes("status=success") ? { total_count: 1, workflow_runs: [run(15)] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob(url.includes("/runs/16/") ? { conclusion } : {})] }
      : { total_count: 3, workflow_runs: [run(17, { status: "in_progress", conclusion: null }), completed, run(15)] }) };
    const snapshot = await hourlySnapshot(f);
    expect(snapshot).toMatchObject({ activated: true, latest: { id: 16, status: "completed", conclusion }, completedAt: "2026-10-14T00:08:00Z" });
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T00:38:00Z")))
      .toMatchObject({ allowed: conclusion === "success", code: conclusion === "success" ? "hourly_green" : "hourly_failed" });
    expect(f.get.mock.calls.some(([url]) => url.includes("/runs/17/attempts/1/jobs"))).toBe(false);
  });
  it("does not renew completed freshness when a newer run starts", async () => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success") ? { total_count: 1, workflow_runs: [run(16)] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob()] }
      : { total_count: 2, workflow_runs: [run(17, { status: "in_progress", conclusion: null, updated_at: "2026-10-14T02:08:00Z" }), run(16)] }) };
    expect(decideHourlyGate(await hourlySnapshot(f), true, Date.parse("2026-10-14T02:08:00Z")))
      .toMatchObject({ allowed: false, code: "hourly_stale" });
  });
  it.each(["success", "failure"])("retains the completed %s attempt while its rerun is in progress", async conclusion => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success")
      ? { total_count: conclusion === "success" ? 0 : 1, workflow_runs: conclusion === "success" ? [] : [run(1)] }
      : url.endsWith("/attempts/1") ? run(17, { conclusion })
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob(url.includes("/runs/17/") ? { conclusion } : {})] }
      : { total_count: 1, workflow_runs: [run(17, { run_attempt: 2, status: "in_progress", conclusion: null })] }) };
    const snapshot = await hourlySnapshot(f);
    expect(snapshot).toMatchObject({ activated: true, latest: { id: 17, run_attempt: 1, status: "completed", conclusion } });
    expect(decideHourlyGate(snapshot, true, Date.parse("2026-10-14T00:38:00Z")))
      .toMatchObject({ allowed: conclusion === "success", code: conclusion === "success" ? "hourly_green" : "hourly_failed" });
  });
  it("refuses a foreign completed attempt behind an active rerun", async () => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success") ? { total_count: 1, workflow_runs: [run(1)] }
      : url.endsWith("/attempts/1") ? run(17, { head_sha: "b".repeat(40) })
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob()] }
      : { total_count: 1, workflow_runs: [run(17, { run_attempt: 2, status: "in_progress", conclusion: null })] }) };
    await expect(hourlySnapshot(f)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it.each(["lifecycle", skippedExpression])("does not activate from a successful workflow whose %s job was skipped",async name=>{
    const f={get:vi.fn(async(url:string)=>url.includes("/jobs")?{total_count:1,jobs:[completedJob({name,conclusion:"skipped",steps:[]})]}
      :{total_count:1,workflow_runs:[run(1)]})};
    const snapshot = await hourlySnapshot(f);
    expect(snapshot).toMatchObject({activated:false,latest:{id:1}});
    expect(decideHourlyGate(snapshot, true)).toMatchObject({allowed:true,code:"hourly_not_live",activated:false});
  });
  it.each(["lifecycle", skippedExpression])("does not let a disabled latest %s job pass after the first executed green",async name=>{
    const f={get:vi.fn(async(url:string)=>url.includes("status=success")?{total_count:2,workflow_runs:[run(17),run(1)]}
      :url.includes("/runs/17/")?{total_count:1,jobs:[completedJob({name,conclusion:"skipped",steps:[]})]}
      :url.includes("/jobs")?{total_count:1,jobs:[completedJob()]}
      :{total_count:2,workflow_runs:[run(17),run(1)]})};
    expect(decideHourlyGate(await hourlySnapshot(f),true,Date.parse("2026-10-14T00:09:00Z"))).toMatchObject({allowed:false,code:"hourly_failed"});
  });
  it("keeps activation when the only successful run is rerun and its new attempt fails", async () => {
    const f = { get: vi.fn(async (url: string) => url.includes("status=success") ? { total_count: 0, workflow_runs: [] }
      : url.endsWith("/attempts/1") ? run(17)
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({ run_attempt: url.includes("/attempts/2/") ? 2 : 1 })] }
      : { total_count: 1, workflow_runs: [run(17, { run_attempt: 2, conclusion: "failure" })] }) };
    expect(decideHourlyGate(await hourlySnapshot(f), true, Date.parse("2026-10-14T00:09:00Z"))).toMatchObject({ activated: true, allowed: false, code: "hourly_failed" });
  });
  it.each(["lifecycle", skippedExpression])("never discards a receipt before an all-skipped %s predecessor",async name=>{
    const current=run(17,{status:"in_progress",conclusion:null}),rows=[current,run(16,{conclusion:"skipped"}),run(15)];
    const f=api(rows),original=f.get.getMockImplementation()!;
    f.get.mockImplementation(async url=>url.includes("/runs/16/artifacts")?{total_count:0,artifacts:[]}
      :url.includes("/runs/16/attempts/1/jobs")?{total_count:1,jobs:[completedJob({name,conclusion:"skipped",steps:[]})]}
      :url.includes("/runs/15/artifacts")?{total_count:1,artifacts:[{id:98,name:"zeros-dev-receipt-15-1",expired:false,size_in_bytes:100,
        digest:`sha256:${"d".repeat(64)}`,workflow_run:{id:15,head_sha:"a".repeat(40)}}]}:original(url));
    expect(await planHourly(f,context)).toMatchObject({bootstrap:false,artifactId:"98",previous:{workflowRunId:"15"}});
  });
  it("refuses an old rerun once a later workflow may have touched the fixture",async()=>{
    const f=api([run(17,{run_attempt:2,status:"in_progress",conclusion:null}),run(18)]);
    await expect(planHourly(f,{...context,attempt:2})).rejects.toThrow("zeros_dev_artifact_invalid");
  });
});

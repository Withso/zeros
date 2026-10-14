import { describe, expect, it, vi } from "vitest";
import { planHourly, hourlyContext, hourlySnapshot, decideHourlyGate } from "../zeros-dev/hourly-actions.mjs";

const run = (id: number, overrides = {}) => ({ id, run_number: id, run_attempt: 1, path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E",
  head_sha: "a".repeat(40), head_branch: "main", event: "schedule", status: "completed", conclusion: "success",
  repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" },
  created_at: "2026-10-14T00:00:00Z", updated_at: "2026-10-14T00:08:00Z", ...overrides });
const context = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
const completedJob = (overrides = {}) => ({ name: "lifecycle", status: "completed", conclusion: "success", run_attempt: 1,
  completed_at: "2026-10-14T00:08:00Z", steps: [
    { name: "Execute Alpha product lifecycle", status: "completed", conclusion: "success" },
    { name: "Save signed cleanup receipt", status: "completed", conclusion: "success" },
  ], ...overrides });
function api(rows = [run(17, { status: "in_progress", conclusion: null }), run(16)]) {
  return { get: vi.fn(async (url: string) => {
    if (url.endsWith("/actions/runs/17")) return rows[0];
    if (url.includes("/artifacts")) return { total_count: 1, artifacts: [{ id: 99, name: "zeros-dev-receipt-16-1", expired: false, size_in_bytes: 100,
      digest: `sha256:${"c".repeat(64)}`, workflow_run: { id: 16, head_sha: "a".repeat(40) } }] };
    return { total_count: rows.length, workflow_runs: rows };
  }) };
}
describe("hourly Actions predecessor and gate policy", () => {
  it("selects only the exact immediately preceding main artifact and never makes a network write", async () => {
    const f = api(); expect(await planHourly(f, context)).toMatchObject({ previous: { workflowRunId: "16", attempt: 1 }, artifactId: "99", bootstrap: false });
    expect(f.get.mock.calls.every(([url]) => url.startsWith("/repos/Withso/zeros/"))).toBe(true);
  });
  it("fails closed on a missing predecessor receipt", async () => {
    const f = api(); const get = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] } : get(url));
    await expect(planHourly(f, context)).rejects.toThrow("zeros_dev_artifact_invalid");
  });
  it("can start after a disabled schedule only when job metadata proves the product entry never ran", async () => {
    const current = run(17, { status: "in_progress", conclusion: null }), skipped = run(16, { conclusion: "skipped" });
    const f = api([current, skipped]), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => url.includes("/artifacts") ? { total_count: 0, artifacts: [] }
      : url.includes("/jobs") ? { total_count: 1, jobs: [completedJob({conclusion:"skipped",steps:[]})] } : original(url));
    expect(await planHourly(f, context)).toMatchObject({ bootstrap: true, previous: null });
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
  it("does not activate from a successful workflow whose product job was skipped",async()=>{
    const f={get:vi.fn(async(url:string)=>url.includes("/jobs")?{total_count:1,jobs:[completedJob({conclusion:"skipped",steps:[]})]}
      :{total_count:1,workflow_runs:[run(1)]})};
    expect(await hourlySnapshot(f)).toMatchObject({activated:false});
  });
  it("does not let a disabled latest job pass after the first executed green",async()=>{
    const f={get:vi.fn(async(url:string)=>url.includes("status=success")?{total_count:2,workflow_runs:[run(17),run(1)]}
      :url.includes("/runs/17/")?{total_count:1,jobs:[completedJob({conclusion:"skipped",steps:[]})]}
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
  it("never discards a receipt before an all-skipped predecessor",async()=>{
    const current=run(17,{status:"in_progress",conclusion:null}),rows=[current,run(16,{conclusion:"skipped"}),run(15)];
    const f=api(rows),original=f.get.getMockImplementation()!;
    f.get.mockImplementation(async url=>url.includes("/runs/16/artifacts")?{total_count:0,artifacts:[]}
      :url.includes("/runs/16/attempts/1/jobs")?{total_count:1,jobs:[completedJob({conclusion:"skipped",steps:[]})]}
      :url.includes("/runs/15/artifacts")?{total_count:1,artifacts:[{id:98,name:"zeros-dev-receipt-15-1",expired:false,size_in_bytes:100,
        digest:`sha256:${"d".repeat(64)}`,workflow_run:{id:15,head_sha:"a".repeat(40)}}]}:original(url));
    expect(await planHourly(f,context)).toMatchObject({bootstrap:false,artifactId:"98",previous:{workflowRunId:"15"}});
  });
  it("refuses an old rerun once a later workflow may have touched the fixture",async()=>{
    const f=api([run(17,{run_attempt:2,status:"in_progress",conclusion:null}),run(18)]);
    await expect(planHourly(f,{...context,attempt:2})).rejects.toThrow("zeros_dev_artifact_invalid");
  });
});

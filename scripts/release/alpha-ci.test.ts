import { describe, expect, it, vi } from "vitest";
import { assertRequiredCI, waitForRequiredCI } from "./ci";
import { githubClient } from "./github";
import { ALPHA_REQUIRED_CI, CandidateSupersededError } from "./alpha-ci";

const candidate = { repository: "example/zeros", sourceSha: "a".repeat(40), branch: "main" };
const preflight = { id: 100, run_attempt: 1, name: "Preflight", path: ".github/workflows/preflight.yml", head_sha: candidate.sourceSha,
  repository: { full_name: candidate.repository }, head_repository: { full_name: candidate.repository }, head_branch: "main",
  event: "push", status: "in_progress", conclusion: null as string | null };
const codeql = { ...preflight, id: 101, name: "CodeQL", path: ".github/workflows/codeql.yml", status: "completed", conclusion: "success" };
const parent = { ...preflight, id: 300, name: "Release (alpha)", path: ".github/workflows/release-alpha.yml" };
const gate = { id: 10, run_id: preflight.id, run_attempt: 1, head_sha: candidate.sourceSha, head_branch: "main",
  name: "alpha-gate", status: "completed", conclusion: "success" };
const env = { GH_TOKEN: "fake-token", RELEASE_CHANNEL: "alpha", RELEASE_SHA: candidate.sourceSha, GITHUB_SHA: candidate.sourceSha,
  GITHUB_REPOSITORY: candidate.repository, GITHUB_RUN_ID: String(parent.id), GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "ci",
  GITHUB_WORKFLOW_REF: `${candidate.repository}/.github/workflows/release-alpha.yml@refs/heads/main`, ZEROS_ALPHA_CI_FAST_PATH: "enabled" };

function fixture(overrides: {
  env?: NodeJS.ProcessEnv; preflight?: any[]; codeql?: any[]; parent?: any; currentRun?: any;
  jobs?: any[]; jobsForAttempt?: Record<number, any[]>; history?: unknown; jobResponse?: unknown; branchSha?: string; parentJobs?: any[];
} = {}) {
  const requests: string[] = [], runs = overrides.preflight ?? [preflight], codeqlRuns = overrides.codeql ?? [codeql];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname.replace(`/repos/${candidate.repository}`, "");
    requests.push(`${route}${url.search}`);
    expect(init?.method ?? "GET").toBe("GET");
    if (route === `/actions/runs/${parent.id}`) return Response.json(overrides.parent ?? parent);
    if (route === `/actions/runs/${parent.id}/jobs`) {
      const jobs = overrides.parentJobs ?? [{ ...gate, run_id: parent.id, name: "Exact-source Preflight and CodeQL barrier", status: "in_progress", conclusion: null }];
      const page = Number(url.searchParams.get("page"));
      return Response.json(overrides.jobResponse ?? { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) });
    }
    if (route === "/actions/workflows/preflight.yml/runs") return Response.json(overrides.history ?? { total_count: runs.length, workflow_runs: runs });
    if (route === "/actions/workflows/codeql.yml/runs") return Response.json({ total_count: codeqlRuns.length, workflow_runs: codeqlRuns });
    const jobsMatch = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(route);
    if (jobsMatch) {
      const jobs = overrides.jobsForAttempt?.[Number(jobsMatch[2])] ?? overrides.jobs ?? [gate];
      const page = Number(url.searchParams.get("page"));
      return Response.json(overrides.jobResponse ?? { total_count: jobs.length, jobs: jobs.slice((page - 1) * 100, page * 100) });
    }
    if (/^\/actions\/runs\/\d+$/.test(route)) return Response.json(overrides.currentRun ?? runs.filter(run => run.id === Number(route.split("/").at(-1))).sort((a, b) => b.run_attempt - a.run_attempt)[0]);
    if (route === "/commits/main") return Response.json({ sha: overrides.branchSha ?? candidate.sourceSha });
    throw new Error(`Unexpected GitHub request: ${route}`);
  });
  return { client: githubClient(candidate, { ...env, ...overrides.env }, { fetch: fetcher }), requests, fetcher };
}

describe("automatic Alpha exact-source evidence", () => {
  it("accepts the successful gate while the full Preflight run is still running", async () => {
    const { client, requests } = fixture();
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests).toContain("/actions/runs/300");
    expect(requests).toContain("/actions/runs/100/attempts/1/jobs?per_page=100&page=1");
    const histories = requests.filter(url => url.includes("/workflows/"));
    expect(histories.every(url => url.includes(`head_sha=${candidate.sourceSha}`) && url.includes("event=push") && !url.includes("status="))).toBe(true);
    expect(requests.every(url => !url.includes("fake-token") && !url.includes("artifacts"))).toBe(true);
  });

  it("allows an ancillary failure to coexist with a successful critical gate", async () => {
    const { client } = fixture({ preflight: [{ ...preflight, status: "completed", conclusion: "failure" }],
      jobs: [gate, { ...gate, id: 11, name: "ui-smoke (composer)", conclusion: "failure" }] });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
  });

  it.each([
    "Bundled agent runtime pins (darwin artifact)",
    "All three agent runtimes boot on the SHIPPING platform",
    "ZSR kernel, parity, and detached-lifecycle qualification",
    "Design-directory guard on the shipping platform",
    "GitHub credential and review-provider contracts",
    "Files tab read + thumbnail contracts",
  ])("vetoes a known failing %s check in the deferred macOS lane", async name => {
    const { client } = fixture({ jobs: [gate, { ...gate, id: 11, name: "source-sync workload (macOS)", conclusion: "failure",
      steps: [{ name, status: "completed", conclusion: "failure" }] }] });
    await expect(client.assertRequiredChecks()).rejects.toThrow();
  });

  it("allows pending macOS security proof but refuses an unclassified observed macOS failure", async () => {
    await expect(fixture({ jobs: [gate, { ...gate, id: 11, name: "source-sync workload (macOS)", status: "in_progress", conclusion: null }] }).client.assertRequiredChecks()).resolves.toBeUndefined();
    await expect(fixture({ jobs: [gate, { ...gate, id: 11, name: "source-sync workload (macOS)", conclusion: "failure", steps: [] }] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it.each(["timed_out", "cancelled", "startup_failure", "action_required", "skipped", null])("vetoes an unclassified completed macOS result of %s", async conclusion => {
    await expect(fixture({ jobs: [gate, { ...gate, id: 11, name: "source-sync workload (macOS)", conclusion, steps: [] }] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("allows a classified ancillary macOS lifecycle failure with successful security steps", async () => {
    await expect(fixture({ jobs: [gate, { ...gate, id: 11, name: "source-sync workload (macOS)", conclusion: "failure", steps: [
      { name: "ZSR kernel, parity, and detached-lifecycle qualification", status: "completed", conclusion: "success" },
      { name: "Workspace lifecycle contracts", status: "completed", conclusion: "failure" },
    ] }] }).client.assertRequiredChecks()).resolves.toBeUndefined();
  });

  it.each(["failure", "cancelled", "skipped", "neutral", null])("rejects an alpha-gate conclusion of %s", async conclusion => {
    await expect(fixture({ jobs: [{ ...gate, conclusion }] }).client.assertRequiredChecks()).rejects.toThrow(/Alpha gate/);
  });

  it.each([
    [], [{ ...gate, status: "in_progress" }], [gate, { ...gate, id: 11 }],
    [{ ...gate, run_id: 999 }], [{ ...gate, head_sha: "b".repeat(40) }], [{ ...gate, head_branch: "release/1.2.3" }],
    [{ ...gate, name: "other / alpha-gate" }], [{ ...gate, run_attempt: 2 }],
  ].map(jobs => ({ jobs })))("rejects missing, unfinished, duplicate or mismatched gate jobs (%#)", async ({ jobs }) => {
    await expect(fixture({ jobs }).client.assertRequiredChecks()).rejects.toThrow(/Alpha gate/);
  });

  it("never substitutes a fully successful run for a missing fast gate", async () => {
    await expect(fixture({ preflight: [{ ...preflight, status: "completed", conclusion: "success" }], jobs: [] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("uses only the newest run and attempt, so a newer pending attempt defeats an old successful gate", async () => {
    const { client, requests } = fixture({ preflight: [preflight, { ...preflight, run_attempt: 2 }],
      jobsForAttempt: { 1: [gate], 2: [{ ...gate, run_attempt: 2, status: "queued", conclusion: null }] } });
    await expect(client.assertRequiredChecks()).rejects.toThrow();
    expect(requests).toContain("/actions/runs/100/attempts/2/jobs?per_page=100&page=1");
    expect(requests).not.toContain("/actions/runs/100/attempts/1/jobs?per_page=100&page=1");
  });

  it.each(["queued", "in_progress", "failure"])("a newer %s main run defeats an older green run", async status => {
    const latest = { ...preflight, id: 102, status: status === "failure" ? "completed" : status, conclusion: status === "failure" ? "failure" : null };
    await expect(fixture({ preflight: [preflight, latest], jobs: [{ ...gate, run_id: 102, status: "queued", conclusion: null }] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("accepts API-listed carried gate success from an ancillary-only retry without relying on timestamps", async () => {
    const { client, requests } = fixture({ preflight: [{ ...preflight, run_attempt: 2 }], jobs: [
      { ...gate, started_at: "2020-01-01T00:00:00Z", completed_at: "2020-01-01T00:01:00Z" },
      { ...gate, id: 11, run_attempt: 2, name: "ui-smoke (composer)", status: "in_progress", conclusion: null },
    ] });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests).toContain("/actions/runs/100/attempts/2/jobs?per_page=100&page=1");
  });

  it.each(["quality", "test", "build", "control plane", "secret scan (PR commit range)"])("refuses a carried gate when the current %s aggregate is pending or failed", async name => {
    for (const change of [{ status: "queued", conclusion: null }, { status: "completed", conclusion: "failure" }]) {
      await expect(fixture({ preflight: [{ ...preflight, run_attempt: 2 }], jobs: [gate,
        { ...gate, id: 11, run_attempt: 2, name, ...change },
      ] }).client.assertRequiredChecks()).rejects.toThrow();
    }
  });

  it("rejects an overall cancellation even when the API still lists a successful gate", async () => {
    await expect(fixture({ preflight: [{ ...preflight, status: "completed", conclusion: "cancelled" }] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("supersedes a candidate whose coalesced Preflight was cancelled after main moved on", async () => {
    const cancelled = [{ ...preflight, status: "completed", conclusion: "cancelled" }];
    await expect(fixture({ preflight: cancelled, branchSha: "b".repeat(40) }).client.assertRequiredChecks())
      .rejects.toBeInstanceOf(CandidateSupersededError);
    const current = await fixture({ preflight: cancelled }).client.assertRequiredChecks().catch(error => error);
    expect(current).toBeInstanceOf(Error);
    expect(current).not.toBeInstanceOf(CandidateSupersededError);
  });

  it("keeps waiting for a pending Preflight even when main has moved on", async () => {
    const error = await fixture({ preflight: [{ ...preflight, status: "queued", conclusion: null }], jobs: [], branchSha: "b".repeat(40) })
      .client.assertRequiredChecks().catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CandidateSupersededError);
  });

  it.each([
    { event: "pull_request" }, { event: "merge_group" }, { event: "workflow_dispatch" }, { head_branch: "release/1.2.3" },
    { head_sha: "b".repeat(40) }, { repository: { full_name: "fork/zeros" } }, { head_repository: { full_name: "fork/zeros" } },
    { name: "CI" }, { path: ".github/workflows/ci.yml" }, { id: 0 }, { run_attempt: 0 },
  ])("rejects foreign Preflight evidence (%#)", async change => {
    await expect(fixture({ preflight: [{ ...preflight, ...change }] }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("an unrelated PR or merge-group run does not supersede the canonical push/main gate", async () => {
    const { client } = fixture({ preflight: [preflight, { ...preflight, id: 102, event: "pull_request" }, { ...preflight, id: 103, event: "merge_group" }] });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
  });

  it.each([
    { status: "in_progress", conclusion: null }, { conclusion: "failure" }, { conclusion: "cancelled" },
    { event: "pull_request" }, { head_repository: { full_name: "fork/zeros" } },
  ])("does not wait for CodeQL on the automatic Alpha fast path (%#)", async change => {
    const { client, requests } = fixture({ codeql: [{ ...codeql, ...change }] });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests.some(url => url.includes("codeql.yml"))).toBe(false);
  });

  it("keeps CodeQL mandatory whenever the fast path does not apply", async () => {
    const fullPreflight = [{ ...preflight, status: "completed", conclusion: "success" }];
    const failingCodeql = [{ ...codeql, conclusion: "failure" }];
    for (const env of [{ ZEROS_ALPHA_CI_FAST_PATH: "" },
      { GITHUB_WORKFLOW_REF: `${candidate.repository}/.github/workflows/release-beta.yml@refs/heads/main` }]) {
      await expect(fixture({ env, preflight: fullPreflight, codeql: failingCodeql }).client.assertRequiredChecks())
        .rejects.toThrow(/Preflight and CodeQL/);
      await expect(fixture({ env, preflight: fullPreflight }).client.assertRequiredChecks()).resolves.toBeUndefined();
    }
  });

  it("reads every attempt job page before deciding whether the gate succeeded", async () => {
    const jobs = [...Array.from({ length: 100 }, (_, index) => ({ ...gate, id: index + 20, name: `ancillary-${index}` })), gate];
    const { client, requests } = fixture({ jobs });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests).toContain("/actions/runs/100/attempts/1/jobs?per_page=100&page=2");
  });

  it.each([
    { total_count: 101, workflow_runs: [preflight] }, { total_count: 2, workflow_runs: [preflight] }, {},
  ])("fails closed on unavailable, incomplete or over-bound history (%#)", async history => {
    await expect(fixture({ history }).client.assertRequiredChecks()).rejects.toThrow(/bound/);
  });

  it.each([{ total_count: 1001, jobs: [gate] }, { total_count: 2, jobs: [gate] }, {}])("fails closed on unavailable, incomplete or over-bound jobs (%#)", async jobResponse => {
    await expect(fixture({ jobResponse }).client.assertRequiredChecks()).rejects.toThrow(/job evidence/);
  });

  it("does not authorize an old attempt when a rerun begins during job retrieval", async () => {
    await expect(fixture({ currentRun: { ...preflight, run_attempt: 2 } }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("re-reads the gate during polling and downstream assertions rather than caching a decision", async () => {
    const state = { ...gate, conclusion: "failure" };
    const { client } = fixture({ jobs: [state] });
    let reads = 0;
    const evidence = await waitForRequiredCI(async () => {
      if (++reads === 2) state.conclusion = "success";
      return client.requiredChecks();
    }, { attempts: 2, sleep: async () => {} }, ALPHA_REQUIRED_CI);
    expect(() => assertRequiredCI(evidence, ALPHA_REQUIRED_CI)).not.toThrow();
    state.conclusion = "failure";
    await expect(client.assertRequiredChecks()).rejects.toThrow();
  });
});

describe("full release policy isolation", () => {
  it.each([undefined, "", "disabled", "observe", "true", "ENABLED"])("retains full evidence with fast-path flag %s", async flag => {
    const { client, requests } = fixture({ env: { ZEROS_ALPHA_CI_FAST_PATH: flag } });
    await expect(client.assertRequiredChecks()).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(requests.every(url => !url.includes("event="))).toBe(true);
  });

  it.each([
    { path: ".github/workflows/cloud-worker-promotion.yml" }, { event: "workflow_dispatch" }, { head_branch: "release/1.2.3" },
    { head_sha: "b".repeat(40) }, { repository: { full_name: "fork/zeros" } }, { head_repository: { full_name: "fork/zeros" } },
    { id: 999 }, { run_attempt: 2 },
  ])("retains full evidence for an unauthenticated automatic Alpha parent (%#)", async change => {
    const { client, requests } = fixture({ parent: { ...parent, ...change } });
    await expect(client.assertRequiredChecks()).rejects.toThrow();
    expect(requests.every(url => !url.includes("/jobs"))).toBe(true);
  });

  it("the workflow ref is a secondary check rather than authorization by itself", async () => {
    await expect(fixture({ parent: { ...parent, path: ".github/workflows/other.yml" } }).client.assertRequiredChecks()).rejects.toThrow();
    await expect(fixture({ env: { GITHUB_WORKFLOW_REF: `${candidate.repository}/.github/workflows/release-beta.yml@refs/heads/main` } }).client.assertRequiredChecks()).rejects.toThrow();
  });

  it("wrong parent workflow still accepts the unchanged full Preflight and CodeQL proof", async () => {
    const { client, requests } = fixture({ parent: { ...parent, path: ".github/workflows/cloud-worker-promotion.yml" },
      preflight: [{ ...preflight, status: "completed", conclusion: "success" }], jobs: [] });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests.every(url => !url.includes("/jobs"))).toBe(true);
  });

  it.each(["beta", "production"])("never accepts an Alpha-gate-only success for %s or queries Alpha authority", async channel => {
    const { client, requests } = fixture({ env: { RELEASE_CHANNEL: channel } });
    await expect(client.assertRequiredChecks()).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.includes("/actions/workflows/") && !url.includes("event="))).toBe(true);
  });

  it.each(["beta", "production"])("preserves push, PR and merge-group whole-run success for %s", async channel => {
    for (const event of ["push", "pull_request", "merge_group"]) {
      const { client } = fixture({ env: { RELEASE_CHANNEL: channel }, preflight: [{ ...preflight, event, status: "completed", conclusion: "success" }],
        codeql: [{ ...codeql, event }] });
      await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    }
  });

  it("retains strict branch HEAD equality for fast Alpha", async () => {
    await expect(fixture({ branchSha: "b".repeat(40) }).client.assertCurrent()).rejects.toBeInstanceOf(CandidateSupersededError);
    await expect(fixture({ branchSha: "invalid" }).client.assertCurrent()).rejects.not.toBeInstanceOf(CandidateSupersededError);
  });
});

describe("automatic Alpha pre-mutation supersession proof", () => {
  const barrierJob = { ...gate, run_id: parent.id, name: "Exact-source Preflight and CodeQL barrier", status: "in_progress", conclusion: null };

  it("proves the initial barrier precedes every destination job", async () => {
    const { client, requests } = fixture({ parentJobs: [barrierJob,
      { ...barrierJob, id: 11, name: "Build + sign Alpha (macOS arm64 · NOT notarized)" },
      { ...barrierJob, id: 12, name: "Hosted promotion (alpha) / Hosted services", status: "queued", started_at: null },
      { ...barrierJob, id: 13, name: "Publish Alpha feed", status: "completed", conclusion: "skipped", started_at: null },
    ] });
    await expect(client.alphaBarrierUnmutated()).resolves.toBe(true);
    expect(requests).toContain("/actions/runs/300/jobs?filter=all&per_page=100&page=1");
  });

  it.each(["Hosted promotion (alpha) / Hosted services", "Hosted promotion (alpha) / Hosted mutation", "Hosted promotion (alpha) / worker",
    "Publish Alpha feed", "Publish Alpha runtime bundle", "unknown-destination"])("refuses a prior attempt that started %s", async name => {
    await expect(fixture({ env: { GITHUB_RUN_ATTEMPT: "2" }, parent: { ...parent, run_attempt: 2 }, parentJobs: [
      { ...barrierJob, run_attempt: 2 }, { ...barrierJob, id: 11, name, status: "completed", conclusion: "failure", started_at: "2020-01-01T00:00:00Z" },
    ] }).client.alphaBarrierUnmutated()).resolves.toBe(false);
  });

  it("permits a retry only when complete prior-attempt evidence still proves no destination started", async () => {
    await expect(fixture({ env: { GITHUB_RUN_ATTEMPT: "2" }, parent: { ...parent, run_attempt: 2 }, parentJobs: [
      { ...barrierJob, status: "completed", conclusion: "failure" }, { ...barrierJob, id: 11, run_attempt: 2 },
      { ...barrierJob, id: 12, name: "Hosted promotion (alpha) / Hosted services", status: "completed", conclusion: "skipped", started_at: null },
    ] }).client.alphaBarrierUnmutated()).resolves.toBe(true);
  });

  it("cannot prove a green no-op once an earlier successful barrier has unblocked queued destination jobs", async () => {
    await expect(fixture({ env: { GITHUB_RUN_ATTEMPT: "2" }, parent: { ...parent, run_attempt: 2 }, parentJobs: [
      { ...barrierJob, status: "completed", conclusion: "success" }, { ...barrierJob, id: 11, run_attempt: 2 },
    ] }).client.alphaBarrierUnmutated()).resolves.toBe(false);
  });

  it("reads later pages so an old mutation cannot hide behind the first 100 jobs", async () => {
    const readOnly = Array.from({ length: 100 }, (_, index) => ({ ...barrierJob, id: index + 20 }));
    await expect(fixture({ parentJobs: [...readOnly, { ...barrierJob, id: 999, name: "Publish Alpha feed", started_at: "2020-01-01T00:00:00Z" }] }).client.alphaBarrierUnmutated()).resolves.toBe(false);
  });

  it.each([{ total_count: 1001, jobs: [barrierJob] }, { total_count: 2, jobs: [barrierJob] }, {}])("refuses unavailable parent mutation evidence (%#)", async jobResponse => {
    await expect(fixture({ jobResponse }).client.alphaBarrierUnmutated()).rejects.toThrow(/job evidence/);
  });

  it.each([[], [{ ...barrierJob, head_sha: "b".repeat(40) }], [{ ...barrierJob, run_id: 999 }], [{ ...barrierJob, head_branch: "other" }]])(
    "refuses absent or foreign parent job metadata (%#)", async (...rows) => {
      const parentJobs = rows.filter(row => row !== undefined);
      await expect(fixture({ parentJobs }).client.alphaBarrierUnmutated()).rejects.toThrow(/mutation evidence/);
    });

  it("cannot no-op from a worker wait or an unrelated parent workflow", async () => {
    const worker = fixture({ env: { GITHUB_JOB: "worker" } });
    await expect(worker.client.alphaBarrierUnmutated()).resolves.toBe(false);
    expect(worker.requests).toEqual([]);
    await expect(fixture({ parent: { ...parent, path: ".github/workflows/other.yml" } }).client.alphaBarrierUnmutated()).resolves.toBe(false);
  });
});

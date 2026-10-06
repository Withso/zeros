import { describe, expect, it } from "vitest";
import { disabledGuard } from "./guard";
import { githubClient } from "./github";
import { channelBaseline } from "./source";
import saved from "./fixtures/v6b-channel-tags.json";

// Public response fields retained from V6b-channel-tags.json. The audit saved
// selected run fields; repository/status/job envelopes below are API fakes.
const repository = "Withso/zeros", descendant = "a".repeat(40);
function harness(channel: "alpha" | "beta", sameTag = false) {
  const snapshot = saved.find(row => row.channel === channel)!;
  const published = snapshot.sources.find(row => row.role === "releaseTarget")!;
  const run = { ...snapshot.successfulTargetRuns![0], repository: { full_name: repository }, head_repository: { full_name: repository },
    status: "completed", updated_at: "2026-09-29T10:02:00Z" };
  const job = { run_id: run.id, head_sha: run.head_sha, head_branch: run.head_branch, status: "completed", conclusion: "success",
    name: `Build + publish ${channel === "alpha" ? "Alpha" : "Beta"} (macOS arm64 · signed · NOT notarized)`,
    steps: [{ name: `Publish rolling "${channel}" prerelease`, status: "completed", conclusion: "success", completed_at: "2026-09-29T10:01:00Z" }] };
  const responses = { runs: [run], jobs: [job] }, requests: string[] = [], gitCalls: string[][] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push(String(url));
    expect(init?.method ?? "GET").toBe("GET");
    expect(String(url)).not.toContain("fake-token");
    if (String(url).includes("/workflows/")) return Response.json({ workflow_runs: responses.runs, total_count: responses.runs.length });
    if (String(url).includes("/jobs?")) return Response.json({ jobs: responses.jobs, total_count: responses.jobs.length });
    throw new Error("Unexpected API request");
  };
  const git = async (_file: string, args: string[]) => {
    gitCalls.push(args);
    return args[0] === "for-each-ref" ? `${channel}\n` : `${sameTag ? published.sha : snapshot.tagSha}\n`;
  };
  const candidate = { channel, repository, branch: channel === "alpha" ? "main" : "release/0.1.20", sourceSha: published.sha, cloudEnabled: false };
  const client = githubClient(candidate, { GH_TOKEN: "fake-token" }, { fetch: fetcher });
  const baseline = () => channelBaseline(channel, git, () => client.lastPublication(channel));
  const current = { head: published.head, sha256: "b".repeat(64) };
  const deps = { channelBaseline: baseline, fetch: async () => new Response("missing", { status: 404 }),
    migrationManifest: async (source?: string) => source === snapshot.tagSha ? { head: snapshot.sources[0].head, sha256: "c".repeat(64) } : current,
    workerInputsSha256: async (_source: string) => "d".repeat(64) };
  return { snapshot, published, run, job, responses, requests, gitCalls, candidate, deps, baseline, current, client };
}

describe("V6b existing rolling-tag bootstrap", () => {
  it("recognizes the one nested Alpha publisher while preserving exact run/source/step authentication", async () => {
    const fixture = harness("alpha");
    fixture.job.name = "Alpha publication / Publish Alpha feed";
    expect((await fixture.baseline())?.sourceSha).toBe(fixture.published.sha);
    for (const name of ["Untrusted publication / Publish Alpha feed", "Alpha publication / Publish Beta feed", "Alpha publication / other / Publish Alpha feed"]) {
      fixture.job.name = name;
      expect(await fixture.client.lastPublication("alpha")).toBeNull();
    }
  });
  it.each(["alpha", "beta"] as const)("recognizes the separate %s publisher while retaining historical combined jobs", async channel => {
    const fixture = harness(channel);
    fixture.responses.jobs[0].name = `Publish ${channel === "alpha" ? "Alpha" : "Beta"} feed`;
    expect((await fixture.baseline())?.sourceSha).toBe(fixture.published.sha);
  });
  it.each(["Notarize + verify + publish (macOS arm64)", "Publish Production feed"])("recognizes Production publication provenance from %s", async publisher => {
    const fixture = harness("beta");
    fixture.run.path = ".github/workflows/release.yml";
    fixture.run.event = "workflow_dispatch";
    fixture.job.name = publisher;
    fixture.job.steps[0].name = "Publish GitHub release";
    expect((await fixture.client.lastPublication("production"))?.sourceSha).toBe(fixture.published.sha);
  });
  it.each(["alpha", "beta"] as const)("allows the already published %s schema despite the saved stale remote tag", async channel => {
    const f = harness(channel);
    const result = await disabledGuard([], f.candidate, f.deps);
    expect(result.blocked).toBe(false);
    expect(result.message).toContain("tag discrepancy");
    expect(result.message).toContain(f.snapshot.tagSha);
    expect(result.message).toContain(f.published.sha);
    expect(result.message).toContain(String(f.run.id));
    expect(f.requests.some(url => url.includes(`/actions/workflows/release-${channel}.yml/runs?`))).toBe(true);
    expect(f.gitCalls.every(args => ["for-each-ref", "rev-parse"].includes(args[0]))).toBe(true);
  });
  it("keeps genuinely new schema and cloud worker inputs blocked beyond that publication", async () => {
    const f = harness("beta");
    f.deps.migrationManifest = async source => source === descendant ? { head: "0105_next.sql", sha256: "e".repeat(64) } : f.current;
    expect((await disabledGuard([], { ...f.candidate, sourceSha: descendant }, f.deps)).blocked).toBe(true);
    f.deps.migrationManifest = async () => f.current;
    f.deps.workerInputsSha256 = async source => source === descendant ? "f".repeat(64) : "d".repeat(64);
    expect((await disabledGuard([], { ...f.candidate, sourceSha: descendant, cloudEnabled: true }, f.deps)).blocked).toBe(true);
    expect((await disabledGuard([], { ...f.candidate, sourceSha: descendant }, f.deps)).blocked).toBe(false);
  });
  it("requires exact repository, source repository, workflow, event, channel branch and successful publication", async () => {
    for (const patch of [{ repository: { full_name: "other/zeros" } }, { head_repository: { full_name: "other/zeros" } },
      { path: ".github/workflows/preflight.yml" }, { event: "pull_request" }, { head_branch: "main" }, { conclusion: "failure" },
      { status: "in_progress" }, { head_sha: "release/0.1.19" }]) {
      const f = harness("beta"); Object.assign(f.responses.runs[0], patch);
      expect(await f.baseline()).toBeNull();
    }
    for (const patch of [{ run_id: 1 }, { head_sha: descendant }, { name: "test" }, { conclusion: "failure" }, { steps: [] },
      { steps: [{ name: 'Publish rolling "beta" prerelease', status: "completed", conclusion: "skipped", completed_at: "2026-09-29T10:01:00Z" }] }]) {
      const f = harness("beta"); Object.assign(f.responses.jobs[0], patch);
      expect(await f.baseline()).toBeNull();
    }
  });
  it("does not trust a release target or matching tag without successful publish-step evidence", async () => {
    const f = harness("alpha", true);
    f.responses.jobs[0].steps = [];
    expect((await disabledGuard([], f.candidate, f.deps)).blocked).toBe(true);
    // No release metadata endpoint is consulted; target_commitish alone cannot authorize anything.
    expect(f.requests.every(url => !url.includes("/releases/"))).toBe(true);
  });
  it("uses the most recent successful publish time even for a rerun of an older run", async () => {
    const f = harness("beta");
    const older = { ...f.run, id: f.run.id - 1, head_sha: descendant, updated_at: "2026-09-29T11:02:00Z" };
    f.responses.runs.push(older);
    f.responses.jobs.push({ ...f.job, run_id: older.id, head_sha: descendant,
      steps: [{ ...f.job.steps[0], completed_at: "2026-09-29T11:01:00Z" }] });
    expect((await f.baseline())?.sourceSha).toBe(descendant);
  });
  it("still prefers live identity when publication history is unavailable", async () => {
    const f = harness("alpha");
    f.deps.channelBaseline = async () => { throw new Error("private-github-error"); };
    expect((await disabledGuard([], f.candidate, f.deps)).blocked).toBe(true);
    f.deps.fetch = async input => String(input).endsWith("/zeros-deployment.json")
      ? Response.json({ version: 1, commitSha: f.candidate.sourceSha, surface: new URL(String(input)).hostname.startsWith("ops") ? "ops" : "app" })
      : Response.json({ version: 1, sourceSha: f.candidate.sourceSha, channel: "alpha", ready: true, maintenance: false,
        migrations: { state: "current", head: f.current.head, expectedHead: f.current.head, manifestSha256: f.current.sha256 },
        cloud: { enabled: false, ready: true, state: "disabled" }, worker: null });
    // Unknown history needs the completed cutover's own receipt, not identity alone.
    expect(await disabledGuard([], f.candidate, { ...f.deps, cutoverReceipt: async () => false })).toMatchObject({ blocked: true });
    const result = await disabledGuard([], f.candidate, { ...f.deps, cutoverReceipt: async () => true });
    expect(result).toMatchObject({ blocked: false, manualCutoverVerified: true });
    expect(result.message).not.toContain("private-github-error");
  });
});

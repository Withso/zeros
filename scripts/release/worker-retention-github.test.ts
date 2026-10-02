import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "./contracts";
import { retentionIntentKey, retentionRunTitle, type RetentionSubject } from "./worker-retention-resume";

const uploadDirectories: string[] = [];
afterEach(async () => { await Promise.all(uploadDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function fixture(channel: RetentionSubject["channel"] = "alpha") {
  const sourceSha = "a".repeat(40), repository = "example/zeros", now = Date.now(), timestamp = (offset: number) => new Date(now + offset).toISOString();
  const branch = channel === "alpha" ? "main" : "release/0.1.0";
  const subject: RetentionSubject = { repository, channel, sourceSha, branch, runId: "123", failedAttempt: "1", jobId: "456" };
  const workflow = channel === "production" ? "release.yml" : `release-${channel}.yml`;
  const identity = { full_name: repository, fork: false };
  const run: any = { id: 123, name: "Release", path: `.github/workflows/${workflow}`, event: channel === "production" ? "workflow_dispatch" : "push",
    repository: identity, head_repository: identity, head_sha: sourceSha, head_branch: branch, run_attempt: 1, status: "completed", conclusion: "failure", created_at: timestamp(-100_000) };
  const step = (name: string, conclusion = "success", offset = -90_000) => ({ name, conclusion, status: "completed", started_at: timestamp(offset), completed_at: timestamp(offset + 1000) });
  const job = (id: number, name: string, steps: any[], conclusion = "success") => ({ id, name, steps, run_id: 123, run_attempt: 1,
    head_sha: sourceSha, head_branch: branch, status: "completed", conclusion, started_at: timestamp(-95_000), completed_at: timestamp(-10_000) });
  const label = channel[0].toUpperCase() + channel.slice(1);
  const worker = job(456, `Hosted promotion (${channel}) / worker / worker`, [step("Exact-source Preflight and CodeQL gate"), step("Worker plan or guarded execution", "failure", -15_000)], "failure");
  const build = job(457, channel === "production" ? "Build + sign (macOS arm64)" : `Build + sign ${label} (macOS arm64 · NOT notarized)`,
    [step("Record the baked cloud capability"), step("Verify installer + updater signatures"), step(channel === "production" ? "Upload signed build artifact" : `Save signed ${label} artifacts`, "success", -80_000)]);
  const services = job(458, `Hosted promotion (${channel}) / Hosted services`, [step("Promote services and verify WorkOS"), step("Save services receipt", "success", -70_000)]);
  const approval = job(460, "Approve Production release", [step("Record the approved candidate")]);
  const jobs: any[] = [worker, build, services, job(459, "Exact-source Preflight and CodeQL barrier", [step("Run pnpm exec tsx scripts/release/ci-cli.ts --wait")]),
    ...(channel === "production" ? [approval] : [])];
  const attemptJobs: Record<string, any[]> = {};
  const receipt: any = { version: 1, status: "services-ready", channel, sourceSha, repository, branch, runId: "123", runAttempt: "1", cloudRequired: true,
    migration: { mode: "execute", database: `zeros-control-plane-${channel}`, branch: { name: "main", production: true }, backup: { id: "backup-synthetic", state: "success" },
      controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
    backend: { version: 1, ready: true, sourceSha, channel, maintenance: false, migrations: { state: "current", head: "0123_synthetic.sql", expectedHead: "0123_synthetic.sql", manifestSha256: "b".repeat(64) },
      cloud: { enabled: true, ready: true, state: "healthy" }, worker: null }, railwayDeploymentId: "synthetic-deployment",
    pages: (CHANNELS[channel].ops ? ["app", "ops"] : ["app"]).map(surface => ({ id: `page-${surface}`, surface })),
    workos: { kind: "workos-handshake-v1", surfaces: CHANNELS[channel].ops ? ["app", "ops"] : ["app"], verifiedAt: timestamp(-70_000) }, completedAt: timestamp(-70_000) };
  const archive = Buffer.from("synthetic exact artifact archive"), digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const artifact = (id: number, name: string, offset: number) => ({ id, name, expired: false, size_in_bytes: archive.length, digest, created_at: timestamp(offset), expires_at: timestamp(5 * 24 * 3600_000),
    workflow_run: { id: 123, head_sha: sourceSha } });
  const artifacts: any[] = [artifact(600, channel === "production" ? "zeros-macos-arm64-build" : `zeros-${channel}-arm64-build-${sourceSha}`, -79_500),
    artifact(601, `hosted-services-${channel}-${sourceSha}`, -69_500)];
  const observer: any = { ...run, id: 789, run_attempt: 1, path: ".github/workflows/worker-retention-resume.yml", event: "workflow_dispatch", status: "completed",
    display_title: retentionRunTitle(subject) };
  const observerJobs: any[] = [{ ...job(900, "Observe retained cleanup", [step("Observe exact native physical completion"), step("Persist rerun intent"), step("Request original failed worker once")]), run_id: observer.id }];
  const observerArtifacts: any[] = [];
  const observerRuns: any[] = [];
  const active: any[] = [];
  let currentSha = sourceSha, historyCount: number | undefined, postStatus = 201, responseLost = false;
  const fetcher = vi.fn(async (url: any, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(String(url)), route = target.pathname.replace(`/repos/${repository}`, "");
    if (init.method === "POST") { if (responseLost) throw new Error("lost"); return new Response(null, { status: postStatus }); }
    if (target.hostname === "fixture.blob.core.windows.net") return new Response(archive);
    if (/\/artifacts\/\d+\/zip$/.test(route)) return new Response(null, { status: 302, headers: { location: "https://fixture.blob.core.windows.net/artifact.zip" } });
    let value: any;
    if (route === "/actions/runs/123") value = run;
    else if (route === "/actions/runs/789") value = observer;
    else if (route === `/actions/workflows/${workflow}/runs`) value = { total_count: 1, workflow_runs: [run] };
    else if (/\/actions\/workflows\/(?:preflight|codeql)\.yml\/runs/.test(route)) {
      const file = route.includes("preflight") ? "preflight" : "codeql";
      value = { total_count: 1, workflow_runs: [{ ...run, id: file === "preflight" ? 800 : 801, path: `.github/workflows/${file}.yml`, name: file === "preflight" ? "Preflight" : "CodeQL", event: "push", conclusion: "success" }] };
    } else if (route === "/actions/workflows/worker-retention-resume.yml/runs") value = { total_count: historyCount ?? observerRuns.length, workflow_runs: observerRuns };
    else if (route === "/actions/runs") value = { total_count: active.length, workflow_runs: active };
    else if (/\/actions\/runs\/123\/(?:attempts\/\d+\/)?jobs$/.test(route)) {
      const records = attemptJobs[/\/attempts\/(\d+)\//.exec(route)?.[1] ?? ""] ?? jobs;
      value = { total_count: records.length, jobs: records };
    }
    else if (/\/actions\/runs\/789\/attempts\/\d+\/jobs$/.test(route)) value = { total_count: observerJobs.length, jobs: observerJobs };
    else if (route === "/actions/runs/123/artifacts") value = { total_count: artifacts.length, artifacts };
    else if (route === "/actions/runs/789/artifacts") value = { total_count: observerArtifacts.length, artifacts: observerArtifacts };
    else if (route === `/commits/${encodeURIComponent(branch)}` || decodeURIComponent(route) === `/commits/${branch}`) value = { sha: currentSha };
    else if (route === "/contents/.github/workflows/worker-retention-resume.yml") value = { type: "file", path: ".github/workflows/worker-retention-resume.yml", sha: "f".repeat(40), size: 500 };
    else throw new Error(`Unexpected local GitHub route: ${route}`);
    return new Response(JSON.stringify(value), { status: 200 });
  });
  const intent: any = { version: 1, kind: "original-worker-rerun-intent", subject, producer: { runId: "789", runAttempt: "1" }, metadataSha256: "a".repeat(64), cleanupSha256: "b".repeat(64),
    failedAt: Date.parse(worker.completed_at), completedAt: timestamp(-5000) };
  const command = vi.fn(async (_file: string, args: string[]) => args[0] === "-Z1" ? `${observerArtifacts.length ? "retention-intent.json" : "hosted-services.json"}\n`
    : JSON.stringify(observerArtifacts.length ? intent : receipt));
  const arm = () => { observerRuns.push(observer); observerArtifacts.push({ ...artifact(700, retentionIntentKey(subject), -89_500), workflow_run: { id: 789, head_sha: sourceSha } }); };
  return { subject, run, worker, build, services, approval, receipt, jobs, attemptJobs, artifacts, observer, observerJobs, observerArtifacts, observerRuns, active, fetcher, command, intent, arm,
    options: { fetch: fetcher as typeof fetch, command, now: () => now }, digest,
    supersede: () => { currentSha = "b".repeat(40); }, incomplete: () => { historyCount = observerRuns.length + 1; },
    refuse: () => { postStatus = 403; }, lose: () => { responseLost = true; } };
}

async function currentUploadFixture(change?: (value: any) => void) {
  const test = fixture(); test.arm(); test.observer.status = "in_progress"; test.observerJobs[0].status = "in_progress";
  const payload = structuredClone(test.intent); change?.(payload);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-worker-upload-")); uploadDirectories.push(directory);
  await writeFile(path.join(directory, "retention-intent.json"), JSON.stringify(payload), { mode: 0o600, flag: "wx" });
  let bytes = execFileSync("zip", ["-q", "-X", "-", "retention-intent.json"], { cwd: directory, maxBuffer: 128 * 1024 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  Object.assign(test.observerArtifacts[0], { size_in_bytes: bytes.length, digest: `sha256:${digest}` });
  let jobReads = 0, artifactReads = 0, delay: "step" | "artifact" | undefined, neverVisible = false;
  const fetcher = vi.fn(async (url: any, init: RequestInit = {}): Promise<Response> => {
    const target = new URL(String(url));
    if (target.hostname === "fixture.blob.core.windows.net") {
      expect(init.headers).toBeUndefined(); return new Response(bytes);
    }
    if (target.pathname === "/repos/example/zeros/actions/runs/789/attempts/1/jobs") {
      jobReads++;
      if (delay === "step" && (neverVisible || jobReads === 1)) {
        const jobs = structuredClone(test.observerJobs);
        Object.assign(jobs[0].steps[1], { status: "in_progress", conclusion: null, completed_at: null });
        return new Response(JSON.stringify({ total_count: jobs.length, jobs }));
      }
    }
    if (target.pathname === "/repos/example/zeros/actions/runs/789/artifacts") {
      artifactReads++;
      if (delay === "artifact" && (neverVisible || artifactReads === 1)) return new Response(JSON.stringify({ total_count: 0, artifacts: [] }));
    }
    return test.fetcher(url, init);
  });
  const sleep = vi.fn(async (_milliseconds: number) => {});
  return { ...test, acknowledged: { id: "700", digest }, fetcher,
    options: { ...test.options, fetch: fetcher as typeof fetch, command: undefined, sleep }, sleep,
    delay: (value: "step" | "artifact", forever = false) => { delay = value; neverVisible = forever; },
    corruptBytes: () => { bytes = Buffer.from("not the acknowledged ZIP"); }, reads: () => ({ jobs: jobReads, artifacts: artifactReads }) };
}

async function currentUploadRequest(test: Awaited<ReturnType<typeof currentUploadFixture>>) {
  const { retentionGithubClient } = await import("./worker-retention-github"), { requestRetentionResume } = await import("./worker-retention-resume");
  const client = retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic", GITHUB_RUN_ID: "789", GITHUB_RUN_ATTEMPT: "1" }, test.options);
  const markRequested = vi.fn(async () => {});
  const request = () => requestRetentionResume(test.intent, test.intent.producer, {
    inspect: async () => ({ sha256: test.intent.metadataSha256, failedAt: test.intent.failedAt }),
    completion: async () => ({ sha256: test.intent.cleanupSha256, completedAt: test.intent.completedAt }),
    assertIntentAvailable: client.assertIntentAvailable, verifyOwnIntent: intent => client.verifyOwnIntent(intent, test.acknowledged),
    markRequested, rerun: client.rerun });
  return { client, request, markRequested };
}

describe("authoritative retention GitHub metadata", () => {
  it.each(["alpha", "beta", "production"] as const)("authenticates the exact normal %s parent, native leaf and retained ancestors", async channel => {
    const test = fixture(channel), { retentionGithubClient } = await import("./worker-retention-github");
    const client = retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic-github" }, test.options);
    const proof = await client.inspect(test.subject);
    expect(proof.failedAt).toBe(Date.parse(test.worker.completed_at)); expect(proof.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
    expect(await client.originalWorker(test.subject, "1")).toEqual({ startedAt: Date.parse(test.worker.steps[1].started_at), finishedAt: Date.parse(test.worker.steps[1].completed_at) });
  });
  it.each([
    ["repository", (test: any) => { test.run.repository.full_name = "other/repository"; }],
    ["fork", (test: any) => { test.run.head_repository.fork = true; }],
    ["event", (test: any) => { test.run.event = "workflow_dispatch"; }],
    ["standalone worker", (test: any) => { test.run.path = ".github/workflows/cloud-worker-promotion.yml"; }],
    ["source", (test: any) => { test.run.head_sha = "b".repeat(40); }],
    ["attempt", (test: any) => { test.run.run_attempt = 2; }],
    ["wrong leaf", (test: any) => { test.worker.id = 999; }],
    ["worker no execution failure", (test: any) => { test.worker.steps[1].conclusion = "skipped"; }],
    ["another failure", (test: any) => { test.build.conclusion = "failure"; }],
    ["expired signed output", (test: any) => { test.artifacts[0].expired = true; }],
    ["build producer", (test: any) => { test.build.steps[2].conclusion = "failure"; }],
    ["unknown build attempt", (test: any) => { delete test.build.run_attempt; }],
    ["services producer", (test: any) => { test.services.steps[1].conclusion = "failure"; }],
    ["cloud-off services", (test: any) => { test.receipt.cloudRequired = false; }],
    ["absent cloud eligibility", (test: any) => { delete test.receipt.cloudRequired; }],
    ["supersession", (test: any) => { test.supersede(); }],
    ["active provision", (test: any) => { test.active.push({ ...test.run, id: 999, path: ".github/workflows/cloud-provision.yml", status: "queued" }); }],
    ["active release", (test: any) => { test.active.push({ ...test.run, id: 999, status: "waiting" }); }],
    ["unidentified active workflow", (test: any) => { test.active.push({ ...test.run, id: 999, path: undefined }); }],
    ["unknown active workflow", (test: any) => { test.active.push({ ...test.run, id: 999, path: ".github/workflows/unknown.yml" }); }],
    ["foreign active workflow", (test: any) => { test.active.push({ ...test.run, id: 999, path: ".github/workflows/preflight.yml", repository: { full_name: "other/repository", fork: false } }); }],
  ] as const)("rejects %s without dispatching", async (_label, change) => {
    const test = fixture(); change(test);
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options).inspect(test.subject)).rejects.toThrow();
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
  });
  it("requires actual original Production approval rather than another standalone gate", async () => {
    const test = fixture("production"); test.approval.steps[0].conclusion = "skipped";
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options).inspect(test.subject)).rejects.toThrow();
  });
  it("allows known read-only CI and its dedicated observer without sharing the mutation queue", async () => {
    const test = fixture();
    test.active.push(...["preflight", "codeql", "lint-ci", "scheduled", "uptime", "worker-retention-resume"].map((workflow, index) =>
      ({ ...test.run, id: 900 + index, path: `.github/workflows/${workflow}.yml`, status: "in_progress" })));
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options).inspect(test.subject)).resolves.toHaveProperty("sha256");
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
  });
  it.each(["alpha", "production"] as const)("retains older successful %s ancestors/approval at their recorded producing attempt", async channel => {
    const test = fixture(channel); test.run.run_attempt = 2; test.subject.failedAttempt = "2"; test.worker.run_attempt = 2;
    test.attemptJobs["1"] = test.jobs.filter(job => job !== test.worker); test.attemptJobs["2"] = [test.worker];
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options).inspect(test.subject)).resolves.toMatchObject({ failedAt: Date.parse(test.worker.completed_at) });
    expect(test.fetcher.mock.calls.some(([url]) => String(url).includes("/attempts/1/jobs"))).toBe(true);
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
  });
  it("fences a prior original-leaf intent, including refused or lost POST acknowledgement", async () => {
    const test = fixture(); test.arm();
    const { retentionGithubClient } = await import("./worker-retention-github");
    const client = retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options);
    await expect(client.assertIntentAvailable(test.subject)).rejects.toThrow("consumed");
    test.lose(); expect(await client.rerun(test.subject.jobId)).toBe("unconfirmed");
    await expect(client.assertIntentAvailable(test.subject)).rejects.toThrow("consumed");
    expect(test.fetcher.mock.calls.filter(([, input]) => input?.method === "POST")).toHaveLength(1);
  });
  it.each(["missing artifact", "wrong source", "wrong upload", "foreign title", "incomplete history", "observer rerun"])("keeps %s fenced", async reason => {
    const test = fixture(); test.arm();
    if (reason === "missing artifact") test.observerArtifacts.length = 0;
    if (reason === "wrong source") test.observer.head_sha = "b".repeat(40);
    if (reason === "wrong upload") test.observerJobs[0].steps[1].conclusion = "failure";
    if (reason === "foreign title") test.observer.display_title = "foreign";
    if (reason === "incomplete history") test.incomplete();
    if (reason === "observer rerun") test.observer.run_attempt = 2;
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options)
      .assertIntentAvailable(test.subject, reason === "observer rerun" ? { runId: "789", runAttempt: "2" } : undefined)).rejects.toThrow();
  });
  it("authenticates only the current exact producing attempt and uploaded artifact before arming", async () => {
    const test = fixture(); test.arm(); test.observer.status = "in_progress";
    const { retentionGithubClient } = await import("./worker-retention-github");
    const client = retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options);
    await expect(client.verifyOwnIntent(test.intent, { id: "700", digest: test.digest.slice(7) })).resolves.toBeUndefined();
    await expect(client.assertIntentAvailable(test.subject, test.intent.producer)).resolves.toBeUndefined();
    await expect(client.verifyOwnIntent(test.intent, { id: "701", digest: test.digest.slice(7) })).rejects.toThrow();
    await expect(client.verifyOwnIntent(test.intent, { id: "700", digest: "f".repeat(64) })).rejects.toThrow();
  });
  it("does not require an unstarted future upload step to be visible in its own active preparation", async () => {
    const test = fixture(); test.observerRuns.push(test.observer); test.observer.status = "in_progress";
    test.observerJobs[0].status = "in_progress"; test.observerJobs[0].steps = [{ name: "Observe exact native physical completion", status: "in_progress", conclusion: null }];
    const { retentionGithubClient } = await import("./worker-retention-github");
    await expect(retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic", GITHUB_RUN_ID: "789", GITHUB_RUN_ATTEMPT: "1" }, test.options)
      .assertIntentAvailable(test.subject)).resolves.toBeUndefined();
  });
  it("allows an unarmed prior observation but fences any interrupted upload, even without an artifact", async () => {
    const test = fixture(); test.observerRuns.push(test.observer); test.observerJobs[0].steps[1].conclusion = "skipped";
    const { retentionGithubClient } = await import("./worker-retention-github");
    const client = retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options);
    await expect(client.assertIntentAvailable(test.subject)).resolves.toBeUndefined();
    test.observerJobs[0].steps[1].conclusion = "cancelled";
    await expect(client.assertIntentAvailable(test.subject)).rejects.toThrow("uncertain");
  });
  it("uses only the specific failed job endpoint with debug disabled and never retries a refusal", async () => {
    const test = fixture(); test.refuse();
    const { retentionGithubClient } = await import("./worker-retention-github");
    expect(await retentionGithubClient(test.subject.repository, { GH_TOKEN: "synthetic" }, test.options).rerun(test.subject.jobId)).toBe("refused");
    const calls = test.fetcher.mock.calls.filter(([, input]) => input?.method === "POST");
    expect(calls).toHaveLength(1); expect(String(calls[0][0])).toBe("https://api.github.com/repos/example/zeros/actions/jobs/456/rerun");
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ enable_debug_logging: false, enable_debugger: false });
  });
});

describe("current acknowledged upload visibility", () => {
  it.each(["step", "artifact"] as const)("observes delayed %s through real ZIP verification before exactly one rerun", async delay => {
    const test = await currentUploadFixture(); test.delay(delay);
    const { request, markRequested } = await currentUploadRequest(test);
    await expect(request()).resolves.toBe("accepted");
    expect(test.reads()[delay === "step" ? "jobs" : "artifacts"]).toBeGreaterThan(1);
    expect(test.sleep).toHaveBeenCalledOnce(); expect(markRequested).toHaveBeenCalledOnce();
    expect(test.fetcher.mock.calls.filter(([, input]) => input?.method === "POST")).toHaveLength(1);
  });

  it.each(["step", "artifact"] as const)("bounds a never-visible %s and keeps the armed intent consumed with no POST", async delay => {
    const test = await currentUploadFixture(); test.delay(delay, true);
    const { client, request, markRequested } = await currentUploadRequest(test);
    await expect(request()).rejects.toThrow("bounded observation");
    expect(test.reads()[delay === "step" ? "jobs" : "artifacts"]).toBe(5); expect(test.sleep).toHaveBeenCalledTimes(4);
    expect(markRequested).not.toHaveBeenCalled(); expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
    test.observer.status = "completed";
    await expect(client.assertIntentAvailable(test.subject)).rejects.toThrow();
    expect(test.sleep).toHaveBeenCalledTimes(4);
  });

  it.each(["wrong artifact ID", "wrong artifact name", "wrong digest", "expired artifact", "expired lifetime", "foreign artifact", "foreign source", "foreign observer run", "prior observer attempt",
    "failed upload", "failed active upload", "missing upload", "unknown upload", "corrupt ZIP", "corrupt intent", "foreign producer", "bad upload time"])("rejects %s without visibility retry or POST", async reason => {
    const test = await currentUploadFixture(value => {
      if (reason === "corrupt intent") value.untrusted = true;
      if (reason === "foreign producer") value.producer.runId = "790";
    });
    if (reason === "wrong artifact ID") test.observerArtifacts[0].id = 701;
    if (reason === "wrong artifact name") test.observerArtifacts[0].name = "foreign-intent";
    if (reason === "wrong digest") test.observerArtifacts[0].digest = `sha256:${"f".repeat(64)}`;
    if (reason === "expired artifact") test.observerArtifacts[0].expired = true;
    if (reason === "expired lifetime") test.observerArtifacts[0].expires_at = new Date(test.options.now() - 1000).toISOString();
    if (reason === "foreign artifact") test.observerArtifacts[0].workflow_run.id = 790;
    if (reason === "foreign source") test.observer.head_sha = "f".repeat(40);
    if (reason === "foreign observer run") test.observer.id = 790;
    if (reason === "prior observer attempt") test.observer.run_attempt = 2;
    if (reason === "failed upload") test.observerJobs[0].steps[1].conclusion = "failure";
    if (reason === "failed active upload") Object.assign(test.observerJobs[0].steps[1], { status: "in_progress", conclusion: "failure" });
    if (reason === "missing upload") test.observerJobs[0].steps.splice(1, 1);
    if (reason === "unknown upload") test.observerJobs[0].steps[1].status = "unknown";
    if (reason === "corrupt ZIP") test.corruptBytes();
    if (reason === "bad upload time") test.observerArtifacts[0].created_at = new Date(test.options.now() - 100_000_000).toISOString();
    const { request, markRequested } = await currentUploadRequest(test);
    await expect(request()).rejects.toThrow(); expect(test.sleep).not.toHaveBeenCalled(); expect(markRequested).not.toHaveBeenCalled();
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
  });

  it("rejects known corrupt metadata even while the upload step is still becoming visible", async () => {
    const test = await currentUploadFixture(); test.delay("step"); test.observerArtifacts[0].digest = `sha256:${"f".repeat(64)}`;
    const { request, markRequested } = await currentUploadRequest(test);
    await expect(request()).rejects.toThrow(); expect(test.sleep).not.toHaveBeenCalled(); expect(markRequested).not.toHaveBeenCalled();
    expect(test.fetcher.mock.calls.every(([, input]) => input?.method !== "POST")).toBe(true);
  });
});

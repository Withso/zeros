import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CandidateSupersededError } from "./alpha-ci";
import { PromotionError } from "./contracts";
import { githubClient } from "./github";

const ancestor = "a".repeat(40), sourceSha = "b".repeat(40), descendant = "c".repeat(40), divergent = "d".repeat(40);
const candidate = { repository: "example/zeros", sourceSha, branch: "main" };
const parent = { id: 300, run_attempt: 1, name: "Release (alpha)", path: ".github/workflows/release-alpha.yml",
  head_sha: sourceSha, head_branch: "main", event: "push", status: "in_progress", conclusion: null,
  repository: { full_name: candidate.repository }, head_repository: { full_name: candidate.repository } };
const env: NodeJS.ProcessEnv = { RELEASE_CHANNEL: "alpha", RELEASE_SHA: sourceSha, GITHUB_SHA: sourceSha,
  GITHUB_REPOSITORY: candidate.repository, GITHUB_RUN_ID: "300", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "services",
  GITHUB_WORKFLOW_REF: `${candidate.repository}/.github/workflows/release-alpha.yml@refs/heads/main`,
  ZEROS_ALPHA_CI_FAST_PATH: "enabled", ZEROS_ALPHA_FORWARD_ONLY: "admitted" };

function fixture(overrides: NodeJS.ProcessEnv = {}, source: Partial<typeof candidate> = {}) {
  const state = {
    head: sourceSha as string, api: ancestor as string, app: ancestor as string, ops: ancestor as string,
    tag: ancestor as string, ledger: ancestor as string, worker: null as any,
    identityStatus: 200, maintenance: false, schemaAhead: false, compareError: false,
    comparison: undefined as any, ledgerStatus: 200, tagType: "commit", parent: { ...parent },
    unreadable: "", ledgerValue: undefined as any,
    artifactPresent: true, artifactExpired: false,
    admission: { version: 1, channel: "alpha", sourceSha, repository: candidate.repository, branch: "main",
      runId: "300", runAttempt: "1", mode: "admitted" },
    jobs: [{ run_id: 300, run_attempt: 1, head_sha: sourceSha, head_branch: "main",
      name: "Exact-source Preflight and CodeQL barrier", status: "completed", conclusion: "success",
      steps: ["Wait for exact-source Alpha CI", "Save Alpha admission receipt"].map(name => ({ name, status: "completed", conclusion: "success" })) }],
  };
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)), route = url.pathname.replace(`/repos/${candidate.repository}`, "");
    requests.push(`${url.origin}${route}${url.search}`);
    expect(init?.method ?? "GET").toBe("GET");
    if (route === "/commits/main" || route.startsWith("/commits/release")) return Response.json({ sha: state.head });
    if (route === "/actions/runs/300") return Response.json(state.parent);
    if (route === "/actions/runs/300/artifacts") {
      const artifacts = state.artifactPresent ? [{ name: `alpha-admission-${sourceSha}`, expired: state.artifactExpired,
        workflow_run: { head_sha: sourceSha } }] : [];
      return Response.json({ total_count: artifacts.length, artifacts });
    }
    if (route === "/actions/runs/300/attempts/1/jobs") return Response.json({ total_count: state.jobs.length, jobs: state.jobs });
    if (route.startsWith("/compare/")) {
      if (state.compareError) return Response.json({}, { status: 403 });
      const [base, head] = route.slice("/compare/".length).split("...");
      const order = [ancestor, sourceSha, descendant];
      const status = base === head ? "identical" : order.includes(base) && order.includes(head)
        ? order.indexOf(base) < order.indexOf(head) ? "ahead" : "behind" : "diverged";
      return Response.json(state.comparison ?? { status, base_commit: { sha: base },
        merge_base_commit: { sha: status === "ahead" || status === "identical" ? base : ancestor } });
    }
    if (route === "/v1/release-identity") return Response.json({ version: 1, ready: true, channel: "alpha", sourceSha: state.api,
      maintenance: state.maintenance, migrations: { state: "current", head: state.schemaAhead ? "0002_fixture.sql" : "0001_fixture.sql",
        expectedHead: "0001_fixture.sql", manifestSha256: "e".repeat(64) },
      cloud: { enabled: state.worker !== null, ready: true, state: state.worker ? "healthy" : "disabled" }, worker: state.worker,
    }, { status: state.unreadable === "api" ? 503 : state.identityStatus });
    if (route === "/zeros-deployment.json") {
      const surface = url.hostname.startsWith("ops-") ? "ops" : "app";
      return Response.json({ version: 1, surface, commitSha: state[surface] }, { status: state.unreadable === surface ? 404 : 200 });
    }
    if (route === "/git/ref/tags/alpha") return Response.json({ ref: "refs/tags/alpha", object: { type: state.tagType, sha: state.tag } },
      { status: state.unreadable === "tag" ? 403 : 200 });
    if (route === `/git/tags/${state.tag}`) return Response.json({ object: { type: "commit", sha: ancestor } });
    if (route === "/releases/tags/alpha") return Response.json({ draft: false, prerelease: true, tag_name: "alpha",
      assets: [{ name: "alpha-release-ledger.json", browser_download_url: `https://github.com/${candidate.repository}/releases/download/alpha/alpha-release-ledger.json` }] });
    if (url.hostname === "github.com") return Response.json(state.ledgerValue ?? { version: 1, channel: "alpha", releases: [
      { version: "0.1.0-alpha.1", publishedAt: "2026-10-01T00:00:00.000Z", sourceSha: state.ledger },
    ] }, { status: state.unreadable === "ledger" ? 404 : state.ledgerStatus });
    const workflow = /\/actions\/workflows\/(preflight|codeql)\.yml\/runs/.exec(route);
    if (workflow) {
      const isPreflight = workflow[1] === "preflight";
      return Response.json({ total_count: 1, workflow_runs: [{ ...parent, id: isPreflight ? 100 : 101,
        name: isPreflight ? "Preflight" : "CodeQL", path: `.github/workflows/${workflow[1]}.yml`,
        status: isPreflight ? "in_progress" : "completed", conclusion: isPreflight ? null : "success" }] });
    }
    if (route === "/actions/runs/100/attempts/1/jobs") return Response.json({ total_count: 1, jobs: [
      { run_id: 100, run_attempt: 1, head_sha: sourceSha, head_branch: "main", name: "alpha-gate", status: "completed", conclusion: "success" },
    ] });
    if (route === "/actions/runs/100") return Response.json({ ...parent, id: 100, name: "Preflight", path: ".github/workflows/preflight.yml" });
    throw new Error(`Unexpected synthetic forward-only request: ${url.origin}${route}`);
  });
  const command = vi.fn(async (file: string, args: string[]) => {
    expect(file).toBe("gh"); expect(args.slice(0, 3)).toEqual(["run", "download", "300"]);
    await writeFile(path.join(args[args.indexOf("--dir") + 1], "alpha-admission.json"), JSON.stringify(state.admission));
    return "";
  });
  return { state, requests, command, fetcher, client: githubClient({ ...candidate, ...source }, { ...env, ...overrides }, { fetch: fetcher, command }) };
}

describe("automatic Alpha admitted freshness", () => {
  it.each(["admitted", "enabled"])("continues an admitted candidate as main advances with %s", async flag => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: flag });
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    test.state.head = descendant;
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    expect(test.requests).toContain(`https://api.github.com/compare/${sourceSha}...${descendant}`);
    expect(test.command).toHaveBeenCalledOnce();
  });

  it("keeps Stage 1 admission strict even when the same parent has an older successful barrier", async () => {
    const test = fixture({ GITHUB_JOB: "ci" }); test.state.head = descendant;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(CandidateSupersededError);
    expect(test.command).not.toHaveBeenCalled();
  });

  it.each(["guard", "services", "worker", "promote", "publish", "runtime-publish"])(
    "allows descendant main advancement at the automatic %s checkpoint", async job => {
      const test = fixture({ GITHUB_JOB: job }); test.state.head = descendant;
      await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    });

  it("accepts an authenticated earlier admission attempt on a desktop-only retry", async () => {
    const test = fixture({ GITHUB_RUN_ATTEMPT: "2", GITHUB_JOB: "publish" });
    test.state.parent.run_attempt = 2; test.state.head = descendant;
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    expect(test.requests).toContain("https://api.github.com/actions/runs/300/attempts/1/jobs?per_page=100&page=1");
  });

  it.each([ancestor, divergent])("fails red when rewritten main %s no longer contains the admitted source", async head => {
    const test = fixture(); test.state.head = head;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
    await expect(test.client.assertCurrent()).rejects.not.toBeInstanceOf(CandidateSupersededError);
  });

  it.each(["missing", "expired", "wrong source", "wrong run", "future attempt", "skipped upload", "failed barrier"])(
    "refuses %s admission proof before relaxing freshness", async failure => {
      const test = fixture(); test.state.head = descendant;
      if (failure === "missing") test.state.artifactPresent = false;
      if (failure === "expired") test.state.artifactExpired = true;
      if (failure === "wrong source") test.state.admission.sourceSha = ancestor;
      if (failure === "wrong run") test.state.admission.runId = "299";
      if (failure === "future attempt") test.state.admission.runAttempt = "2";
      if (failure === "skipped upload") test.state.jobs[0].steps[1].conclusion = "skipped";
      if (failure === "failed barrier") test.state.jobs[0].conclusion = "failure";
      await expect(test.client.assertCurrent()).rejects.toThrow(/admission/i);
    });

  it("keeps the nested worker on Alpha fast evidence and admitted ancestry", async () => {
    const test = fixture({ GITHUB_JOB: "worker" }); test.state.head = descendant;
    await expect(test.client.assertRequiredChecks()).resolves.toBeUndefined();
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    expect(test.requests.some(route => route.includes("head_sha=") && route.includes("event=push"))).toBe(true);
  });

  it("fails red on unavailable ancestry without leaking the response", async () => {
    const test = fixture(); test.state.head = descendant; test.state.compareError = true;
    const error = await test.client.assertCurrent().catch(error => error);
    expect(error).toBeInstanceOf(PromotionError);
    expect(error).not.toBeInstanceOf(CandidateSupersededError);
  });
});

describe("Stage 2 automatic Alpha admission", () => {
  const destinations = ["api", "app", "ops", "tag", "ledger"] as const;
  it.each(destinations)("accepts equal and ancestor %s sources before admission", async destination => {
    for (const sha of [sourceSha, ancestor]) {
      const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" }); test.state.head = descendant;
      test.state[destination] = sha;
      if (destination === "tag") test.state.ledger = sha;
      if (destination === "ledger") test.state.tag = sha;
      await expect(test.client.assertCurrent()).resolves.toBeUndefined();
      expect(test.command).not.toHaveBeenCalled();
    }
  });

  it.each(destinations)("refuses descendant, divergent and malformed %s sources", async destination => {
    for (const sha of [descendant, divergent, "invalid"]) {
      const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" }); test.state.head = descendant;
      test.state[destination] = sha;
      await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
    }
  });

  it.each(destinations)("refuses unreadable %s identity without optimistic admission", async destination => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" });
    test.state.unreadable = destination;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
  });

  it("peels annotated Alpha tags and refuses non-commit tag targets", async () => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" });
    test.state.tagType = "tag";
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    test.state.tagType = "tree";
    await expect(test.client.assertCurrent()).rejects.toThrow(/tag/);
  });

  it.each(["empty", "wrong channel", "invalid version", "duplicate version"])("refuses a %s feed ledger", async failure => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" });
    const entry = { sourceSha: ancestor, publishedAt: "2026-10-01T00:00:00.000Z", version: "0.1.0-alpha.1" };
    test.state.ledgerValue = { version: 1, channel: failure === "wrong channel" ? "beta" : "alpha", releases:
      failure === "empty" ? [] : failure === "duplicate version" ? [entry, entry] : [{ ...entry, version: failure === "invalid version" ? "unknown" : entry.version }] };
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
  });

  it.each(["API unavailable", "maintenance", "schema ahead", "ledger unavailable", "tag/ledger disagreement"])(
    "refuses %s before a migration role may be planned", async failure => {
      const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" });
      if (failure === "API unavailable") test.state.identityStatus = 503;
      if (failure === "maintenance") test.state.maintenance = true;
      if (failure === "schema ahead") test.state.schemaAhead = true;
      if (failure === "ledger unavailable") test.state.ledgerStatus = 404;
      if (failure === "tag/ledger disagreement") test.state.tag = sourceSha;
      await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
    });

  it("re-reads every live destination after admission and stops when a newer source owns Pages", async () => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled" }); test.state.head = descendant;
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    test.state.ops = descendant;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
    expect(test.requests.filter(route => route === "https://ops-alpha.zeros.build/zeros-deployment.json")).toHaveLength(2);
  });

  it("allows its parallel desktop publisher to advance the ledger before the tag", async () => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "runtime-publish" });
    test.state.head = descendant; test.state.ledger = sourceSha;
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    test.state.ledger = descendant;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
  });

  it("refuses a newer live worker while preserving the explicit cloud-disabled null identity", async () => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled", GITHUB_JOB: "ci" });
    await expect(test.client.assertCurrent()).resolves.toBeUndefined();
    test.state.worker = { provider: "boat", imageRef: `boat:fixture@sha256:${"e".repeat(64)}`, sourceSha: descendant,
      architecture: "linux/amd64", storageMiB: 4096 };
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(PromotionError);
  });
});

describe("forward-only channel and operation invariance", () => {
  it.each([undefined, "", "disabled", "observe", "true", "ENABLED", "other"])("keeps flag %s strict", async flag => {
    const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: flag }); test.state.head = descendant;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(CandidateSupersededError);
    expect(test.requests).toEqual(["https://api.github.com/commits/main"]);
  });

  it.each(["beta", "production"])("keeps %s strict with both Alpha flags enabled", async channel => {
    const test = fixture({ RELEASE_CHANNEL: channel, ZEROS_ALPHA_FORWARD_ONLY: "enabled" }, { branch: "release/1.2.3" }); test.state.head = descendant;
    await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(CandidateSupersededError);
    await expect(test.client.assertRequiredChecks()).rejects.toThrow();
    expect(test.requests.some(route => route.includes("compare") || route.includes("/actions/runs/300"))).toBe(false);
  });

  it("does not select fast CI merely because forward-only freshness is enabled", async () => {
    const test = fixture({ ZEROS_ALPHA_CI_FAST_PATH: "", ZEROS_ALPHA_FORWARD_ONLY: "enabled" });
    await expect(test.client.assertRequiredChecks()).rejects.toThrow();
    expect(test.requests).toHaveLength(2);
    expect(test.requests.every(route => route.includes("/actions/workflows/") && !route.includes("event=push"))).toBe(true);
  });

  it.each(["cloud-worker-promotion", "controlled-cutover", "staff-owner-bootstrap", "manual-alpha"])(
    "keeps %s strict even with forged opt-in flags", async workflow => {
      const test = fixture({ ZEROS_ALPHA_FORWARD_ONLY: "enabled" }); test.state.head = descendant;
      test.state.parent.path = `.github/workflows/${workflow}.yml`;
      await expect(test.client.assertCurrent()).rejects.toBeInstanceOf(CandidateSupersededError);
      expect(test.requests.some(route => route.includes("compare") || route.includes("artifacts"))).toBe(false);
    });
});

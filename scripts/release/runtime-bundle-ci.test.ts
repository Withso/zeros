import { describe, expect, it, vi } from "vitest";
import { releaseSource } from "./contracts";
import { runtimeBundleSource, verifyRuntimeBundleCI } from "./runtime-bundle-ci";

const sha = "a".repeat(40), repository = "example/zeros";
const env = (channel: string, ref = "refs/heads/main"): NodeJS.ProcessEnv => ({
  RELEASE_CHANNEL: channel, RELEASE_SHA: sha, RELEASE_BRANCH: ref.slice("refs/heads/".length),
  GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/cloud-runtime-bundle.yml@${ref}`,
  GH_TOKEN: "synthetic-read-token",
});

function fixture(environment = env("alpha")) {
  const state = { head: sha, conclusion: "success", checkout: sha };
  const requests: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    if (url.includes("/commits/")) return Response.json({ sha: state.head });
    const codeql = url.includes("codeql.yml"), file = codeql ? "codeql.yml" : "preflight.yml";
    const run = { id: codeql ? 101 : 100, run_attempt: 1, name: codeql ? "CodeQL" : "Preflight",
      path: `.github/workflows/${file}`, head_sha: sha, event: "push", status: "completed", conclusion: state.conclusion,
      repository: { full_name: repository }, head_repository: { full_name: repository } };
    return Response.json({ total_count: 1, workflow_runs: [run] });
  });
  const command = vi.fn(async () => state.checkout);
  return { environment, state, requests, fetcher, command };
}

describe("standalone runtime-bundle exact-source CI", () => {
  it.each([
    ["alpha", "refs/heads/main"], ["beta", "refs/heads/main"], ["beta", "refs/heads/release/1.2.3"],
    ["production", "refs/heads/main"], ["production", "refs/heads/release/1.2.3"],
  ])("checks both latest exact-SHA workflows and branch freshness for %s at %s", async (channel, ref) => {
    const test = fixture(env(channel, ref));
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command }))
      .resolves.toBeUndefined();
    expect(test.command).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"]);
    expect(test.requests).toHaveLength(3);
    expect(test.requests.filter(url => url.includes(`/actions/workflows/`) && url.includes(`head_sha=${sha}`))).toHaveLength(2);
    expect(test.requests.some(url => url.includes(`/commits/${encodeURIComponent(ref.slice("refs/heads/".length))}`))).toBe(true);
    expect(test.requests.every(url => !url.includes("status=success") && !url.includes("synthetic-read-token"))).toBe(true);
  });

  it.each([
    { RELEASE_CHANNEL: "other" },
    { GITHUB_REF: "refs/heads/feature", RELEASE_BRANCH: "feature" },
    { GITHUB_REF: "refs/heads/release/1.2.3", RELEASE_BRANCH: "release/1.2.3" },
    { GITHUB_REF: "refs/heads/release/", RELEASE_BRANCH: "release/" },
    { GITHUB_REF: "refs/tags/v1.2.3" },
    { GITHUB_REPOSITORY: "fork/zeros" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/other.yml@refs/heads/main` },
    { GITHUB_SHA: "b".repeat(40) },
    { RELEASE_SHA: "invalid" },
    { RELEASE_BRANCH: "other" },
  ])("refuses a foreign channel, ref or workflow identity before network access: %j", async changed => {
    const test = fixture({ ...env("alpha"), ...changed });
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).rejects.toThrow();
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.command).not.toHaveBeenCalled();
  });

  it("keeps desktop release branch requirements unchanged", () => {
    expect(runtimeBundleSource(env("production"))).toMatchObject({ channel: "production", branch: "main", sourceSha: sha });
    expect(() => releaseSource(env("production"))).toThrow(/branch/);
  });

  it("cannot use automatic Alpha fast or admitted paths from the manual workflow", async () => {
    const test = fixture({ ...env("alpha"), ZEROS_ALPHA_CI_FAST_PATH: "enabled", ZEROS_ALPHA_FORWARD_ONLY: "admitted" });
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).resolves.toBeUndefined();
    expect(test.requests.filter(url => url.includes("/actions/workflows/"))).toHaveLength(2);
    test.state.head = "b".repeat(40);
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).rejects.toThrow(/superseded/i);
  });

  it("refuses a checkout that differs from the dispatched source before CI queries", async () => {
    const test = fixture(); test.state.checkout = "b".repeat(40);
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).rejects.toThrow(/checkout/);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it("requires successful current exact-source CI and an unchanged branch head", async () => {
    const test = fixture(); test.state.conclusion = "failure";
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).rejects.toThrow(/Preflight and CodeQL/);
    test.state.conclusion = "success"; test.state.head = "b".repeat(40);
    await expect(verifyRuntimeBundleCI(test.environment, { fetch: test.fetcher as typeof fetch, command: test.command })).rejects.toThrow(/superseded/i);
  });
});

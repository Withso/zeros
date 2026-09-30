import { describe, expect, it } from "vitest";
import { assertRequiredCI, requiredCIEvidence, waitForRequiredCI } from "./ci";
import { githubClient } from "./github";

const candidate = { repository: "example/zeros", sourceSha: "a".repeat(40), branch: "main" };
const run = { id: 100, run_attempt: 1, name: "Preflight", path: ".github/workflows/preflight.yml", head_sha: candidate.sourceSha,
  repository: { full_name: candidate.repository }, head_repository: { full_name: candidate.repository }, event: "push", status: "completed", conclusion: "success" };
const evidence = (runs: unknown[]) => requiredCIEvidence(candidate, "preflight.yml", "Preflight", { total_count: runs.length, workflow_runs: runs });
const codeql = { workflow: "CodeQL", runId: 101, attempt: 1, succeeded: true };

describe("exact-source required CI barrier", () => {
  it("never treats another SHA, repository, workflow or untrusted event as proof", () => {
    for (const change of [{ head_sha: "b".repeat(40) }, { repository: { full_name: "fork/zeros" } },
      { head_repository: { full_name: "fork/zeros" } }, { path: ".github/workflows/other.yml" }, { name: "Other" },
      { event: "schedule" }, { event: "workflow_dispatch" }, { id: 0 }, { run_attempt: 0 }]) {
      expect(evidence([{ ...run, ...change }]).succeeded).toBe(false);
    }
  });
  it("a prior success cannot override a newer pending or failed run", () => {
    expect(evidence([run, { ...run, id: 102, conclusion: "failure" }]).succeeded).toBe(false);
    expect(evidence([run, { ...run, id: 102, status: "in_progress", conclusion: null }]).succeeded).toBe(false);
  });
  it("waits through an initial Preflight failure and releases after its successful rerun", async () => {
    let reads = 0;
    const result = await waitForRequiredCI(async () => {
      reads++;
      return [evidence([{ ...run, run_attempt: reads, conclusion: reads === 1 ? "failure" : "success" }]), codeql];
    }, { attempts: 3, sleep: async () => {} });
    expect(reads).toBe(2); expect(result[0].attempt).toBe(2); expect(() => assertRequiredCI(result)).not.toThrow();
  });
  it("fails closed when either required workflow is missing or unsuccessful", async () => {
    expect(() => assertRequiredCI([evidence([run])])).toThrow(/Preflight and CodeQL/);
    await expect(waitForRequiredCI(async () => [evidence([{ ...run, conclusion: "failure" }]), codeql], { attempts: 2, sleep: async () => {} })).rejects.toThrow(/timed out/);
    expect(() => evidence(Array.from({ length: 101 }, () => run))).toThrow(/bound/);
  });
  it("a fresh release rerun accepts a later successful exact-SHA CI attempt without cached failure", async () => {
    let latest = { ...run, conclusion: "failure" };
    const read = async () => [evidence([latest]), codeql];
    await expect(waitForRequiredCI(read, { attempts: 1, sleep: async () => {} })).rejects.toThrow(/timed out/);
    latest = { ...run, run_attempt: 2, conclusion: "success" };
    const result = await waitForRequiredCI(read, { attempts: 1, sleep: async () => {} });
    expect(() => assertRequiredCI(result)).not.toThrow();
    expect(result[0].attempt).toBe(2);
  });
  it("queries all current attempts at the exact commit, not success-filtered history", async () => {
    const requests: string[] = [];
    const client = githubClient(candidate, { GH_TOKEN: "fake-token" }, { fetch: async (url, init) => {
      requests.push(String(url));
      expect(init?.method ?? "GET").toBe("GET");
      const codeQL = String(url).includes("codeql.yml");
      return Response.json({ total_count: 1, workflow_runs: [{ ...run, ...(codeQL ? { name: "CodeQL", path: ".github/workflows/codeql.yml" } : {}) }] });
    } });
    await expect(client.assertRequiredChecks()).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.includes(`head_sha=${candidate.sourceSha}`) && !url.includes("status=success") && !url.includes("fake-token"))).toBe(true);
  });
});

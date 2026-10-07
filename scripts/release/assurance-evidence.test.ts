import { describe, expect, it } from "vitest";
import { alphaRequiredChecks } from "./alpha-ci";
import { requiredCIEvidence } from "./ci";

const candidate = { repository: "example/zeros", branch: "main", sourceSha: "a".repeat(40) };
const canonical = {
  id: 100, run_attempt: 1, name: "Preflight", path: ".github/workflows/preflight.yml",
  head_sha: candidate.sourceSha, head_branch: "main", event: "push",
  status: "completed", conclusion: "success",
  repository: { full_name: candidate.repository }, head_repository: { full_name: candidate.repository },
};

describe("full PR assurance is never release evidence", () => {
  it.each([
    { name: "Full CI", path: ".github/workflows/ci-full.yml", event: "pull_request" },
    { name: "Full CI", path: ".github/workflows/ci-full.yml", event: "push" },
    { name: "Preflight", path: ".github/workflows/ci-full.yml", event: "push" },
    { name: "Full CI", path: ".github/workflows/preflight.yml", event: "push" },
  ])("rejects $name from $path on $event even at the exact candidate SHA", async (identity) => {
    const response = { total_count: 1, workflow_runs: [{ ...canonical, ...identity }] };
    expect(requiredCIEvidence(candidate, "preflight.yml", "Preflight", response).succeeded).toBe(false);
    const evidence = await alphaRequiredChecks(candidate, async (route) => {
      expect(route).toContain("/actions/workflows/preflight.yml/runs?");
      return response;
    });
    expect(evidence.every((item) => !item.succeeded)).toBe(true);
  });

  it("retains canonical direct Preflight as full-release proof", () => {
    expect(requiredCIEvidence(candidate, "preflight.yml", "Preflight", {
      total_count: 1, workflow_runs: [canonical],
    }).succeeded).toBe(true);
  });
});

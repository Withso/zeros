import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  name?: string;
  environment?: string;
  permissions: Record<string, string>;
  needs?: string | string[];
  steps: Step[];
};
const read = (file: string) => readFileSync(file, "utf8");

describe("CI Recovery authority", () => {
  const source = read(".github/workflows/ci-recovery.yml");
  const workflow = load(source) as {
    name: string;
    on: Record<string, unknown>;
    permissions: Record<string, unknown>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<string, Job>;
  };

  it("observes only canonical main Preflight and periodically reconciles", () => {
    expect(workflow.name).toBe("CI Recovery");
    expect(workflow.on).toEqual({
      workflow_run: {
        workflows: ["Preflight"],
        types: ["completed"],
        branches: ["main"],
      },
      schedule: [{ cron: "*/15 * * * *" }],
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: "ci-recovery",
      "cancel-in-progress": false,
    });
    expect(source).not.toMatch(
      /pull_request_target|workflow_dispatch|release\//,
    );
  });

  it("keeps reads, retries and App writes in separate jobs", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "inspect",
      "retry",
      "upsert",
      "resolve",
    ]);
    const readPermissions = {
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    };
    expect(workflow.jobs.inspect.permissions).toEqual(readPermissions);
    expect(workflow.jobs.retry.permissions).toEqual({
      actions: "write",
      contents: "read",
    });
    for (const id of ["upsert", "resolve"]) {
      expect(workflow.jobs[id].permissions).toEqual(readPermissions);
      expect(workflow.jobs[id].environment).toBe("ci-automation");
    }
    expect(workflow.jobs.inspect.environment).toBeUndefined();
    expect(workflow.jobs.retry.environment).toBeUndefined();
  });

  it("references the isolated App key only in protected writer jobs", () => {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const tokenSteps = job.steps.filter((step) =>
        step.uses?.startsWith("actions/create-github-app-token@"),
      );
      expect(tokenSteps).toHaveLength(
        ["upsert", "resolve"].includes(id) ? 1 : 0,
      );
      for (const step of tokenSteps) {
        expect(step.uses).toBe(
          "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
        );
        expect(step.with).toEqual({
          "client-id": "${{ vars.ZEROS_CI_INCIDENT_APP_CLIENT_ID }}",
          "private-key": "${{ secrets.ZEROS_CI_INCIDENT_APP_PRIVATE_KEY }}",
          owner: "Withso",
          repositories: "zeros",
          "permission-contents": "write",
          "permission-pull-requests": "write",
        });
      }
      if (!["upsert", "resolve"].includes(id))
        expect(JSON.stringify(job)).not.toContain("secrets.");
    }
    expect(
      source.match(/secrets\.ZEROS_CI_INCIDENT_APP_PRIVATE_KEY/g),
    ).toHaveLength(2);
    expect(source).not.toMatch(
      /ZEROS_AGENT|permission-(actions|checks|workflows|administration):/,
    );
  });

  it("checks out immutable default-branch controller code without source installs or caches", () => {
    for (const job of Object.values(workflow.jobs)) {
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout?.with).toEqual({
        ref: "${{ github.sha }}",
        "persist-credentials": false,
      });
      for (const step of job.steps) {
        if (step.uses && !step.uses.startsWith("./"))
          expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
        expect(step.run ?? "").not.toContain("${{");
        expect(step.run ?? "").not.toMatch(/pnpm install|npm ci|eval |source /);
        expect(JSON.stringify(step)).not.toMatch(/head_sha|cache:/);
      }
    }
  });

  it("reserves side effects and serializes retry, upsert and resolution phases", () => {
    expect(workflow.jobs.upsert.needs).toEqual(["inspect", "retry"]);
    expect(workflow.jobs.resolve.needs).toEqual(["inspect", "retry", "upsert"]);
    for (const id of ["retry", "upsert", "resolve"]) {
      const steps = workflow.jobs[id].steps;
      const save = steps.findIndex(
        (step) => step.name === "Save recovery reservation",
      );
      const write = steps.findIndex(
        (step) => step.name === "Apply recovery decision",
      );
      expect(save).toBeGreaterThan(-1);
      expect(write).toBeGreaterThan(save);
      expect(steps[save].with?.["if-no-files-found"]).toBe("error");
      expect(steps[write].env?.ZEROS_CI_RECOVERY).toBe(
        "${{ vars.ZEROS_CI_RECOVERY || 'off' }}",
      );
    }
  });

  it("rejects PR markers without changing Preflight or required check names", () => {
    const ci = load(read(".github/workflows/ci.yml")) as {
      jobs: Record<string, Job>;
    };
    const guard = ci.jobs.quality.steps.find(
      (step) => step.name === "Reject unresolved CI incident markers",
    );
    expect(guard?.if).toBe("github.event_name == 'pull_request'");
    expect(guard?.run).toBe("node scripts/ci/recovery.mjs guard-markers");
    expect(read(".github/workflows/preflight.yml")).not.toContain(
      "guard-markers",
    );
    expect(read("scripts/__tests__/ci-workflow-parity.test.ts")).toContain(
      '"Reject unresolved CI incident markers"',
    );
  });
});

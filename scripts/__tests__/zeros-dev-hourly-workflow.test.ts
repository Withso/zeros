import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml") as { load(input: string): unknown };

describe("hourly fixture workflow authority", () => {
  it("refreshes the required status from trusted main on PR, canary and freshness events without product secrets", () => {
    const workflow = load(readFileSync(".github/workflows/zeros-dev-e2e-gate.yml", "utf8")) as any;
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request_target", "schedule", "workflow_dispatch", "workflow_run"]);
    expect(workflow.on.workflow_run).toEqual({ workflows: ["Zeros dev E2E"], branches: ["main"], types: ["requested", "completed"] });
    expect(workflow.concurrency).toEqual({ group: "zeros-dev-merge-gate", "cancel-in-progress": false });
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read", statuses: "write" });
    const steps = workflow.jobs.refresh.steps;
    expect(steps[0].with).toEqual({ ref: "refs/heads/main", "persist-credentials": false });
    expect(steps.at(-1).env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(steps.at(-1).run).toBe("node scripts/ci/zeros-dev-status.mjs");
    expect(JSON.stringify(workflow)).not.toContain("secrets.");
    expect(JSON.stringify(workflow)).not.toContain("pull_request.head");
  });
  it("runs only main on Linux, serializes one fixture, and reserves fifteen minutes for one build and lifecycle", () => {
    const workflow = load(readFileSync(".github/workflows/zeros-dev-e2e.yml", "utf8")) as any;
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule).toEqual([{ cron: "23 * * * *" }]);
    expect(workflow.concurrency).toEqual({ group: "zeros-dev-alpha-fixture", "cancel-in-progress": false });
    const job = workflow.jobs.lifecycle;
    expect(Object.keys(workflow.jobs)).toEqual(["lifecycle"]);
    expect(job["runs-on"]).toBe("ubuntu-24.04"); expect(job["timeout-minutes"]).toBe("${{ inputs.profile == 'gate0' && 135 || ((inputs.profile == 'infrastructure' || (github.event_name == 'schedule' && vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true')) && 65 || 15) }}");
    expect(job.if).toContain("github.ref == 'refs/heads/main'"); expect(job.if).toContain("github.repository == 'Withso/zeros'");
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
  });
  it("admits a separate owner-enabled manual Gate 0 profile under the same fixture lock", () => {
    const workflow = load(readFileSync(".github/workflows/zeros-dev-e2e.yml", "utf8")) as any;
    expect(workflow.on.workflow_dispatch.inputs.profile).toEqual({ description: "Hourly agents, full Gate 0, or infrastructure only", type: "choice", required: true,
      default: "infrastructure", options: ["hourly", "gate0", "infrastructure"] });
    const job = workflow.jobs.lifecycle;
    expect(job.name).toBe("${{ (inputs.profile == 'infrastructure' || (github.event_name == 'schedule' && vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true')) && 'infrastructure' || (inputs.profile == 'gate0' && 'gate0' || 'lifecycle') }}");
    expect(job.env.ZEROS_DEV_PROFILE).toBe("${{ github.event_name == 'schedule' && vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true' && 'infrastructure' || inputs.profile || 'hourly' }}");
    expect(job.if).toContain("(inputs.profile == 'gate0' || inputs.profile == 'infrastructure') && vars.ZEROS_DEV_GATE0_ENABLED == 'true'");
    expect(job.if).toContain("vars.ZEROS_DEV_INFRASTRUCTURE_ENABLED == 'true'");
    expect(job.if).toContain("vars.ZEROS_DEV_E2E_ENABLED == 'true'");
    expect(job.steps.filter((step: any) => JSON.stringify(step.env ?? {}).includes("secrets.")).map((step: any) => step.name))
      .toEqual(["Execute Alpha product lifecycle"]);
  });
  it("supplies only fixture and cleanup secrets, preserves prior receipts and uploads only signed redacted output", () => {
    const workflow = load(readFileSync(".github/workflows/zeros-dev-e2e.yml", "utf8")) as any;
    const steps = workflow.jobs.lifecycle.steps;
    const run = steps.find((step: any) => step.name === "Execute Alpha product lifecycle");
    expect(run.env.ZEROS_DEV_FIXTURE_B64).toBe("${{ secrets.ZEROS_DEV_FIXTURE_B64 }}");
    expect(Object.keys(run.env).some(key => key.startsWith("AGENT_RUNTIME_"))).toBe(false);
    expect(run.env.ZEROS_DEV_CLEANUP_HANDOFF_B64).toBe("${{ secrets.ZEROS_DEV_CLEANUP_HANDOFF_B64 }}");
    expect(run.run).toBe("pnpm exec tsx scripts/zeros-dev/hourly-main.ts");
    const restore = steps.find((step: any) => step.name === "Restore exact predecessor receipt");
    expect(restore.with["artifact-ids"]).toBe("${{ steps.plan.outputs.artifact_id }}");
    // The consumer reads zeros-dev-previous/receipt.json, without an artifact
    // name subdirectory. Select one exact ID and explicitly flatten its files.
    expect(restore.with["merge-multiple"]).toBe(true);
    const upload = steps.find((step: any) => step.name === "Save signed cleanup receipt");
    expect(upload.if).toBe("always()"); expect(upload.with.path).toBe("${{ runner.temp }}/zeros-dev-output/receipt.json");
    expect(upload.with["if-no-files-found"]).toBe("error"); expect(upload.with["include-hidden-files"]).not.toBe(true);
  });
  it("the required CI aggregate evaluates the trusted base gate after its selected checks", () => {
    const workflow = load(readFileSync(".github/workflows/ci.yml", "utf8")) as any;
    const gate = workflow.jobs["ci-gate"], steps = gate.steps;
    expect(gate.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    const checkout = steps.find((step: any) => step.name === "Checkout trusted hourly policy");
    expect(checkout.with.ref).toBe("${{ github.event.pull_request.base.sha }}"); expect(checkout.with["persist-credentials"]).toBe(false);
    const final = steps.at(-1);
    expect(final.name).toBe("Require fresh zeros-dev E2E for cloud changes");
    expect(final.run).toContain(".hourly-policy/scripts/ci/zeros-dev-gate.mjs");
    expect(final.env.LEDGER_JSON).toBe("${{ needs.scope.outputs.ledger }}");
  });
});

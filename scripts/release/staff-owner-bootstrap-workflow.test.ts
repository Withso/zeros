import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = () => readFileSync(".github/workflows/staff-owner-bootstrap.yml", "utf8");
const job = (text: string, name: string) => text.split(`\n  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z_-]+:\n/)[0] ?? "";

describe("manual Production owner bootstrap workflow", () => {
  it("offers only the Production channel, kept as an input so existing dispatch commands still parse", () => {
    const text = workflow();
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toMatch(/^ {2}(?:push|pull_request|workflow_call|schedule):/m);
    const inputs = text.split("    inputs:\n")[1]?.split("\npermissions:")[0] ?? "";
    expect([...inputs.matchAll(/^ {6}([a-z_]+):$/gm)].map(match => match[1])).toEqual([
      "channel", "mode", "subject_user_id", "actor_user_id", "owner_organization_id", "reason", "confirm",
    ]);
    expect(inputs).toContain("options: [plan, apply]");
    expect(inputs).toContain("default: plan");
    expect(inputs).toContain("options: [production]"); expect(inputs).toContain("default: production");
    expect(text).not.toMatch(/\bbeta\b/i);
    expect(text).not.toMatch(/STAFF_BOOTSTRAP_ROLE|CONTROL_PLANE_STAFF_ROLE|caller_gated/);
    expect(text).not.toMatch(/contents: write|actions: write|deployments: write|secrets: write/);
  });

  it("gates the privileged job on exact-source CI, the Production environment and a never-cancelled hosted lock", () => {
    const text = workflow(), ci = job(text, "ci"), bootstrap = job(text, "bootstrap");
    expect(ci).toContain("github.event.repository.fork == false");
    expect(ci).toContain("github.event_name == 'workflow_dispatch'");
    expect(ci).toContain("startsWith(github.ref, 'refs/heads/release/')");
    expect(ci).not.toContain("secrets.");
    expect(ci).toContain("ci-cli.ts --wait");
    expect(ci).toContain("RELEASE_CHANNEL: production");
    expect(bootstrap).toContain("needs: [ci, approve]");
    expect(bootstrap).toContain("needs.ci.result == 'success'");
    expect(bootstrap).toContain("environment: production");
    expect(bootstrap).toContain("group: hosted-mutation-production\n      cancel-in-progress: false");
    expect(bootstrap).toContain("timeout-minutes: 15");
    expect(bootstrap).toContain("RELEASE_CHANNEL: production");
    for (const body of [ci, bootstrap]) {
      expect(body).toContain("ref: ${{ github.sha }}");
      expect(body).toContain("persist-credentials: false");
    }
  });

  it("requires the actual secrets-free Production approval job before protected preparation", () => {
    const text = workflow(), approve = job(text, "approve"), bootstrap = job(text, "bootstrap");
    expect((text.match(/environment: production-approval/g) ?? []).length).toBe(1);
    expect(approve).toContain("name: Approve Production staff owner bootstrap");
    expect(approve).toContain("inputs.channel == 'production'");
    expect(approve).toContain("github.event.repository.fork == false");
    expect(approve).toContain("environment: production-approval"); expect(approve).toContain("permissions: {}");
    expect(approve).not.toContain("secrets."); expect(approve).not.toContain("actions/checkout");
    expect(bootstrap).toContain("inputs.channel == 'production' && needs.approve.result == 'success'");
    expect(bootstrap).not.toContain("needs.approve.result == 'skipped'");
    expect(bootstrap).not.toContain("PRODUCTION_CONFIRMED:");
  });

  it("durably uploads the exact sanitized intent before the single create-capable entrypoint", () => {
    const text = job(workflow(), "bootstrap");
    const prepare = text.indexOf("staff-owner-bootstrap-cli.ts --prepare");
    const upload = text.indexOf("name: Retain role-create intent");
    const execute = text.indexOf("staff-owner-bootstrap-cli.ts --run");
    expect(prepare).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(prepare);
    expect(execute).toBeGreaterThan(upload);
    const retention = text.slice(upload, text.indexOf("name: Plan or apply the audited owner role"));
    expect(retention).toContain("id: intent");
    expect(retention).toContain("if-no-files-found: error");
    expect(retention).toContain("include-hidden-files: true");
    expect(retention).toContain("production-staff-owner-intent-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(text).toContain("STAFF_BOOTSTRAP_INTENT_ARTIFACT_ID: ${{ steps.intent.outputs.artifact-id }}");
    expect(text).toContain("if: always()");
    expect(text).toContain("production-staff-bootstrap-result.json");
  });

  it("takes expected email only from its dedicated environment secret and keeps secrets out of commands", () => {
    const text = job(workflow(), "bootstrap");
    expect(text.split("    steps:\n")[0]).not.toContain("secrets.");
    expect([...new Set([...text.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]))].sort()).toEqual([
      "PLANETSCALE_SERVICE_TOKEN", "PLANETSCALE_SERVICE_TOKEN_ID", "STAFF_EXPECTED_EMAIL",
    ]);
    expect(text).toContain("STAFF_EXPECTED_EMAIL: ${{ secrets.STAFF_EXPECTED_EMAIL }}");
    expect(text).toContain("STAFF_OWNER_ORGANIZATION_ID: ${{ inputs.owner_organization_id }}");
    const commands = [...text.matchAll(/^\s+run: ([^\n]*(?:\n {10}[^\n]*)*)/gm)].map(match => match[1]).join("\n");
    expect(commands).not.toMatch(/\$\{\{|\$(?:STAFF_EXPECTED_EMAIL|PLANETSCALE_SERVICE_TOKEN)/);
    expect(text).not.toMatch(/staff:manage|gh secret|gh variable|railway up|designation|canary-cli|release-cli/);
  });
});

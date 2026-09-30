import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = () => readFileSync(".github/workflows/cloud-worker-promotion.yml", "utf8");
describe("protected worker workflow handoff", () => {
  it("gates every mutation on exact-source Preflight/CodeQL and refuses PR/fork runs", () => {
    const text = workflow();
    expect(text).toContain("name: worker"); expect(text).toContain("actions: read");
    expect(text).toContain("github.event_name == 'push' || github.event_name == 'workflow_dispatch'");
    expect(text).toContain("github.event.repository.fork == false"); expect(text).toContain("environment: ${{ inputs.channel }}");
    expect(text.indexOf("ci-cli.ts --wait")).toBeLessThan(text.indexOf("- name: Worker plan or guarded execution"));
    expect(text).toContain("ref: ${{ inputs.source_sha || github.sha }}");
    expect(text).toContain("group: hosted-mutation-${{ inputs.channel }}\n      cancel-in-progress: false");
  });
  it("uploads only verified success with the exact producer, step, filename and artifact names", () => {
    const text = workflow(), upload = text.split("- name: Save success receipt")[1]?.split(/\n {6}- name:/)[0] ?? "";
    expect(upload).toContain("success() && steps.promote.outputs.receipt_issued == 'true'"); expect(upload).not.toContain("always()");
    expect(upload).toContain("name: worker-promotion-${{ inputs.channel }}-${{ inputs.source_sha || github.sha }}");
    expect(upload).toContain("path: .context/release/worker-receipt.json"); expect(upload).toContain("include-hidden-files: true");
    expect(text).toContain("receipt_issued: ${{ steps.promote.outputs.receipt_issued }}");
    expect(text).toContain("receipt_artifact: ${{ steps.promote.outputs.receipt_artifact }}");
  });
  it("requires a fresh receipt for callable executions while standalone dispatch may reuse", () => {
    const text = workflow();
    expect(text.split("workflow_call:")[1]).toMatch(/receipt_required:\s+default: true\s+type: boolean/);
    expect(text.split("workflow_call:")[0]).toMatch(/receipt_required:[\s\S]*?default: false/);
    expect(text).toContain("WORKER_RECEIPT_REQUIRED: ${{ inputs.receipt_required }}");
  });
  it("holds canary authority only in protected step environment, never static provider seeds or argv", () => {
    const text = workflow();
    expect(text).toContain("WORKER_CANARY_ADMISSION_TOKEN: ${{ secrets.WORKER_CANARY_ADMISSION_TOKEN }}");
    expect(text).not.toContain("WORKER_CANARY_CONNECTIONS_JSON");
    expect(text).not.toMatch(/WORKER_CANARY_(?:CLAUDE_(?:API_KEY|SETUP_TOKEN)|CODEX_AUTH_JSON|CURSOR_API_KEY)/);
    expect(text).not.toMatch(/run:.*\$\{\{ secrets\./);
    expect(text).toContain("WORKER_QUALIFICATION_PROFILE: ${{ inputs.qualification_profile || 'auto' }}");
    expect(text).toContain("timeout-minutes: 330");
  });
});

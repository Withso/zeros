import { describe, expect, it } from "vitest";
import { workerExecutionConfig } from "./worker-config";
import { workerEnvironment } from "./worker-test-fixtures";

describe("protected worker execution policy", () => {
  it("accepts only the three offered owner-designated kinds without any provider credential in CI", () => {
    expect(workerExecutionConfig(workerEnvironment()).kinds).toEqual(["claude-setup-token", "codex-chatgpt", "cursor-api-key"]);
  });
  it("refuses PR/fork triggers, disabled execution and incomplete admission authority before mutations", () => {
    for (const patch of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_EVENT_NAME: "workflow_run" },
      { GITHUB_HEAD_REF: "fork-branch" }, { ZEROS_WORKER_PROMOTION: "disabled" }, { WORKER_CANARY_ADMISSION_TOKEN: "" }, { WORKER_CANARY_ORGANIZATION_ID: "not-a-uuid" }]) {
      expect(() => workerExecutionConfig({ ...workerEnvironment(), ...patch })).toThrow();
    }
  });
  it("rejects unqualified API-key modes and unbounded account spending", () => {
    for (const patch of [{ RUNTIME_QUALIFICATION_CREDENTIAL_KINDS: "claude-api-key,codex-api-key,cursor-api-key" },
      { RUNTIME_QUALIFICATION_CREDENTIAL_KINDS: "claude-setup-token,codex-chatgpt,cursor-api-key,claude-api-key,codex-api-key" },
      { BOAT_BUILDER_BUDGET_HOURS: "3" }, { BOAT_CANARY_BUDGET_HOURS: "2" }, { BOAT_WORKER_BUDGET_HOURS: "7" }]) {
      expect(() => workerExecutionConfig({ ...workerEnvironment(), ...patch })).toThrow();
    }
  });
});

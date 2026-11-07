import { describe, expect, it } from "vitest";
import { runtimeBuildConfig, runtimeReleaseConfig } from "./runtime-contracts";

function environment(channel: "alpha" | "beta" | "production", file: string, event: string) {
  const branch = channel === "alpha" ? "main" : "release/1.2.3";
  return { GITHUB_REPOSITORY: "example/project", GITHUB_SHA: "1".repeat(40), GITHUB_WORKFLOW_SHA: "1".repeat(40),
    GITHUB_REF_NAME: branch, GITHUB_REF: `refs/heads/${branch}`, GITHUB_WORKFLOW_REF: `example/project/.github/workflows/${file}@refs/heads/${branch}`,
    GITHUB_EVENT_NAME: event, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", RUNTIME_RELEASE_CHANNEL: channel,
    RUNTIME_RELEASE_ACTION: channel === "alpha" ? "publish" : "promote", RUNTIME_RELEASE_EXPECTED_CP_SHA: "1".repeat(40),
    RUNTIME_RELEASE_EXPECTED_SHA256: "a".repeat(64), ZEROS_RUNTIME_RELEASE: "enabled", ZEROS_HOSTED_PROMOTION: "enabled",
    ...(channel === "alpha" ? { RUNTIME_RELEASE_SOURCE_SHA: "1".repeat(40) } : {
      RUNTIME_RELEASE_SHA256: "b".repeat(64), RUNTIME_RELEASE_ALPHA_RUN_ID: "122", RUNTIME_RELEASE_ALPHA_RUN_ATTEMPT: "1",
    }) };
}

describe("runtime caller admission", () => {
  it.each([
    ["alpha", "release-alpha.yml", "push"], ["beta", "release-beta.yml", "push"], ["production", "release.yml", "workflow_dispatch"],
  ] as const)("admits the exact %s release parent", (channel, file, event) => {
    const env = environment(channel, file, event);
    expect(runtimeReleaseConfig(env)).toMatchObject({ channel, workflowFile: file, runId: "123", runAttempt: 2 });
    if (channel === "alpha") expect(runtimeBuildConfig(env)).toMatchObject({ workflowFile: file });
  });
  it.each(["alpha", "beta", "production"] as const)("retains manual %s dispatch", channel => {
    expect(runtimeReleaseConfig(environment(channel, "runtime-release.yml", "workflow_dispatch"))).toMatchObject({ channel });
  });
  it.each([
    { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "workflow_call" }, { GITHUB_WORKFLOW_SHA: "2".repeat(40) },
    { GITHUB_WORKFLOW_REF: "example/project/.github/workflows/runtime-release-run.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_REF: "foreign/repo/.github/workflows/release-alpha.yml@refs/heads/main" },
    { GITHUB_WORKFLOW_REF: "example/project/.github/workflows/release-beta.yml@refs/heads/main" },
    { RUNTIME_RELEASE_EXPECTED_CP_SHA: "2".repeat(40) }, { RUNTIME_RELEASE_SOURCE_SHA: "2".repeat(40) },
    { RUNTIME_RELEASE_ACTION: "rollback", RUNTIME_RELEASE_SOURCE_SHA: undefined },
  ])("refuses caller or action substitution (%j)", patch => {
    expect(() => runtimeReleaseConfig({ ...environment("alpha", "release-alpha.yml", "push"), ...patch })).toThrow();
  });
});

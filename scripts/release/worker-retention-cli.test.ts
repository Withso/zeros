import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerEnvironment } from "./worker-test-fixtures";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))); });
async function fixture() {
  const now = Date.now();
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-retention-cli-")); directories.push(directory);
  const env: NodeJS.ProcessEnv = { ...workerEnvironment(), GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/worker-retention-resume.yml@refs/heads/main", GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "789", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: path.join(directory, "event.json"),
    RETENTION_CHANNEL: "alpha", RETENTION_SOURCE_SHA: "a".repeat(40), RETENTION_PARENT_RUN_ID: "123", RETENTION_FAILED_ATTEMPT: "1", RETENTION_WORKER_JOB_ID: "456",
    GITHUB_OUTPUT: path.join(directory, "output"), GITHUB_STEP_SUMMARY: path.join(directory, "summary") };
  const event: any = { repository: { full_name: env.GITHUB_REPOSITORY, fork: false, default_branch: "main" },
    inputs: { channel: "alpha", source_sha: env.GITHUB_SHA, parent_run_id: "123", failed_attempt: "1", worker_job_id: "456" } };
  const metadata: any = { inspect: vi.fn(async () => ({ sha256: "a".repeat(64), failedAt: now - 10_000 })),
    assertIntentAvailable: vi.fn(async () => {}), verifyOwnIntent: vi.fn(async () => {}), rerun: vi.fn(async () => "accepted"),
    discover: vi.fn(async () => null), dispatch: vi.fn(async () => {}) };
  const completion = vi.fn(async () => ({ sha256: "b".repeat(64), completedAt: new Date(now).toISOString() }));
  const options = { directory, client: metadata, completion, assertCheckout: vi.fn(async () => {}), log: vi.fn() };
  const save = () => writeFile(env.GITHUB_EVENT_PATH!, JSON.stringify(event)); await save();
  return { directory, env, event, metadata, completion, options, save };
}

describe("protected retention observer CLI", () => {
  it("validates selectors against immutable own workflow source before any protected observation", async () => {
    const test = await fixture(), { workerRetentionMain } = await import("./worker-retention-cli");
    await workerRetentionMain("--validate", test.env, test.options);
    expect(await readFile(test.env.GITHUB_OUTPUT!, "utf8")).toContain("channel=alpha");
    expect(test.metadata.inspect).toHaveBeenCalledOnce(); expect(test.completion).not.toHaveBeenCalled();
    expect(test.metadata.rerun).not.toHaveBeenCalled();
  });
  it.each([
    ["fork", (test: any) => { test.event.repository.fork = true; }],
    ["wrong repository", (test: any) => { test.event.repository.full_name = "foreign/repository"; }],
    ["wrong dispatch source", (test: any) => { test.env.RETENTION_SOURCE_SHA = "b".repeat(40); }],
    ["workflow implementation source", (test: any) => { test.env.GITHUB_WORKFLOW_SHA = "b".repeat(40); }],
    ["unprotected observer branch", (test: any) => { test.env.GITHUB_REF = "refs/heads/author"; }],
    ["workflow ref", (test: any) => { test.env.GITHUB_WORKFLOW_REF = "example/zeros/.github/workflows/other.yml@refs/heads/main"; }],
    ["PR head", (test: any) => { test.env.GITHUB_HEAD_REF = "author"; }],
    ["default-branch Production", (test: any) => { test.env.RETENTION_CHANNEL = "production"; test.event.inputs.channel = "production"; }],
    ["event selector mismatch", (test: any) => { test.event.inputs.worker_job_id = "999"; }],
    ["non-CI authority", (test: any) => { test.env.CI = "false"; }],
  ] as const)("refuses %s before even metadata/protected reads", async (_label, change) => {
    const test = await fixture(); change(test); await test.save();
    const { workerRetentionMain } = await import("./worker-retention-cli");
    await expect(workerRetentionMain("--validate", test.env, test.options)).rejects.toThrow();
    expect(test.metadata.inspect).not.toHaveBeenCalled(); expect(test.completion).not.toHaveBeenCalled(); expect(test.metadata.rerun).not.toHaveBeenCalled();
  });
  it("durably writes only the non-secret intent, then fences a repeat in the same runner", async () => {
    const test = await fixture(), { workerRetentionMain } = await import("./worker-retention-cli");
    await workerRetentionMain("--observe", test.env, test.options);
    const intent = JSON.parse(await readFile(path.join(test.directory, "retention-intent.json"), "utf8"));
    expect(intent.kind).toBe("original-worker-rerun-intent"); expect(intent.producer).toEqual({ runId: "789", runAttempt: "1" });
    expect(await readFile(test.env.GITHUB_OUTPUT!, "utf8")).toContain("eligible=true"); expect(test.metadata.rerun).not.toHaveBeenCalled();
    await workerRetentionMain("--request", test.env, test.options);
    await workerRetentionMain("--request", test.env, test.options);
    expect(test.metadata.rerun).toHaveBeenCalledOnce(); expect(test.metadata.rerun).toHaveBeenCalledWith("456");
    expect(await readFile(path.join(test.directory, "retention-requested.json"), "utf8")).not.toContain("BOAT_API_KEY");
  });
  it("reports an unavailable observation without consuming intent or implying worker success", async () => {
    const test = await fixture(); test.completion.mockRejectedValue(new Error("private response must not be printed"));
    const { workerRetentionMain } = await import("./worker-retention-cli");
    await workerRetentionMain("--observe", test.env, test.options);
    await expect(readFile(path.join(test.directory, "retention-intent.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(test.env.GITHUB_OUTPUT!, "utf8")).not.toContain("eligible=true");
    expect(test.metadata.rerun).not.toHaveBeenCalled(); expect(test.options.log.mock.calls.flat().join(" ")).not.toContain("private response");
  });
  it.each(["cloud-off", "disabled-worker", "unbound-profile"])("keeps %s outside the real protected observer before any API/provider read", async reason => {
    const test = await fixture();
    Object.assign(test.env, { ZEROS_HOSTED_PROMOTION: "enabled", ZEROS_WORKER_PROMOTION: "enabled", ZEROS_CLOUD_WORKSPACES_ENABLED: "true", CLOUD_WORKSPACE_PROVIDER: "boat" });
    if (reason === "cloud-off") test.env.ZEROS_CLOUD_WORKSPACES_ENABLED = "false";
    if (reason === "disabled-worker") test.env.ZEROS_WORKER_PROMOTION = "disabled";
    const fetcher = vi.fn(async () => { throw new Error("No external request is authorized in this test"); }); vi.stubGlobal("fetch", fetcher);
    try {
      const { completion: _completion, ...options } = test.options;
      const { workerRetentionMain } = await import("./worker-retention-cli");
      await workerRetentionMain("--observe", test.env, options);
      expect(fetcher).not.toHaveBeenCalled(); expect(test.metadata.rerun).not.toHaveBeenCalled();
      expect(await readFile(test.env.GITHUB_OUTPUT!, "utf8")).not.toContain("eligible=true");
    } finally { vi.unstubAllGlobals(); }
  });
  it("dispatches an observer at the original protected release ref, never using scheduled main as its source", async () => {
    const test = await fixture(); test.env.GITHUB_EVENT_NAME = "schedule"; delete test.event.inputs; await test.save();
    const beta = { repository: "example/zeros", channel: "beta", sourceSha: "b".repeat(40), branch: "release/0.1.0", runId: "124", failedAttempt: "1", jobId: "457" };
    test.metadata.discover.mockImplementation(async (channel: string) => channel === "beta" ? beta : null);
    const { workerRetentionMain } = await import("./worker-retention-cli");
    await workerRetentionMain("--discover", test.env, test.options);
    expect(test.metadata.dispatch).toHaveBeenCalledOnce(); expect(test.metadata.dispatch).toHaveBeenCalledWith(beta);
    expect(test.completion).not.toHaveBeenCalled(); expect(test.metadata.rerun).not.toHaveBeenCalled();
  });
});

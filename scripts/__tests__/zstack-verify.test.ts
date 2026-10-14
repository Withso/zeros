import { describe, expect, it, vi } from "vitest";
import { runCli } from "../zstack/verify.mjs";
import { planDriver, observeHourly } from "../zstack/drivers.mjs";

const sha = "a".repeat(40);
describe("zstack verification entry points", () => {
  it("uses the existing Linux UI driver and exposes native proof separately", () => {
    expect(planDriver("local-ui", { platform: "linux", shard: "1/3" })).toMatchObject({ command: { argv: ["pnpm", "test:ui-smoke", "--shard=1/3"] },
      unverified: expect.arrayContaining([{ id: "engine-smoke", reason: "requires_macos" }]) });
    expect(() => planDriver("local-ui", { shard: "1/3;env" })).toThrow("zstack_input_invalid");
  });
  it("delegates cloud health and model scenarios to zeros-dev and Actions", () => {
    expect(planDriver("cloud-health", { sourceSha: sha, platform: "linux" }).command.argv)
      .toEqual(["pnpm", "exec", "tsx", "scripts/zeros-dev/cli.ts", "health", "cp", "--expect-source", sha]);
    expect(planDriver("cloud-dispatch", { sourceSha: sha }).command.argv)
      .toEqual(["pnpm", "agent:gh", "workflow", "run", "zeros-dev-e2e.yml", "--ref", "main"]);
    expect(() => planDriver("cloud-health", { sourceSha: sha, platform: "darwin" })).toThrow("zstack_requires_linux");
  });
  it("does no work for a live plan and never calls a dispatch a passing E2E", async () => {
    const run = vi.fn(async () => ({ status: "passed", code: "ok" })), write = vi.fn(), receipt = vi.fn();
    expect(await runCli(["cloud-dispatch", "--source", sha], { run, write })).toBe(0);
    expect(run).not.toHaveBeenCalled(); expect(write.mock.calls[0][0]).toMatchObject({ requiresExecution: true });
    expect(await runCli(["cloud-dispatch", "--source", sha, "--execute", "--receipt", "/tmp/synthetic"], { run, write, receipt })).toBe(0);
    expect(receipt.mock.calls[0][1]).toMatchObject({ status: "unverified", code: "dispatch_requested" });
    expect(run).toHaveBeenCalledOnce();
  });
  it("requires explicit execution, a receipt, and complete orchestration metadata", async () => {
    const write = vi.fn(), run = vi.fn();
    for (const args of [["run"], ["cloud-dispatch", "--execute"], ["plan", "--mode", "master-subagents", "--agent", "P"]]) {
      expect(await runCli(args, { write, run })).toBe(1);
    }
    expect(run).not.toHaveBeenCalled();
    expect(write.mock.calls.every(call => call[0].schema === "zeros.zstack-error/v1")).toBe(true);
  });
  it("binds canary evidence to the expected source, completion and freshness", async () => {
    const now = Date.now(), latest = { id: 123, run_number: 1, run_attempt: 1, head_sha: sha, conclusion: "success", status: "completed",
      path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E", head_branch: "main", event: "schedule",
      repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" } };
    const snapshot = { activated: true, latest, executed: true, completedAt: new Date(now - 1000).toISOString() };
    const observe = (extra = {}) => observeHourly({}, sha, { now, snapshot: async () => ({ ...snapshot, ...extra }) });
    expect(await observe()).toMatchObject({ status: "passed", code: "hourly_green", sourceSha: sha, runId: "123", attempt: 1 });
    expect(await observe({ latest: { ...latest, head_sha: "b".repeat(40) } })).toMatchObject({ status: "unverified", code: "source_mismatch" });
    expect(await observe({ completedAt: new Date(now - 2 * 60 * 60_000).toISOString() })).toMatchObject({ status: "unverified", code: "hourly_stale" });
    expect(await observe({ activated: false })).toMatchObject({ status: "unverified", code: "hourly_not_live" });
  });
});

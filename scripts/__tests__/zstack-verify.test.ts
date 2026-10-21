import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runCli } from "../zstack/verify.mjs";
import { planDriver } from "../zstack/drivers.mjs";
import { writeReceipt } from "../zstack/runner.mjs";
import { privateFixtureRoot, readFixtureReceipt } from "./zstack-fixtures";

const sha = "a".repeat(40);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("zstack verification entry points", () => {
  it("uses the existing Linux UI driver and exposes native proof separately", () => {
    expect(planDriver("local-ui", { platform: "linux", shard: "1/3" })).toMatchObject({ command: { argv: ["pnpm", "test:ui-smoke", "--shard=1/3"] },
      unverified: expect.arrayContaining([{ id: "engine-smoke", reason: "requires_macos" }]) });
    expect(() => planDriver("local-ui", { shard: "1/3;env" })).toThrow("zstack_input_invalid");
  });
  it("plans only Local drivers; live cloud proof is gate0, outside this tool", () => {
    for (const action of ["cloud-health", "cloud-dispatch", "cloud-status"])
      expect(() => planDriver(action, { sourceSha: sha, platform: "linux" })).toThrow("zstack_input_invalid");
  });
  it("does no work for a plan and records an executed run in a receipt", async () => {
    const run = vi.fn(async () => ({ status: "passed", code: "ok" })), write = vi.fn(), receipt = vi.fn(writeReceipt);
    const file = path.join(await privateFixtureRoot(roots), "receipt.json");
    expect(await runCli(["local-ui", "--source", sha], { run, write })).toBe(0);
    expect(run).not.toHaveBeenCalled(); expect(write.mock.calls[0][0]).toMatchObject({ requiresExecution: true, intendedSourceSha: sha });
    expect(await runCli(["local-ui", "--source", sha, "--execute", "--receipt", file], { run, write, receipt })).toBe(0);
    expect(receipt.mock.calls[0][1]).toMatchObject({ status: "passed", code: "ok", intendedSourceSha: sha });
    expect(await readFixtureReceipt(file)).toEqual(receipt.mock.calls[0][1]);
    expect(run).toHaveBeenCalledOnce();
  });
  it("requires explicit execution, a receipt, and complete orchestration metadata", async () => {
    const write = vi.fn(), run = vi.fn();
    for (const args of [["run"], ["local-ui", "--execute"], ["cloud-dispatch", "--source", sha],
      ["plan", "--mode", "master-subagents", "--agent", "P"]]) {
      expect(await runCli(args, { write, run })).toBe(1);
    }
    expect(run).not.toHaveBeenCalled();
    expect(write.mock.calls.every(call => call[0].schema === "zeros.zstack-error/v1")).toBe(true);
  });
});

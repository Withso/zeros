import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "../zstack/verify.mjs";
import { planDriver } from "../zstack/drivers.mjs";
import { executeVerification, writeReceipt } from "../zstack/runner.mjs";
import { captureSource } from "../zstack/source.mjs";
import { privateFixtureRoot, readFixtureReceipt } from "./zstack-fixtures";

const sha = "a".repeat(40);
function anchorFixture(file: string, test: string) {
  const fixtureSource = { bytes: Buffer.from("first\nsecond\nthird"), mode: 0o644 };
  return { files: [file, test], anchorSources: new Map([[file, fixtureSource], [test, fixtureSource]]),
    evidence: { complete: true, changes: [{ path: file, status: "M" }], baseSha: sha, sourceSha: sha,
      fingerprint: "b".repeat(64) } };
}
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("zstack verification entry points", () => {
  it("uses a portable, single-session plan unless authorized delegation is available", async () => {
    const write = vi.fn(), capture = vi.fn(), run = vi.fn();
    const options = { write, capture, run };
    expect(await runCli(["host"], options)).toBe(0);
    expect(write.mock.lastCall?.[0]).toMatchObject({ host: "portable", mode: "single-session",
      roles: { implementer: { execution: "primary", model: "inherit" }, reviewer: { execution: "cold-pass", model: "inherit" } } });
    expect(await runCli(["host", "--host", "devin", "--delegate", "reviewer"], options)).toBe(0);
    expect(write.mock.lastCall?.[0]).toMatchObject({ host: "devin", entry: "agents/zstack/skills/zstack/SKILL.md",
      mode: "single-session", roles: { reviewer: { execution: "cold-pass", reason: "delegation_unavailable" } } });
    expect(await runCli(["host", "--host", "devin", "--can-delegate", "--delegate", "reviewer",
      "--reviewer-model", "explicit-model"], options)).toBe(0);
    expect(write.mock.lastCall?.[0]).toMatchObject({ mode: "master-subagents", roles: {
      implementer: { execution: "primary", model: "inherit" },
      reviewer: { execution: "delegated", model: "explicit-model" } } });
    expect(capture).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["host", "--host", "unknown"],
    ["host", "--reviewer-model", "not-requested"],
    ["host", "--delegate", "reviewer", "--delegate", "reviewer"],
    ["host", "--source", sha],
    ["plan", "--delegate", "reviewer"],
    ["local-ui", "--anchor", "scripts/zstack/verify.mjs:1"],
  ])("rejects incompatible or ambiguous host options: %j", async (...args) => {
    const write = vi.fn(), capture = vi.fn(), run = vi.fn();
    expect(await runCli(args, { write, capture, run })).toBe(1);
    expect(write).toHaveBeenCalledWith({ schema: "zeros.zstack-error/v1", code: "zstack_input_invalid" });
    expect(capture).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("pins up to two declared source anchors without treating them as executed evidence", async () => {
    const file = "scripts/zstack/verify.mjs", test = "scripts/__tests__/zstack-verify.test.ts", write = vi.fn();
    const capture = vi.fn(async () => anchorFixture(file, test));
    const options = { write, capture };
    expect(await runCli(["plan", "--anchor", `${file}:3`, "--anchor", `${test}:1`], options)).toBe(0);
    expect(write.mock.lastCall?.[0]).toMatchObject({ identity: { sourceSha: sha },
      sourceAnchors: [{ path: file, line: 3 }, { path: test, line: 1 }] });
    expect(await runCli(["plan", "--anchor", `${file}:999999`], options)).toBe(1);
    expect(write.mock.lastCall?.[0]).toMatchObject({ code: "zstack_anchor_invalid" });
    expect(await runCli(["plan", "--anchor", ".env.agent:1"], options)).toBe(1);
    expect(await runCli(["plan", "--anchor", `${file}:1`, "--anchor", `${file}:2`, "--anchor", `${file}:3`], options)).toBe(1);
  });

  it("rejects lines added after the cited source was fingerprinted", async () => {
    const cwd = await privateFixtureRoot(roots), write = vi.fn(), file = "source.txt";
    const policy = "scripts/ci/scope-rules.json";
    await mkdir(path.join(cwd, "scripts/ci"), { recursive: true });
    await copyFile(policy, path.join(cwd, policy));
    await writeFile(path.join(cwd, file), "first\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "--quiet", "--initial-branch=main");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");

    const capture: typeof captureSource = async (...args) => {
      const snapshot = await captureSource(...args);
      await writeFile(path.join(cwd, file), "first\nsecond\n");
      return snapshot;
    };
    expect(await runCli(["plan", "--anchor", `${file}:2`], { cwd, capture, write })).toBe(1);
    expect(write).toHaveBeenLastCalledWith({ schema: "zeros.zstack-error/v1", code: "zstack_anchor_invalid" });
    expect(await runCli(["plan", "--anchor", `${file}:2`], { cwd, write })).toBe(0);
    expect(write.mock.lastCall?.[0]).toMatchObject({ sourceAnchors: [{ path: file, line: 2 }] });
  });

  it("records a co-master pair without claiming there are subagents", async () => {
    const write = vi.fn();
    expect(await runCli(["local-ui", "--mode", "co-masters", "--agent", "GPT-6 Astra", "--master", "Claude Opus 5.5"], { write })).toBe(0);
    expect(write.mock.calls[0][0]).toMatchObject({ mode: "co-masters", agent: "GPT-6 Astra", master: "Claude Opus 5.5" });
    expect(await runCli(["local-ui", "--mode", "co-masters", "--agent", "GPT-6 Astra"], { write })).toBe(1);
  });
  it("keeps declared anchors separate from check results in a written receipt", async () => {
    const file = "scripts/zstack/verify.mjs", test = "scripts/__tests__/zstack-verify.test.ts";
    const output = path.join(await privateFixtureRoot(roots), "anchors.json");
    const capture = async () => anchorFixture(file, test);
    const run = vi.fn(async () => ({ status: "failed", code: "tests_failed" }));
    const verify: typeof executeVerification = (plan, options) => executeVerification(plan, { ...options, run });
    expect(await runCli(["run", "--anchor", `${file}:3`, "--host", "devin", "--execute", "--receipt", output],
      { write: vi.fn(), capture, verify })).toBe(1);
    expect(await readFixtureReceipt(output)).toMatchObject({ host: "devin", identity: { sourceSha: sha }, status: "failed",
      sourceAnchors: [{ path: file, line: 3 }], evidence: [],
      results: [{ id: "adjacent-root", code: "tests_failed" }],
      unverified: expect.arrayContaining([{ id: "typecheck", reason: "not_run" }]) });
    expect(run).toHaveBeenCalledOnce();
  });
  it("uses the existing Linux UI driver and exposes native proof separately", () => {
    expect(planDriver("local-ui", { platform: "linux", shard: "1/3" })).toMatchObject({ command: { argv: ["pnpm", "test:ui-smoke", "--shard=1/3"] },
      unverified: expect.arrayContaining([{ id: "engine-smoke", reason: "requires_macos" }]) });
    expect(() => planDriver("local-ui", { shard: "1/3;env" })).toThrow("zstack_input_invalid");
    expect(planDriver("local-ui", { platform: "darwin" })).toMatchObject({
      unverified: expect.arrayContaining([{ id: "engine-smoke", reason: "not_run" }]) });
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

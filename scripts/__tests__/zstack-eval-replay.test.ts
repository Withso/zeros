import { afterEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runCli } from "../zstack/eval-replay.mjs";
import { validateEvalCases } from "../zstack/evals.mjs";
import { writeReceipt } from "../zstack/runner.mjs";
import { privateFixtureRoot, readFixtureReceipt } from "./zstack-fixtures";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const cases = { schema: "zeros.zstack-evals/v1", cases: [{ id: "a-case", kind: "replay", fixedBy: "a".repeat(40), area: "zstack",
  symptom: "synthetic regression", rule: "closed results", check: "pnpm test:git scripts/__tests__/zstack-runner.test.ts" }] };
describe("eval CLI", () => {
  it("rejects ad-hoc subsystem names instead of silently expanding the owner vocabulary", () => {
    const unknown = { ...cases, cases: [{ ...cases.cases[0], area: "another incident-specific area" }] };
    expect(validateEvalCases(unknown)).toEqual([expect.stringMatching(/area must be one of/)]);
  });
  it("lists a bounded plan before execution and refuses unknown cases", async () => {
    const write = vi.fn(), run = vi.fn();
    expect(await runCli(["--case", "a-case"], { read: () => cases, run, write })).toBe(0);
    expect(run).not.toHaveBeenCalled(); expect(write.mock.calls[0][0]).toMatchObject({ selected: ["a-case"], execute: false });
    expect(await runCli(["--case", "foreign"], { read: () => cases, run, write })).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("records a co-master pair and passes an explicit dependency cache to execution", async () => {
    const write = vi.fn(), run = vi.fn(async () => ({ id: "a-case", status: "caught", code: "regression_detected" })), receipt = vi.fn();
    const directory = await privateFixtureRoot(roots);
    const args = ["--all", "--execute", "--receipt", path.join(directory, "receipt.json"), "--dependency-cache", path.join(directory, "cache"),
      "--mode", "co-masters", "--agent", "GPT-6 Astra", "--master", "Claude Opus 5.5"];
    expect(await runCli(args, { read: () => cases, run, write, receipt })).toBe(0);
    expect(run.mock.calls[0][1].cacheRoot).toBe(path.join(directory, "cache"));
    expect(receipt.mock.calls[0][1]).toMatchObject({ mode: "co-masters", agent: "GPT-6 Astra", master: "Claude Opus 5.5" });
    expect(await runCli(args.slice(0, -2), { read: () => cases, run, write, receipt })).toBe(1);
  });
  it("requires a receipt, writes all statuses, and fails for unverified or missed cases", async () => {
    const write = vi.fn(), run = vi.fn(async () => ({ id: "a-case", status: "unverified", code: "test_report_invalid" })), receipt = vi.fn(writeReceipt);
    const file = path.join(await privateFixtureRoot(roots), "receipt.json");
    expect(await runCli(["--all", "--execute"], { read: () => cases, run, write, receipt })).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(await runCli(["--all", "--execute", "--receipt", file], { read: () => cases, run, write, receipt })).toBe(1);
    expect(receipt.mock.calls[0][1]).toMatchObject({ summary: { selected: 1, caught: 0, missed: 0, unverified: 1 } });
    expect(write.mock.calls.some(call => call[0].schema === "zeros.zstack-eval-receipt/v1")).toBe(true);
    expect(await readFixtureReceipt(file)).toEqual(receipt.mock.calls[0][1]);
    const compared = path.join(path.dirname(file), "compared.json");
    expect(await runCli(["--all", "--execute", "--receipt", compared, "--baseline", file], { read: () => cases, run, write, receipt })).toBe(1);
    expect(receipt.mock.calls[1][1]).toMatchObject({ comparison: { allowed: true, regressions: [] } });
    expect(await readFixtureReceipt(compared)).toEqual(receipt.mock.calls[1][1]);
  });
  it("explains the selection bound without silently dropping cases or starting work", async () => {
    const write = vi.fn(), run = vi.fn(), receipt = vi.fn();
    const file = path.join(await privateFixtureRoot(roots), "receipt.json");
    const large = { ...cases, cases: Array.from({ length: 33 }, (_, index) => ({ ...cases.cases[0], id: `case-${index}` })) };
    expect(await runCli(["--all", "--execute", "--receipt", file], { read: () => large, run, write, receipt })).toBe(1);
    expect(write).toHaveBeenCalledWith({ schema: "zeros.zstack-error/v1", code: "zstack_case_limit" });
    expect(run).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });
});

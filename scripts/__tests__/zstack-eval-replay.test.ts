import { describe, expect, it, vi } from "vitest";
import { runCli } from "../zstack/eval-replay.mjs";
const cases = { schema: "zeros.zstack-evals/v1", cases: [{ id: "a-case", kind: "replay", fixedBy: "a".repeat(40), area: "test",
  symptom: "synthetic regression", rule: "closed results", check: "pnpm test:git scripts/__tests__/zstack-runner.test.ts" }] };
describe("eval CLI", () => {
  it("lists a bounded plan before execution and refuses unknown cases", async () => {
    const write = vi.fn(), run = vi.fn();
    expect(await runCli(["--case", "a-case"], { read: () => cases, run, write })).toBe(0);
    expect(run).not.toHaveBeenCalled(); expect(write.mock.calls[0][0]).toMatchObject({ selected: ["a-case"], execute: false });
    expect(await runCli(["--case", "foreign"], { read: () => cases, run, write })).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("requires a receipt, writes all statuses, and fails for unverified or missed cases", async () => {
    const write = vi.fn(), run = vi.fn(async () => ({ id: "a-case", status: "unverified", code: "test_report_invalid" })), receipt = vi.fn();
    expect(await runCli(["--all", "--execute"], { read: () => cases, run, write, receipt })).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(await runCli(["--all", "--execute", "--receipt", "/tmp/synthetic"], { read: () => cases, run, write, receipt })).toBe(1);
    expect(receipt.mock.calls[0][1]).toMatchObject({ summary: { selected: 1, caught: 0, missed: 0, unverified: 1 } });
  });
  it("explains the selection bound without silently dropping cases or starting work", async () => {
    const write = vi.fn(), run = vi.fn(), receipt = vi.fn();
    const large = { ...cases, cases: Array.from({ length: 33 }, (_, index) => ({ ...cases.cases[0], id: `case-${index}` })) };
    expect(await runCli(["--all", "--execute", "--receipt", "/tmp/synthetic"], { read: () => large, run, write, receipt })).toBe(1);
    expect(write).toHaveBeenCalledWith({ schema: "zeros.zstack-error/v1", code: "zstack_case_limit" });
    expect(run).not.toHaveBeenCalled();
    expect(receipt).not.toHaveBeenCalled();
  });
});

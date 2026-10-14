import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { parseReplayCheck, replayCase, compareEvalReceipts, applySeed } from "../zstack/replay.mjs";
import { runCommand } from "../zstack/runner.mjs";

const file = "scripts/__tests__/zeros-dev-product.test.ts";
const entry = { id: "regression", kind: "replay", fixedBy: "a".repeat(40), check: `pnpm exec vitest run ${file}` };
const green = { status: "passed", code: "ok", tests: { total: 2, passed: 2, failed: 0, pending: 0,
  identities: [{ id: "first", status: "passed" }, { id: "second", status: "passed" }] } };
const red = { status: "failed", code: "tests_failed", tests: { total: 2, passed: 1, failed: 1, pending: 0,
  identities: [{ id: "first", status: "failed" }, { id: "second", status: "passed" }] } };
const prepared = () => ({ fixed: "a".repeat(40), parent: "b".repeat(40), green: "/fixed", red: "/parent",
  files: [file], dispose: vi.fn(async () => {}) });

describe("isolated eval replay", () => {
  it("parses only known bounded test invocations, retaining literal test-name filters", () => {
    expect(parseReplayCheck(`pnpm test:git ${file}`, [file])).toMatchObject({ kind: "vitest", tests: [file] });
    const cp = "apps/control-plane/src/worker.test.ts";
    expect(parseReplayCheck("pnpm --dir apps/control-plane exec vitest run src/worker.test.ts -t 'a bounded test'", [cp]).argv)
      .toEqual(["pnpm", "--dir", "apps/control-plane", "exec", "vitest", "run", "src/worker.test.ts", "-t", "a bounded test"]);
  });
  it.each([`pnpm test:git ${file}; touch /tmp/escape`, `pnpm exec vitest run ${file} --watch`,
    `pnpm exec vitest run ${file} -t --watch`, `pnpm exec vitest run ${file} --testNamePattern --reporter=verbose`,
    "pnpm test:git", "pnpm exec vitest run ../foreign.test.ts", "node -e 'process.exit(0)'", "pnpm test:git $(cat .env.agent)"])("refuses command text %s", check => {
    expect(() => parseReplayCheck(check, [file])).toThrow("zstack_check_unsupported");
  });
  it("counts a catch only when the same fixed regression assertions pass green and fail red", async () => {
    const projection = prepared(), run = vi.fn().mockResolvedValueOnce(green).mockResolvedValueOnce(red);
    const result = await replayCase(entry, { cwd: "/repo", prepare: async () => projection, run });
    expect(result).toMatchObject({ status: "caught", code: "regression_detected", fixed: projection.fixed, parent: projection.parent });
    expect(run.mock.calls.map(call => call[1].cwd)).toEqual(["/fixed", "/parent"]);
    expect(projection.dispose).toHaveBeenCalledOnce();
  });
  it.each([0, 1])("does not let a passing same-name sibling authorize failed parameterized row %s", async failedIndex => {
    const run = (command, options) => {
      const statuses = options.cwd === "/fixed" ? ["passed", "pending"] : [0, 1].map(index => index === failedIndex ? "failed" : "passed");
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123 });
      const spawn = () => { queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ numTotalTests: 2,
          numPassedTests: statuses.filter(status => status === "passed").length,
          numFailedTests: statuses.filter(status => status === "failed").length,
          numPendingTests: statuses.filter(status => status === "pending").length, success: options.cwd === "/fixed",
          testResults: [{ name: path.join(options.cwd, file), assertionResults: statuses.map(status => ({ fullName: "same parameterized name", status })) }] }));
        child.emit("close", options.cwd === "/fixed" ? 0 : 1, null);
      }); return child; };
      return runCommand(command, { ...options, spawn, kill: vi.fn(), timeoutMs: 1000 });
    };
    expect(await replayCase(entry, { cwd: "/repo", prepare: async () => prepared(), run }))
      .toMatchObject(failedIndex === 0 ? { status: "caught", code: "regression_detected" } : { status: "unverified", code: "assertions_changed" });
  });
  it.each(["spawn_failed", "test_report_invalid", "test_environment_failed", "deadline"])("does not count %s as a catch", async code => {
    const projection = prepared(), run = vi.fn().mockResolvedValueOnce(green).mockResolvedValueOnce({ status: "failed", code });
    expect(await replayCase(entry, { cwd: "/repo", prepare: async () => projection, run })).toMatchObject({ status: "unverified", code });
    expect(projection.dispose).toHaveBeenCalledOnce();
  });
  it("does not run the parent when fixed is red or compare unrelated assertion failures", async () => {
    const projection = prepared(), run = vi.fn(async () => red);
    expect(await replayCase(entry, { cwd: "/repo", prepare: async () => projection, run })).toMatchObject({ status: "unverified", code: "fixed_failed" });
    expect(run).toHaveBeenCalledOnce();
    const unrelated = { ...red, tests: { ...red.tests, identities: [{ id: "foreign", status: "failed" }] } };
    expect(await replayCase(entry, { cwd: "/repo", prepare: async () => prepared(), run: vi.fn().mockResolvedValueOnce(green).mockResolvedValueOnce(unrelated) }))
      .toMatchObject({ status: "unverified", code: "assertions_changed" });
  });
  it("records a missed regression without treating a green parent as a catch", async () => {
    expect(await replayCase(entry, { cwd: "/repo", prepare: async () => prepared(), run: async () => green })).toMatchObject({ status: "missed", code: "parent_passed" });
  });
  it("never lowers the baseline by dropping a case or changing its immutable input", () => {
    const result = { id: "regression", fixed: "a".repeat(40), parent: "b".repeat(40), checkSha256: "c".repeat(64), status: "caught" };
    expect(compareEvalReceipts({ cases: [result] }, { cases: [] }).allowed).toBe(false);
    expect(compareEvalReceipts({ cases: [result] }, { cases: [{ ...result, status: "missed" }] }).allowed).toBe(false);
    expect(compareEvalReceipts({ cases: [result] }, { cases: [{ ...result, fixed: "d".repeat(40) }] }).allowed).toBe(false);
    expect(compareEvalReceipts({ cases: [result] }, { cases: [result] })).toMatchObject({ allowed: true, caughtDelta: 0 });
    expect(compareEvalReceipts({ cases: [result] }, { cases: [result, result] }).allowed).toBe(false);
    expect(compareEvalReceipts({ cases: [result] }, { cases: [result, { ...result, id: "new-case", status: "missed" }] }).allowed).toBe(false);
  });
  it("applies only one exact seed, refusing stale or ambiguous mutation targets", () => {
    const seed = { file: "module.ts", before: "if (current === request)", after: "if (true)" };
    expect(applySeed("if (current === request) commit();", seed)).toBe("if (true) commit();");
    expect(() => applySeed("already different", seed)).toThrow("zstack_seed_not_applicable");
    expect(() => applySeed("if (current === request) if (current === request)", seed)).toThrow("zstack_seed_not_applicable");
    expect(() => applySeed("if (current === request)", { ...seed, file: ".env.agent" })).toThrow("zstack_seed_invalid");
  });
});

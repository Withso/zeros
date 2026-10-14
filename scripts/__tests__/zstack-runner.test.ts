import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, open, readFile, rm, symlink, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPolicy } from "../ci/scope.mjs";
import { planVerification } from "../zstack/check-plan.mjs";
import { runCommand, executeVerification, childEnvironment, writeReceipt } from "../zstack/runner.mjs";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const command = { id: "lint", argv: ["pnpm", "lint"], kind: "check" };
const digest = "c".repeat(64);
const metadata = { mode: "master-subagents", agent: "P GPT-6 Astra", master: "Claude", packVersion: "0.1.6" };
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: vi.fn() });
  return child;
}
async function reportedTests(assertions: Array<{ fullName: string; status: string; failureMessages?: string[] }>) {
  const child = fakeChild(), failed = assertions.filter(test => test.status === "failed").length;
  const spawn = vi.fn(() => { queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ numTotalTests: assertions.length,
      numPassedTests: assertions.filter(test => test.status === "passed").length, numFailedTests: failed,
      numPendingTests: assertions.filter(test => test.status === "pending").length,
      testResults: [{ name: path.join(process.cwd(), "scripts/__tests__/fixture.test.ts"), assertionResults: assertions }], success: failed === 0 }));
    child.emit("close", failed ? 1 : 0, null);
  }); return child; });
  return runCommand({ ...command, kind: "vitest" }, { cwd: process.cwd(), spawn, kill: vi.fn(), timeoutMs: 1000 });
}
function plan() {
  return planVerification({ policy: loadPolicy(), platform: "linux", files: ["scripts/__tests__/zstack-runner.test.ts"],
    evidence: { baseSha: "b".repeat(40), sourceSha: "a".repeat(40), fingerprint: digest, complete: true,
      changes: [{ path: "scripts/__tests__/zstack-runner.test.ts", status: "M" }] } });
}

describe("bounded zstack execution and receipts", () => {
  it("passes argv without a shell, withholds child output and excludes credentials from child env", async () => {
    const child = fakeChild();
    const spawn = vi.fn((_file, _args, options) => {
      expect(options.shell).toBe(false);
      queueMicrotask(() => { child.stdout.write("synthetic private output"); child.stderr.write("synthetic failure"); child.emit("close", 7, null); });
      return child;
    });
    const result = await runCommand(command, { cwd: process.cwd(), spawn, timeoutMs: 1000, kill: vi.fn() });
    expect(result).toMatchObject({ status: "failed", code: "check_failed", exitCode: 7 });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    const env = childEnvironment({ PATH: "/usr/bin", HOME: "/tmp/home", LANG: "C.UTF-8", WORKOS_ALPHA_API_KEY: "synthetic", GITHUB_TOKEN: "synthetic",
      NODE_OPTIONS: "--import=/tmp/untrusted.mjs", ZEROS_DEV_PASSWORD: "synthetic", AGENT_RUNTIME_OPENAI_API_KEY: "synthetic" });
    expect(env).toMatchObject({ PATH: "/usr/bin", LANG: "C.UTF-8" });
    expect(Object.keys(env).some(key => /TOKEN|PASSWORD|KEY|NODE_OPTIONS/.test(key))).toBe(false);
  });

  it("cancels and reaps its child at the output bound without a sleep", async () => {
    const child = fakeChild(), kill = vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); });
    const spawn = vi.fn(() => { queueMicrotask(() => child.stdout.write("x".repeat(33))); return child; });
    expect(await runCommand(command, { cwd: process.cwd(), spawn, kill, maxOutputBytes: 32, timeoutMs: 1000 }))
      .toMatchObject({ status: "failed", code: "output_limit" });
    expect(kill).toHaveBeenCalledWith(123, "SIGTERM");
  });

  it("reports cancellation separately from a failed assertion", async () => {
    const child = fakeChild(), controller = new AbortController();
    const kill = vi.fn(() => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); });
    const spawn = vi.fn(() => { queueMicrotask(() => controller.abort()); return child; });
    expect(await runCommand(command, { cwd: process.cwd(), spawn, kill, signal: controller.signal, timeoutMs: 1000 }))
      .toMatchObject({ status: "failed", code: "cancelled" });
  });

  it("distinguishes assertion failures, empty test selection and import failures", async () => {
    for (const [total, failed, expected] of [[3, 1, "tests_failed"], [0, 0, "test_report_invalid"]] as const) {
      const child = fakeChild();
      const spawn = vi.fn(() => { queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ numTotalTests: total, numPassedTests: total - failed, numFailedTests: failed,
          numPendingTests: 0, testResults: total ? [{ assertionResults: Array.from({ length: total }, (_, i) => ({ status: i < failed ? "failed" : "passed" })) }] : [], success: false }));
        child.emit("close", 1, null);
      }); return child; });
      expect(await runCommand({ id: "adjacent", argv: ["pnpm", "test:git", "scripts/__tests__/zstack-runner.test.ts"], kind: "vitest" },
        { cwd: process.cwd(), spawn, kill: vi.fn(), timeoutMs: 1000 })).toMatchObject({ code: expected });
    }
  });

  it("halts on the first check failure and retains platform/CI work as unverified", async () => {
    const value = plan(), run = vi.fn(async () => ({ status: "failed", code: "check_failed", exitCode: 2, durationMs: 1, outputBytes: 0, outputSha256: "d".repeat(64), tests: null }));
    const receipt = await executeVerification(value, { cwd: process.cwd(), metadata, fingerprint: async () => digest, run });
    expect(run).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({ schema: "zeros.zstack-receipt/v1", status: "failed", code: "check_failed", mode: "master-subagents" });
    expect(receipt.unverified.length).toBeGreaterThan(0);
    expect(receipt.results[0].argv).toEqual(value.local[0].argv);
  });

  it("does not count a missing dependency thrown inside a test as a caught assertion", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => { queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0,
        testResults: [{ assertionResults: [{ status: "failed", fullName: "uses a host tool", failureMessages: ["spawn dpkg-deb ENOENT"] }] }], success: false }));
      child.emit("close", 1, null);
    }); return child; });
    expect(await runCommand({ ...command, kind: "vitest" }, { cwd: process.cwd(), spawn, kill: vi.fn(), timeoutMs: 1000 }))
      .toMatchObject({ code: "test_environment_failed" });
  });

  it.each([
    "Error: ENOENT: no such file or directory, lstat '/synthetic/.env.agent.zeros-dev-lock'",
    "Error: EACCES: permission denied, open '/synthetic/workspace/receipt'",
    "Error: connect ECONNREFUSED 127.0.0.1:1234",
    "Error: Cannot find module './runtime-engine-import'",
    "AssertionError: expected 'spawn dpkg-deb ENOENT' to equal 'ok'",
    "AssertionError: expected insufficient_space to be refused",
  ])("retains the product failure instead of inferring a host prerequisite from %s", async message => {
    expect(await reportedTests([{ fullName: "observes the product boundary", status: "failed", failureMessages: [message] }]))
      .toMatchObject({ code: "tests_failed", tests: { failed: 1, environmentFailed: false } });
  });

  it.each([
    "Error: spawn dpkg-deb ENOENT\n    at syntheticToolBoundary",
    "Error: spawn /usr/bin/git EACCES",
    "Error: ENOSPC: no space left on device, write",
    "Error: Test timed out in 5000ms.",
  ])("keeps an explicit host or test-runner precondition unverified: %s", async message => {
    expect(await reportedTests([{ fullName: "needs a prerequisite", status: "failed", failureMessages: [message] }]))
      .toMatchObject({ code: "test_environment_failed" });
  });

  it("gives duplicate parameterized names distinct, status-independent identities", async () => {
    const green = await reportedTests([{ fullName: "reconciles %s", status: "passed" }, { fullName: "reconciles %s", status: "pending" }]);
    const red = await reportedTests([{ fullName: "reconciles %s", status: "passed" }, { fullName: "reconciles %s", status: "failed" }]);
    const ids = green.tests!.identities.map(test => test.id);
    expect(new Set(ids).size).toBe(2);
    expect(red.tests!.identities.map(test => test.id)).toEqual(ids);
  });

  it("refuses a stale plan before running and detects a source change during verification", async () => {
    const run = vi.fn(async () => ({ status: "passed", code: "ok", exitCode: 0, durationMs: 1, outputBytes: 0, outputSha256: "d".repeat(64), tests: null }));
    const early = await executeVerification(plan(), { cwd: process.cwd(), metadata, fingerprint: async () => "e".repeat(64), run });
    expect(early.code).toBe("source_changed"); expect(run).not.toHaveBeenCalled();
    let reads = 0;
    const during = await executeVerification(plan(), { cwd: process.cwd(), metadata, fingerprint: async () => ++reads === 1 ? digest : "e".repeat(64), run });
    expect(during.code).toBe("source_changed"); expect(run).toHaveBeenCalledOnce();
  });

  it("writes one owned descriptor-validated receipt and refuses overwrite or alias", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zstack-receipt-")); roots.push(root);
    const file = path.join(root, "receipt.json");
    const receipt = await executeVerification(plan(), { cwd: process.cwd(), metadata, fingerprint: async () => digest,
      run: async () => ({ status: "passed", code: "ok", exitCode: 0, durationMs: 1, outputBytes: 0, outputSha256: "d".repeat(64), tests: null }) });
    await writeReceipt(file, receipt);
    const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { expect((await input.stat()).mode & 0o777).toBe(0o600); expect(JSON.parse(await input.readFile("utf8"))).toEqual(receipt); }
    finally { await input.close(); }
    await expect(writeReceipt(file, receipt)).rejects.toThrow("zstack_receipt_unsafe");
    const alias = path.join(root, "alias.json"); await symlink(file, alias);
    await expect(writeReceipt(alias, receipt)).rejects.toThrow("zstack_receipt_unsafe");
    expect(await readFile(file, "utf8")).not.toContain("synthetic private output");
  });
  it("refuses an output directory other processes can replace entries in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zstack-receipt-writable-")); roots.push(root);
    await chmod(root, 0o777);
    await expect(writeReceipt(path.join(root, "receipt.json"), { status: "synthetic" })).rejects.toThrow("zstack_receipt_unsafe");
  });
});

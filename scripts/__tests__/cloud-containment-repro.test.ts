import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containmentRepro, loadReproCredentials, redactReproText, reproBudget, REPRO_RUNTIME } from "../cloud-workspace-validation/containment-repro";
import type { KitDeps } from "../cloud-workspace-validation/boat-image/boat-image";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const diagnostic = (component: string, failedChecks: string[] = []) => ({ schema: "zeros.diagnostic/v1", component,
  stage: component === "installer" ? "done" : "self_test", ok: failedChecks.length === 0,
  exitCode: failedChecks.length ? 1 : 0, timedOut: false, failedChecks });
const baseStatus = { schema: "zeros.base-status/v1", baseCompatibilityId: `bc1-${"a".repeat(64)}`,
  bootId: "11111111-1111-4111-8111-111111111111", currentRuntimeId: null as string | null, hostState: "waiting_for_runtime" };

function fixture(options: { fail?: string; wallet?: string; lostCreate?: boolean; lostDelete?: boolean; noReport?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-v2-test-containment-")); directories.push(directory);
  let now = 0, deleted = false, creates = 0, statusCalls = 0, deletes = 0;
  const seen: { method: string; endpoint: string; options: any }[] = [];
  const boat = vi.fn(async (method: string, endpoint: string, input: any = {}) => {
    seen.push({ method, endpoint, options: input });
    if (endpoint.startsWith("/limits?")) return { status: 200, body: { creditUsedSeconds: 24.6 * 3600 } };
    if (method === "POST" && endpoint === "/sandboxes") {
      if (options.lostCreate && creates++ === 0) throw new Error("untrusted provider content");
      return { status: 200, body: { sandbox: { id: "bx_repro", team: { id: options.wallet ?? "test-org" }, state: "idle" } } };
    }
    if (method === "DELETE") {
      if (deleted) return { status: 404, body: {} };
      deleted = true;
      if (options.lostDelete && deletes++ === 0) throw new Error("lost deletion reply");
      return { status: 202, body: { operation: { id: `bdop_${"1".repeat(32)}`, kind: "sandbox", targetId: "bx_repro", status: "pending" } } };
    }
    if (endpoint.startsWith("/deletion-operations/")) return { status: 200, body: {
      operation: { id: `bdop_${"1".repeat(32)}`, kind: "sandbox", targetId: "bx_repro", status: "completed" } } };
    if (endpoint === "/sandboxes/bx_repro") return deleted ? { status: 404, body: {} } :
      { status: 200, body: { sandbox: { id: "bx_repro", team: { id: options.wallet ?? "test-org" }, state: "idle" } } };
    if (endpoint.endsWith("/commands")) {
      if (input.body.command.includes("bootstrap.py status")) {
        statusCalls++;
        const status = { ...baseStatus, ...(statusCalls > 1 ? { currentRuntimeId: REPRO_RUNTIME.runtimeId, hostState: "idle" } : {}) };
        return { status: 200, body: { success: true, exitCode: 0, stdout: JSON.stringify(status) } };
      }
      if (options.fail === "probe") throw new Error("untrusted provider content");
      return { status: 200, body: { success: true, exitCode: 0, stdout: JSON.stringify({
        mode: /main\("(qualify|launch_detail|host)"/.exec(input.body.command)?.[1],
        exitCode: 1, report: options.noReport ? null : { version: 1, secure: false, identity: { secure: false,
          checks: [{ name: "fixed-engine-user-namespace", status: "fail" }] } }, stderr: "ghp_" + "q".repeat(40),
      }) } };
    }
    throw new Error("Unexpected provider request");
  });
  const deps: KitDeps = { boat, billingOrg: "test-org", stateDir: directory, repoRoot: process.cwd(),
    now: () => now, randomUUID: () => "11111111-1111-4111-8111-111111111111", randomHex: () => "1".repeat(32), imageContract: () => "unused" };
  const execute = vi.fn(async (input: { command: string; stdin: string }) => {
    if (options.fail === "ssh") throw new Error("never emit this private failure");
    const result = input.stdin ? diagnostic("installer", options.fail === "install" ? ["archive_digest"] : []) :
      diagnostic("qualification", ["containment_smoke"]);
    return { exitCode: result.exitCode, output: JSON.stringify(result), outputTruncated: false };
  });
  const output: any[] = [];
  const run = () => containmentRepro({ deps, maxUsedHours: 32, r2: { endpoint: "https://" + "a".repeat(32) + ".r2.cloudflarestorage.com",
    bucket: "zeros-cloud-workspaces-alpha", accessKeyId: "test-access", secretAccessKey: "test-secret" },
    execute, wait: async ms => { now += ms; }, emit: value => output.push(value) });
  return { run, seen, execute, output, directory, deps };
}

describe("one-shot Alpha containment reproduction", () => {
  it("keeps the budget explicit and capped at the authorized 32 hours", () => {
    expect(reproBudget(["--max-used-hours", "32"])).toBe(32);
    for (const args of [[], ["--max-used-hours", "33"], ["--max-used-hours", "0"], ["--max-used-hours", "32", "extra"]])
      expect(() => reproBudget(args)).toThrow();
  });
  it("requires the repo credential file rather than falling back to process credentials", () => {
    const f = fixture();
    vi.stubEnv("BOAT_API_KEY", "test-ambient");
    try { expect(() => loadReproCredentials(f.directory)).toThrow(); }
    finally { vi.unstubAllEnvs(); }
  });
  it("creates in the org wallet, sends the exact published descriptor only on SSH stdin, captures a failure, and confirms deletion", async () => {
    const f = fixture();
    await f.run();
    const create = f.seen.find(call => call.method === "POST" && call.endpoint === "/sandboxes")!;
    expect(create.options.body).toMatchObject({ from: "zeros-v2-test-base-v4-3", noEnv: true, env: {}, snapshots: true });
    expect(create.options.body.name).toMatch(/^zeros-v2-test-/);
    expect(f.seen.every(call => call.options.headers["x-boat-org"] === "test-org")).toBe(true);
    const input = JSON.parse(Buffer.from(f.execute.mock.calls[0][0].stdin, "base64url").toString());
    expect(input).toMatchObject({ schema: "zeros.runtime-install/v1", purpose: "qualification", runtime: REPRO_RUNTIME });
    expect(input).not.toHaveProperty("setup");
    expect(new URL(input.artifact.url).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(JSON.stringify(f.seen)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(f.output)).not.toContain("X-Amz-Signature");
    expect(f.output).toContainEqual(diagnostic("qualification", ["containment_smoke"]));
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true, status: "completed" });
    expect(f.seen.find(call => call.method === "DELETE")!.options.headers["x-ascii-confirm-delete"]).toBe("bx_repro");
    expect(JSON.stringify(f.output)).not.toContain("ghp_");
  });
  it.each(["ssh", "install", "probe"])("confirms cleanup after %s failure without exposing exceptions", async fail => {
    const f = fixture({ fail });
    await expect(f.run()).rejects.toThrow();
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true });
    expect(JSON.stringify(f.output)).not.toContain("private failure");
  });
  it("cleans a wrong-wallet create before any installer or probe executes", async () => {
    const f = fixture({ wallet: "wrong-org" });
    await expect(f.run()).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true });
  });
  it("replays a lost create response with the same idempotency key and deletes the recovered VM", async () => {
    const f = fixture({ lostCreate: true });
    await f.run();
    const creates = f.seen.filter(call => call.endpoint === "/sandboxes");
    expect(creates).toHaveLength(2);
    expect(creates[0].options).toEqual(creates[1].options);
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true });
  });
  it("confirms absence after a lost DELETE response rather than abandoning cleanup", async () => {
    const f = fixture({ lostDelete: true });
    await f.run();
    expect(f.seen.filter(call => call.method === "DELETE")).toHaveLength(2);
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true });
  });
  it("captures the exported launcher's error when the CLI cannot produce a containment report", async () => {
    const f = fixture({ noReport: true });
    await f.run();
    expect(f.output.filter(value => ["qualify", "launch_detail"].includes(value.event)).map(value => value.event))
      .toEqual(["qualify", "launch_detail"]);
    expect(f.output.at(-1)).toMatchObject({ event: "cleanup", absent: true });
  });
  it("redacts before truncation, including credentials, URLs, assignments and opaque token shapes", () => {
    const secret = "non-token-shaped-secret";
    const result = redactReproText(`TypeError: ${secret} https://example.invalid/?sig=value\nAPI_KEY=fixture_value\nBearer fixture\n` +
      `gho_${"a".repeat(35)} ${"b".repeat(64)} eyJ${"c".repeat(40)}.eyJ${"d".repeat(40)}.signature`, [secret]);
    for (const value of [secret, "https://", "fixture_value", "Bearer fixture", "gho_", "b".repeat(64), "eyJ"])
      expect(result).not.toContain(value);
    expect(result).toContain("TypeError");
    expect(redactReproText("x".repeat(3000) + secret, [secret]).length).toBeLessThanOrEqual(2000);
  });
});

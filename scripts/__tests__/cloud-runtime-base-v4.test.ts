import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sshBoundary from "../../apps/control-plane/src/cloud-workspaces/boat-setup-runner";
import { builderCommand, KitError, main, parseArgs, type KitDeps } from "../cloud-workspace-validation/boat-image/boat-image";
import { basePayload, buildBase, closedFailure, parseProbe, profileDeps, resumeOwned, v4Command, waitSandbox } from "../cloud-workspace-validation/boat-image/runtime-base-v4";
import { cleanupLiveObjects, installOverSsh, presignGet, signedHeaders, syntheticArchives, uploadLiveObject } from "../cloud-workspace-validation/runtime-base-v4/live-check";

const scratch: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-base-v4-")); scratch.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = path.join(ROOT, "scripts/cloud-workspace-validation/runtime-base-v4");

function deps(): KitDeps & { calls: { method: string; route: string; body: unknown; headers: unknown }[] } {
  const calls: { method: string; route: string; body: unknown; headers: unknown }[] = [];
  return {
    calls, billingOrg: "test-org", stateDir: temp(), repoRoot: ROOT, imageContract: () => "unused",
    now: () => Date.parse("2026-10-04T00:00:00Z"), randomHex: () => "1".repeat(32), randomUUID: () => "test-operation",
    boat: async (method, route, options = {}) => {
      calls.push({ method, route, body: options.body, headers: options.headers });
      if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 1 } };
      if (method === "POST" && route === "/sandboxes") return { status: 202, body: { sandbox: { id: "bx_testv4", team: { id: "test-org" } } } };
      throw new Error("unexpected fixture request");
    },
  };
}

function fullKit(failColdBoot = false) {
  const d = deps(), root = temp();
  const relative = "scripts/cloud-workspace-validation";
  fs.mkdirSync(path.join(root, relative), { recursive: true });
  for (const directory of ["runtime-base-v4", "boat-image/templates"]) {
    fs.cpSync(path.join(ROOT, relative, directory), path.join(root, relative, directory), { recursive: true, filter: source => !source.includes("__pycache__") });
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  d.repoRoot = root;
  const machines = new Set<string>();
  let sequence = 0, snapshot: any;
  const requests: { method: string; route: string; body: any }[] = [];
  d.boat = async (method, route, options = {}) => {
    const body: any = options.body;
    requests.push({ method, route, body });
    if (route.startsWith("/limits")) return { status: 200, body: { creditUsedSeconds: 1 } };
    if (route === "/sandboxes" && method === "POST") {
      const id = `bx_v4test${++sequence}`;
      machines.add(id);
      return { status: 202, body: { sandbox: { id, team: { id: d.billingOrg }, state: "ready" } } };
    }
    const id = route.split("/")[2];
    if (method === "PUT" && route.endsWith("/files")) return { status: 200, body: { size: Buffer.from(body.content, "base64").length } };
    if (method === "PATCH") return { status: 200, body: {} };
    if (route.startsWith("/sandboxes/") && !route.endsWith("/commands")) {
      if (method === "DELETE") { machines.delete(id); return { status: 202, body: {} }; }
      return { status: machines.has(id) ? 200 : 404, body: { sandbox: { id, state: "ready", team: { id: d.billingOrg } } } };
    }
    if (route === "/named-snapshots" && method === "GET") return { status: 200, body: { snapshots: [] } };
    if (route === "/named-snapshots" && method === "POST") {
      // The intent must already be durable before the provider captures.
      const ledger = JSON.parse(fs.readFileSync(path.join(d.stateDir, "runtime-base-v4", commit.slice(0, 12), "snapshot-ledger.json"), "utf8"));
      expect(ledger).toMatchObject({ name: body.name, resourceId: body.sandboxId, state: "save-pending" });
      snapshot = { name: body.name, sourceSandboxId: body.sandboxId, status: "ready", snapshotId: "snapshot_fixture", sizeBytes: 1024 };
      return { status: 202, body: { snapshot } };
    }
    if (route.startsWith("/named-snapshots/")) {
      if (method === "DELETE") snapshot = undefined;
      return { status: snapshot ? 200 : 404, body: { snapshot } };
    }
    if (route.endsWith("/commands")) {
      const command: string = body.command;
      if (command.includes("zeros.base-private-evidence/v1")) {
        const artifact = /ARTIFACT = "([a-z-]+)"/.exec(command)![1];
        return { status: 200, body: { exitCode: 0, stdout: JSON.stringify({ schema: "zeros.base-private-evidence/v1", artifact,
          outcome: "captured", data: Buffer.from("fixture evidence\n").toString("base64") }) } };
      }
      const stage = command.includes("def verify()") ? "verify" : command.includes("def sanitize()") ? "sanitize" : "build";
      const fail = failColdBoot && stage === "verify" && id.endsWith("2");
      const value = stage === "verify" ? { schema: "zeros.base-verification/v1", baseCompatibilityId: `bc1-${"a".repeat(64)}`,
        baseBuildSha256: "b".repeat(64), sourceCommit: commit, hostState: "waiting_for_runtime",
        bootId: `00000000-0000-4000-8000-${id.endsWith("2") ? "2" : "1"}`.padEnd(36, "0"),
        versions: { systemd: 255, glibc: "2.39", arch: "x86_64", kernel: "6.8.0", python: "3.12.3" },
        checks: ["base_compatibility", "uid_map", "apparmor", "cgroup_controllers", "root_ownership", "host_start", "private_state"] }
        : stage === "sanitize" ? { clean: true } : command.includes("'result.json'") ? { finished: true, code: 0, passed: true, retired: true } : { started: true };
      const diagnostic = { schema: "zeros.diagnostic/v1", component: "base", stage, ok: !fail, exitCode: fail ? 1 : 0, timedOut: false, failedChecks: fail ? ["host_start"] : [] };
      return { status: 200, body: { exitCode: fail ? 1 : 0, stdout: JSON.stringify(value) + "\n" + JSON.stringify(diagnostic), stderr: "never persist private-canary" } };
    }
    throw new Error("unexpected fixture operation");
  };
  return { d, requests, machines, getSnapshot: () => snapshot };
}

function seedState(d: KitDeps, overrides = {}) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d.repoRoot, encoding: "utf8" }).trim();
  const state = { schema: "zeros.base-kit-state/v1", sourceCommit: commit, billingOrg: d.billingOrg,
    sourceSha256: basePayload(d.repoRoot, commit, "1".repeat(32)).sourceSha256, attemptHex: "1".repeat(32),
    name: "zeros-v2-test-base-v4-1", maxUsedHours: 2, starts: 1, phase: "building", ...overrides };
  const directory = path.join(d.stateDir, "runtime-base-v4");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "state.json"), JSON.stringify(state));
  return { ...d, stateDir: directory };
}

describe("runtime-base-v4 profile", () => {
  it.each(["ready", "idle", "running"])("accepts Boat %s as command-ready", async state => {
    vi.useFakeTimers();
    const d = deps();
    d.boat = vi.fn().mockResolvedValue({ status: 200, body: { sandbox: { id: "bx_fixture", state, team: { id: d.billingOrg } } } });
    let outcome: unknown = "pending";
    const pending = waitSandbox(d, "bx_fixture").then(() => { outcome = "ready"; }, error => { outcome = closedFailure(error); });
    await vi.runAllTimersAsync();
    await pending;
    expect(outcome).toBe("ready");
    expect(d.boat).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "cancelled", "archived"])("rejects terminal Boat %s before the readiness timeout", async state => {
    vi.useFakeTimers();
    const d = deps();
    d.boat = vi.fn().mockResolvedValue({ status: 200, body: { sandbox: { id: "bx_fixture", state, team: { id: d.billingOrg } } } });
    let outcome: unknown;
    const pending = waitSandbox(d, "bx_fixture").catch(error => { outcome = closedFailure(error); });
    await vi.runAllTimersAsync();
    await pending;
    expect(outcome).toMatchObject({ stage: "create", timedOut: false, failedChecks: ["provider_request"] });
    expect(d.boat).toHaveBeenCalledTimes(1);
  });

  it("waits through command-ready states when archival is requested", async () => {
    vi.useFakeTimers();
    const d = deps();
    d.boat = vi.fn()
      .mockResolvedValueOnce({ status: 200, body: { sandbox: { id: "bx_fixture", state: "idle", team: { id: d.billingOrg } } } })
      .mockResolvedValueOnce({ status: 200, body: { sandbox: { id: "bx_fixture", state: "archived", team: { id: d.billingOrg } } } });
    const pending = waitSandbox(d, "bx_fixture", "archived");
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(d.boat).toHaveBeenCalledTimes(2);
  });

  it("reports only safe exception identities to stderr while keeping the stdout diagnostic closed", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const missing = Object.assign(new Error("private-canary dependency path and URL"), { code: "ERR_MODULE_NOT_FOUND" });
    const diagnostic = closedFailure(missing);
    expect(diagnostic).toMatchObject({ stage: "validate_input", failedChecks: ["diagnostic_missing"] });
    expect(stderr).toHaveBeenLastCalledWith("[boat-image] Error (ERR_MODULE_NOT_FOUND)");
    closedFailure(new KitError("private-canary"));
    expect(stderr).toHaveBeenLastCalledWith("[boat-image] KitError");
    closedFailure({ name: "private-canary", code: "private-canary", message: "private-canary" });
    expect(stderr).toHaveBeenLastCalledWith("[boat-image] UnknownError");
    expect(JSON.stringify(stderr.mock.calls) + JSON.stringify(diagnostic)).not.toContain("private-canary");
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    { at: "budget", error: Object.assign(new TypeError("private-canary"), { code: "ECONNRESET" }), identity: "TypeError (ECONNRESET)", stage: "create" },
    { at: "create", error: new KitError("private-canary"), identity: "KitError", stage: "create" },
    { at: "remote", error: Object.assign(new Error("private-canary"), { code: "ERR_MODULE_NOT_FOUND" }), identity: "Error (ERR_MODULE_NOT_FOUND)", stage: "build" },
  ])("retains safe error identity through the build CLI failure path at $at", async ({ at, error, identity, stage }) => {
    const f = fullKit(), original = f.d.boat;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let injected = false;
    f.d.boat = async (method, route, options) => {
      if (!injected && (at === "budget" && route.startsWith("/limits") ||
          at === "create" && method === "PATCH" || at === "remote" && route.endsWith("/commands"))) {
        injected = true;
        throw error;
      }
      return original(method, route, options);
    };
    // Follow the real CLI's catch path with the exception produced by buildBase,
    // including its provider wrappers and cleanup, rather than a direct error.
    await v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d)
      .catch(failure => console.log(JSON.stringify(closedFailure(failure))));
    expect(injected).toBe(true);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(`[boat-image] ${identity}`);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      schema: "zeros.diagnostic/v1", component: "base", stage, ok: false, exitCode: 1, timedOut: false, failedChecks: ["provider_request"],
    }));
    expect(JSON.stringify([...stderr.mock.calls, ...stdout.mock.calls])).not.toContain("private-canary");
    expect(f.machines.size).toBe(0);
    if (at === "budget") expect(f.requests).toHaveLength(0);
  });

  it("creates from stock with the kit's budget and idempotency journal", async () => {
    const d = deps();
    const options = new Map([["--profile", "runtime-base-v4"], ["--max-used-hours", "2"]]);
    await expect(builderCommand("create", options, [], d)).resolves.toMatchObject({ id: "bx_testv4" });
    const create = d.calls.find(call => call.method === "POST")!;
    expect(create.body).toEqual({ type: "default", ttlSeconds: 3600, noEnv: true, env: {} });
    expect(create.headers).toEqual({ "idempotency-key": "test-operation", "x-boat-org": "test-org" });
    expect(JSON.parse(fs.readFileSync(path.join(d.stateDir, "builder.json"), "utf8")).id).toBe("bx_testv4");
  });

  it("requires an explicit meter budget and refuses a v3 parent", async () => {
    const d = deps();
    await expect(builderCommand("create", new Map([["--profile", "runtime-base-v4"]]), [], d)).rejects.toThrow("--max-used-hours");
    await expect(builderCommand("create", new Map([["--profile", "runtime-base-v4"], ["--from", "legacy"]]), [], d)).rejects.toThrow("stock image");
    expect(d.calls).toHaveLength(0);
  });

  it("can clean up when verification failed before the first allocation", async () => {
    const d = deps();
    await expect(v4Command("cleanup", new Map(), [], d)).resolves.toMatchObject({ sandboxes: [], objects: [], snapshot: "not_created" });
    expect(d.calls).toHaveLength(0);
  });

  it.each([null, { id: "another-org" }, undefined])("rejects a recorded builder whose observed wallet is %j before upload", async team => {
    const f = fullKit(), original = f.d.boat;
    const profile = seedState(f.d);
    fs.writeFileSync(path.join(profile.stateDir, "builder.json"), JSON.stringify({ id: "bx_v4test1" }));
    f.machines.add("bx_v4test1");
    f.d.boat = async (method, route, options) => {
      const response = await original(method, route, options);
      if (method === "GET" && route === "/sandboxes/bx_v4test1" && response.status === 200) response.body.sandbox.team = team;
      return response;
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "create", failedChecks: ["provider_request"] } });
    expect(f.requests.filter(request => request.method === "PUT")).toHaveLength(0);
    expect(f.requests.filter(request => request.method === "POST" && request.route === "/sandboxes")).toHaveLength(0);
  });

  it("binds saved build state to its billing organization before contacting the provider", async () => {
    const f = fullKit();
    seedState(f.d, { billingOrg: "another-org" });
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { failedChecks: ["provider_request"] } });
    expect(f.requests).toHaveLength(0);
  });

  it("rechecks a verification VM's wallet before spending a resume start", async () => {
    const f = fullKit();
    const profile = seedState(f.d);
    const clone = { ...profile, stateDir: path.join(profile.stateDir, "verification") };
    fs.mkdirSync(clone.stateDir);
    fs.writeFileSync(path.join(clone.stateDir, "builder.json"), JSON.stringify({ id: "bx_v4test2" }));
    profile.boat = vi.fn().mockResolvedValue({ status: 200, body: { sandbox: { id: "bx_v4test2", state: "archived", team: null } } });
    clone.boat = profile.boat;
    await expect(resumeOwned(profile, clone, 2)).rejects.toMatchObject({ diagnostic: { failedChecks: ["provider_request"] } });
    expect(profile.boat).toHaveBeenCalledExactlyOnceWith("GET", "/sandboxes/bx_v4test2");
    expect(JSON.parse(fs.readFileSync(path.join(profile.stateDir, "state.json"), "utf8")).starts).toBe(1);
  });

  it("recovers a deletion interrupted after acceptance and before absence was confirmed", async () => {
    const f = fullKit(), replay = temp();
    const profile = seedState(f.d);
    fs.writeFileSync(path.join(profile.stateDir, "builder.json"), JSON.stringify({ id: "bx_v4test1" }));
    let accepted = false;
    f.d.boat = async (method, route) => {
      if (method === "DELETE") { accepted = true; return { status: 202, body: {} }; }
      if (method === "GET" && route === "/sandboxes/bx_v4test1" && accepted) {
        // Persist exactly what SIGKILL would leave before the first GET reply.
        fs.cpSync(f.d.stateDir, replay, { recursive: true });
        return { status: 404, body: {} };
      }
      return { status: 200, body: { sandbox: { id: "bx_v4test1", team: { id: f.d.billingOrg }, state: "idle" } } };
    };
    await v4Command("cleanup", new Map(), [], f.d);
    expect(fs.existsSync(path.join(replay, "runtime-base-v4/builder.json"))).toBe(false);
    const retry = { ...f.d, stateDir: replay, boat: vi.fn().mockResolvedValue({ status: 404, body: {} }) };
    await expect(v4Command("cleanup", new Map(), [], retry)).resolves.toMatchObject({ confirmed: true, sandboxes: ["bx_v4test1"] });
    expect(retry.boat).toHaveBeenCalledWith("GET", "/sandboxes/bx_v4test1");
    expect(fs.existsSync(path.join(replay, "runtime-base-v4/pending-delete.json"))).toBe(false);
  });

  it("completes a stock build and cold clone, retains only the named base and confirms deletion", async () => {
    const f = fullKit();
    const result: any = await v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d);
    expect(result).toMatchObject({ schema: "zeros.runtime-base-receipt/v1", snapshotName: "zeros-v2-test-base-v4-1", snapshotId: "snapshot_fixture",
      sandboxStarts: 2, imageBytes: 1024, live: { status: "synthetic_runtime_pending" }, cleanup: { confirmed: true, snapshot: "retained" } });
    expect(result.cleanup.sandboxes).toEqual(["bx_v4test2", "bx_v4test1"]);
    expect(f.machines.size).toBe(0);
    expect(f.getSnapshot()).toBeDefined();
    const creates = f.requests.filter(request => request.route === "/sandboxes" && request.method === "POST");
    expect(creates.map(request => request.body.from)).toEqual([undefined, "zeros-v2-test-base-v4-1"]);
    expect(f.requests.filter(request => request.method === "PATCH").map(request => request.body.name)).toEqual([
      "zeros-v2-test-builder-111111111111", "zeros-v2-test-verify-111111111111",
    ]);
  }, 30_000);

  it("deletes a failed candidate snapshot and both VMs when the cold boot proof fails", async () => {
    const f = fullKit(true);
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { failedChecks: ["host_start"] } });
    expect(f.getSnapshot()).toBeUndefined();
    expect(f.machines.size).toBe(0);
    const cleanup = JSON.parse(fs.readFileSync(path.join(f.d.stateDir, "runtime-base-v4/cleanup.json"), "utf8"));
    expect(cleanup).toMatchObject({ confirmed: true, snapshot: "deleted", sandboxes: ["bx_v4test2", "bx_v4test1"] });
  }, 30_000);

  it("accepts the retention flag only for the operator live-check command", async () => {
    const parsed = parseArgs(["runtime-base-v4", "live-check", "--keep-on-failure", "--name", "zeros-v2-test-base-v4-1"]);
    expect(parsed.options.get("--keep-on-failure")).toBe("true");
    expect(parsed.operands).toEqual([]);
    expect(() => parseArgs(["builder", "create", "--keep-on-failure"])).toThrow(KitError);
    const d = deps();
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"], ["--keep-on-failure", "true"]]), [], d))
      .rejects.toMatchObject({ diagnostic: { stage: "validate_input", failedChecks: ["input_schema"] } });
    expect(d.calls).toHaveLength(0);
  });

  it("cancels oversized synthetic downloads through a reader-only stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel,
    });
    // The release compiler's DOM library exposes getReader, not async iteration.
    Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
    const request = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", request);
    await expect(syntheticArchives(deps())).rejects.toMatchObject({ diagnostic: { stage: "install", failedChecks: ["archive_digest"] } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each([false, true])("keeps live-check failure resources only when explicitly requested after reader-only downloads: %s", async keep => {
    const f = fullKit();
    vi.stubEnv("ZEROS_R2_ALPHA_ENDPOINT", `https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
    vi.stubEnv("ZEROS_R2_ALPHA_BUCKET", "zeros-cloud-workspaces-alpha");
    vi.stubEnv("ZEROS_R2_ALPHA_ACCESS_KEY_ID", "fixture-access");
    vi.stubEnv("ZEROS_R2_ALPHA_SECRET_ACCESS_KEY", "fixture-secret");
    const archive = execFileSync("python3", ["-I", "-c", `import io,sys,tarfile
out=io.BytesIO()
with tarfile.open(fileobj=out,mode='w:xz') as archive:
 node=tarfile.TarInfo('node-v22.23.1-linux-x64/bin/node')
 node.size=4
 archive.addfile(node,io.BytesIO(b'test'))
sys.stdout.buffer.write(out.getvalue())`]);
    const digest = createHash("sha256").update(archive).digest("hex");
    const download = (bytes: Buffer) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, 8)));
        controller.enqueue(new Uint8Array(bytes.subarray(8)));
        controller.close();
      } });
      Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
      return new Response(body);
    };
    const request = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/SHASUMS256.txt")) return download(Buffer.from(`${digest}  node-v22.23.1-linux-x64.tar.xz\n`));
      if (url.endsWith("/node-v22.23.1-linux-x64.tar.xz")) return download(archive);
      if (options?.method === "PUT" || options?.method === "DELETE") return new Response(null, { status: 200 });
      if (options?.method === "HEAD") return new Response(null, { status: 404 });
      throw new Error("unexpected fixture request");
    });
    vi.stubGlobal("fetch", request);
    vi.spyOn(sshBoundary, "openBoatBootstrapChannel").mockRejectedValue(new Error("private-canary"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(main(["runtime-base-v4", "live-check", "--name", "zeros-v2-test-base-v4-1", "--max-used-hours", "2",
      ...(keep ? ["--keep-on-failure"] : [])], f.d)).rejects.toMatchObject({ diagnostic: { stage: "install", failedChecks: ["provider_request"] } });
    const profile = profileDeps(f.d);
    const stateFile = path.join(profile.stateDir, "state.json");
    if (keep) {
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).keptOnFailure).toEqual({ sandboxes: ["bx_v4test2", "bx_v4test1"] });
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
      expect(f.machines.size).toBe(2);
      expect(f.getSnapshot()).toBeDefined();
      expect(f.requests.filter(request => request.method === "DELETE")).toHaveLength(0);
      expect(request.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(0);
      expect(fs.existsSync(path.join(profile.stateDir, "cleanup.json"))).toBe(false);
      expect(fs.existsSync(path.join(profile.stateDir, "synthetic"))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(profile.stateDir, "r2-objects.json"), "utf8")).every((object: any) => !object.deleted)).toBe(true);
      await expect(v4Command("cleanup", new Map(), [], f.d)).resolves.toMatchObject({ confirmed: true, snapshot: "deleted" });
    }
    expect(f.machines.size).toBe(0);
    expect(f.getSnapshot()).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).keptOnFailure).toBeUndefined();
    expect(request.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(3);
    for (const id of ["bx_v4test1", "bx_v4test2"]) {
      const journal = path.join(profile.stateDir, "private", `m2-build-${"1".repeat(32)}`, id, "journal.log");
      expect(fs.statSync(journal).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(journal, "utf8")).toBe("fixture evidence\n");
    }
    const probes = f.requests.filter(request => request.route.endsWith("/commands") && request.body.command.includes('ARTIFACT = "journal"'));
    expect(probes).toHaveLength(keep ? 4 : 2);
    for (const probe of probes) expect(probe.body.command).toContain("'--lines=200'");
  }, 30_000);

  it("still cleans up a successful operator run when keep-on-failure is enabled", async () => {
    const f = fullKit();
    await expect(buildBase(new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"], ["--keep-on-failure", "true"]]),
      profileDeps(f.d), async () => ({ mode: "synthetic" }))).resolves.toMatchObject({ cleanup: { confirmed: true, snapshot: "retained" } });
    expect(f.machines.size).toBe(0);
    expect(f.getSnapshot()).toBeDefined();
  });

  it("preserves owned builder timeouts and cleans up before returning a closed failure", async () => {
    const f = fullKit(), original = f.d.boat;
    f.d.boat = async (method, route, options) => {
      const result = await original(method, route, options);
      if (route.endsWith("/commands") && (options?.body as any)?.command.includes("'result.json'")) {
        const diagnostic = { schema: "zeros.diagnostic/v1", component: "base", stage: "build", ok: true,
          exitCode: 0, timedOut: false, failedChecks: [] };
        return { status: 200, body: { exitCode: 0, stdout: JSON.stringify({ finished: true, code: 124, passed: false, retired: true }) + "\n" + JSON.stringify(diagnostic) } };
      }
      return result;
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "build", exitCode: 124, timedOut: true, failedChecks: ["timeout"] } });
    expect(f.getSnapshot()).toBeUndefined();
    expect(f.machines.size).toBe(0);
  }, 30_000);

  it("retains bounded private evidence before deleting a failed builder without printing it", async () => {
    const f = fullKit(), original = f.d.boat;
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const evidence = path.join(f.d.stateDir, "runtime-base-v4/private/m2-build-" + "1".repeat(32), "bx_v4test1");
    let retainedBeforeDelete = false;
    f.d.boat = async (method, route, options) => {
      const command = (options?.body as any)?.command ?? "";
      if (command.includes("zeros.base-private-evidence/v1")) {
        const artifact = /ARTIFACT = "([a-z-]+)"/.exec(command)![1];
        const tail = ("ordinary build output\n".repeat(2000) + "AssertionError pointer_publish\n" +
          "https://private-canary.test/path?token=secret-canary\ntoken=secret-canary\n").slice(-32768);
        return { status: 200, body: { exitCode: 0, stdout: JSON.stringify({ schema: "zeros.base-private-evidence/v1", artifact,
          outcome: "captured", data: Buffer.from(tail).toString("base64") }) } };
      }
      if (method === "DELETE" && route === "/sandboxes/bx_v4test1") retainedBeforeDelete = fs.existsSync(path.join(evidence, "build.log"));
      const result = await original(method, route, options);
      if (command.includes("'result.json'")) {
        result.body.stdout = JSON.stringify({ finished: true, code: 1, passed: false, retired: true }) + "\n" +
          JSON.stringify({ schema: "zeros.diagnostic/v1", component: "base", stage: "build", ok: true, exitCode: 0, timedOut: false, failedChecks: [] });
      }
      return result;
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "build", failedChecks: ["build_exit"] } });
    expect(retainedBeforeDelete).toBe(true);
    expect(f.machines.size).toBe(0);
    expect(fs.statSync(evidence).mode & 0o777).toBe(0o700);
    for (const name of ["build.log", "systemd-status.log", "journal.log", "bootstrap-failures.jsonl"]) {
      const file = path.join(evidence, name), content = fs.readFileSync(file, "utf8");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(32768);
      expect(content).toContain("AssertionError pointer_publish");
      expect(content).not.toMatch(/private-canary|secret-canary/);
    }
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps the pre-sanitation build log when a later probe fails after its remote deletion", async () => {
    const f = fullKit(true), original = f.d.boat;
    let sanitized = false;
    f.d.boat = async (method, route, options) => {
      const command = (options?.body as any)?.command ?? "";
      const result = await original(method, route, options);
      if (command.includes("def sanitize()")) sanitized = true;
      if (command.includes("zeros.base-private-evidence/v1") && command.includes('ARTIFACT = "build"')) {
        result.body.stdout = JSON.stringify({ schema: "zeros.base-private-evidence/v1", artifact: "build",
          outcome: sanitized ? "absent" : "captured", data: sanitized ? "" : Buffer.from("build evidence retained\n").toString("base64") });
      }
      return result;
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d)).rejects.toThrow();
    const file = path.join(f.d.stateDir, "runtime-base-v4/private/m2-build-" + "1".repeat(32), "bx_v4test1/build.log");
    expect(fs.readFileSync(file, "utf8")).toBe("build evidence retained\n");
  });

  it("still cleans up and preserves the original failure when private evidence capture is unavailable", async () => {
    const f = fullKit(true), original = f.d.boat;
    f.d.boat = async (method, route, options) => {
      if ((options?.body as any)?.command?.includes("zeros.base-private-evidence/v1")) throw new Error("private-canary capture unavailable");
      return original(method, route, options);
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "verify", failedChecks: ["host_start"] } });
    expect(f.machines.size).toBe(0);
    const file = path.join(f.d.stateDir, "runtime-base-v4/private/m2-build-" + "1".repeat(32), "bx_v4test1/capture.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ build: "unavailable", journal: "unavailable" });
  });

  it("does not overwrite or delete an already named snapshot", async () => {
    const f = fullKit(), original = f.d.boat;
    f.d.boat = async (method, route, options) => method === "GET" && route === "/named-snapshots"
      ? { status: 200, body: { snapshots: [{ name: "zeros-v2-test-base-v4-1" }] } } : original(method, route, options);
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "snapshot", failedChecks: ["snapshot_identity"] } });
    expect(f.requests.filter(request => request.method === "DELETE" && request.route.startsWith("/named-snapshots"))).toHaveLength(0);
    expect(f.requests.filter(request => request.method === "POST" && request.route === "/named-snapshots")).toHaveLength(0);
    expect(f.machines.size).toBe(0);
  }, 30_000);

  it("reconciles and deletes an ambiguous capture without issuing another POST", async () => {
    const f = fullKit(), original = f.d.boat;
    f.d.boat = async (method, route, options) => {
      const result = await original(method, route, options);
      if (method === "POST" && route === "/named-snapshots") throw new Error("private-canary uncertain response");
      return result;
    };
    await expect(v4Command("build", new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"]]), [], f.d))
      .rejects.toMatchObject({ diagnostic: { stage: "snapshot", failedChecks: ["provider_request"] } });
    expect(f.requests.filter(request => request.method === "POST" && request.route === "/named-snapshots")).toHaveLength(1);
    expect(f.getSnapshot()).toBeUndefined();
    expect(f.machines.size).toBe(0);
  }, 30_000);

  it("uses the existing pinned SSH result contract, sends bearer input only on stdin and revokes the key", async () => {
    const key = Buffer.alloc(51);
    key.writeUInt32BE(11); key.write("ssh-ed25519", 4); key.writeUInt32BE(32, 15);
    const publicKey = `ssh-ed25519 ${key.toString("base64")}`;
    const diagnostic = { schema: "zeros.diagnostic/v1", component: "installer", stage: "done", ok: true, exitCode: 0, timedOut: false, failedChecks: [] };
    const execute = vi.fn().mockResolvedValue({ exitCode: 0, output: JSON.stringify(diagnostic), outputTruncated: false });
    const dispose = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(sshBoundary, "openBoatBootstrapChannel").mockResolvedValue({ publicKey, execute, dispose });
    const d = deps(), commands: string[] = [];
    d.boat = async (method, route, options = {}) => {
      if (method === "GET") return { status: 200, body: { sandbox: { id: "bx_fixture", ip: "8.8.8.8" } } };
      const command = (options.body as any).command;
      commands.push(command);
      return { status: 200, body: { exitCode: 0, stdout: command.includes("/usr/bin/cat") ? publicKey : command.includes("expiry-time=") ? "restricted\n" : "revoked\n" } };
    };
    const input = { artifact: { url: "https://fixture.test/presign-canary" } };
    await expect(installOverSsh(d, "bx_fixture", input)).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(JSON.parse(Buffer.from(execute.mock.calls[0][0].stdin, "base64url").toString())).toEqual(input);
    expect(commands.every(command => !command.includes("presign-canary"))).toBe(true);
    expect(commands.at(-1)).toContain("print('revoked')");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("signs create-only Alpha uploads and fifteen-minute GETs without persistence", () => {
    const r2 = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "zeros-cloud-workspaces-alpha",
      accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
    const now = new Date("2026-10-04T00:00:00Z"), key = "runtime-test/zeros-v2-test-fixture/a.tar.gz";
    const headers = signedHeaders(r2, "PUT", key, Buffer.from("fixture"), now);
    expect(headers["if-none-match"]).toBe("*");
    expect(headers.authorization).toContain("SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date");
    const artifact = presignGet(r2, key, now);
    expect(new URL(artifact.url).searchParams.get("X-Amz-Expires")).toBe("900");
    expect(artifact.expiresAt).toBe("2026-10-04T00:15:00.000Z");
    expect(artifact.url).not.toContain(r2.secretAccessKey);
    expect(signedHeaders(r2, "DELETE", key, Buffer.alloc(0), now)["if-none-match"]).toBeUndefined();
  });

  it("does not delete an occupied object after a create-only upload returns 412", async () => {
    const d = deps();
    const r2 = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "zeros-cloud-workspaces-alpha",
      accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 412 }));
    vi.stubGlobal("fetch", request);
    await expect(uploadLiveObject(d, r2, "runtime-test/zeros-v2-test-fixture/a.tar.gz", Buffer.from("fixture")))
      .rejects.toMatchObject({ diagnostic: { failedChecks: ["provider_request"] } });
    await expect(cleanupLiveObjects(d)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1].method).toBe("PUT");
  });

  it.each(["success", "ambiguous"])("retains cleanup ownership after a %s object upload", async outcome => {
    const d = deps();
    const r2 = { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "zeros-cloud-workspaces-alpha",
      accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
    const request = outcome === "success" ? vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
      : vi.fn().mockRejectedValue(new Error("uncertain response"));
    vi.stubGlobal("fetch", request);
    const operation = uploadLiveObject(d, r2, "runtime-test/zeros-v2-test-fixture/a.tar.gz", Buffer.from("fixture"));
    if (outcome === "success") await operation;
    else await expect(operation).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(d.stateDir, "r2-objects.json"), "utf8")))
      .toEqual([{ key: "runtime-test/zeros-v2-test-fixture/a.tar.gz", deleted: false }]);
  });

  it("rejects non-test names, extra arguments and missing budgets before allocation", async () => {
    const d = deps();
    for (const options of [new Map(), new Map([["--name", "unscoped-base"], ["--max-used-hours", "2"]]),
      new Map([["--name", "zeros-v2-test-base-v4-1"], ["--max-used-hours", "2"], ["--from", "legacy"]])]) {
      await expect(v4Command("build", options, [], d)).rejects.toThrow();
    }
    expect(d.calls).toHaveLength(0);
  });

  it("uploads only the reviewed base inputs and bounded owned runner", () => {
    const payload = basePayload(ROOT, "1".repeat(40), "2".repeat(32));
    expect(payload.files.map(file => file.name)).toContain("base/bootstrap.py");
    expect(payload.files.map(file => file.name)).toContain("owned-runner.py");
    expect(payload.files.every(file => !/node_modules|\.git|\.env|dist-engine|tests\//.test(file.name))).toBe(true);
    expect(payload.files.find(file => file.name === "base/cloud-worker.json")!.data.toString()).toBe(fs.readFileSync(path.join(BASE, "cloud-worker.json"), "utf8"));
    for (const file of payload.files.filter(file => file.name.endsWith(".sh"))) {
      expect(spawnSync("bash", ["-n"], { input: file.data }).status).toBe(0);
    }
    expect(payload.files.find(file => file.name === "build.sh")!.data.toString()).not.toContain("{{");
    const build = payload.files.find(file => file.name === "build.sh")!.data.toString();
    expect(build).toMatch(/^chown root:root \/opt$/m);
    expect(build).toMatch(/^chmod 0755 \/opt$/m);
    expect(build.indexOf("chown root:root /opt")).toBeLessThan(build.indexOf("/opt/zeros-bootstrap"));
    expect(build).not.toMatch(/chown[^\n]*(?:-R|\/opt\/\*)/);
  });

  it("accepts only bounded closed diagnostic output from remote commands", () => {
    const diagnostic = { schema: "zeros.diagnostic/v1", component: "base", stage: "verify", ok: true, exitCode: 0, timedOut: false, failedChecks: [] };
    expect(parseProbe({ status: 200, body: { exitCode: 0, stdout: JSON.stringify({ versions: {} }) + "\n" + JSON.stringify(diagnostic) } }, "verify")).toEqual({ versions: {} });
    for (const body of [{ exitCode: 1, stderr: "private-canary" }, { exitCode: 0, stdout: "private-canary" },
      { exitCode: 0, stdout: "x".repeat(65_537) }, { exitCode: 0, stdoutTruncated: true, stdout: JSON.stringify(diagnostic) }]) {
      let failure: unknown;
      try { parseProbe({ status: 200, body }, "verify"); } catch (error) { failure = error; }
      expect(failure).toBeDefined();
      expect(JSON.stringify(closedFailure(failure))).not.toContain("private-canary");
    }
  });

  it("keeps marker, units, facade and wrappers on the approved contracts", () => {
    expect(JSON.parse(fs.readFileSync(path.join(BASE, "cloud-worker.json"), "utf8"))).toEqual({ backend: "cloud-worker", gid: 10001, profile: "zeros-cloud-worker-v4", uid: 10001, version: 4 });
    const host = fs.readFileSync(path.join(BASE, "zeros-host.service"), "utf8");
    for (const line of ["Delegate=cpu memory pids", "DelegateSubgroup=host", "KillMode=control-group", "TimeoutStopSec=20", "Restart=on-failure",
      "RestartSec=5", "RestartPreventExitStatus=65", "StartLimitIntervalSec=60", "StartLimitBurst=3"]) expect(host).toContain(line);
    expect(fs.readFileSync(path.join(BASE, "zeros.conf"), "utf8")).toContain("L /zeros - - - - /opt/zeros");
    for (const name of ["boot.sh", "dispatch.sh", "install-runtime.sh"]) {
      const file = path.join(BASE, name);
      const result = spawnSync("sh", [file, "unexpected"], { encoding: "utf8" });
      expect(result.status).toBe(64);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, failedChecks: ["input_schema"] });
      expect(fs.readFileSync(file, "utf8")).toContain("/usr/bin/env -i");
      expect(fs.readFileSync(file, "utf8")).toContain("/usr/bin/python3 -I");
    }
    const work = temp();
    for (const name of ["zeros-boot.service", "zeros-host.service"]) fs.copyFileSync(path.join(BASE, name), path.join(work, name));
    // A rootless parse works on Linux; execution/DelegateSubgroup is qualified
    // by the live script on Ubuntu 24.04 with systemd 254 or newer.
    expect(execFileSync("python3", ["-c", "import configparser,sys; p=configparser.ConfigParser(strict=False); p.read(sys.argv[1]); assert p['Service']['DelegateSubgroup']=='host'", path.join(work, "zeros-host.service")], { encoding: "utf8" })).toBe("");
  });
});

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZerosEngine } from "../zeros-engine";
import { classifyCloudEngineStartupFailure, parseCloudEngineStartupFailure, readCloudEngineStartupFailure,
  writeCloudEngineStartupFailure } from "../agents/containment/cloud-engine-startup-failure.mjs";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "zeros-startup-failure-"))); cleanup.push(directory);
  return { directory, file: path.join(directory, "cloud-engine-startup-failure.json"), engineInstanceId: randomUUID() };
}
const closedFailure = { phase: "history_restore" as const, name: "Error", code: "ENOENT", errno: -2 };
const read = (f: Awaited<ReturnType<typeof fixture>>, expectedUid = process.getuid!()) =>
  readCloudEngineStartupFailure({ dataRoot: f.directory, engineInstanceId: f.engineInstanceId, expectedUid });
async function record(f: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(f.file, JSON.stringify({ version: 1, engineInstanceId: f.engineInstanceId, failure: closedFailure }), { mode: 0o600 });
}

describe("cloud engine startup failure publication", () => {
  it("retains the closed cause when actual start rejects, then rethrows the original error", async () => {
    const f = await fixture(); vi.stubEnv("ZEROS_DATA_DIR", f.directory);
    const cause = Object.assign(new Error("credential-canary"), { code: "ENOENT", errno: -2, path: "private-path-canary" });
    const error = new Error("private-body-canary", { cause });
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      cloudRuntimeConfig: { engine: { instanceId: f.engineInstanceId } }, cloudStartupPhase: "history_restore",
      startRuntime: async () => { throw error; },
      executionBoundary: { recoverStaleProcesses: async () => { throw error; } },
    });
    await expect(engine.start()).rejects.toBe(error);
    const bytes = await fs.readFile(f.file, "utf8");
    expect(JSON.parse(bytes)).toEqual({ version: 1, engineInstanceId: f.engineInstanceId,
      failure: { phase: "history_restore", name: "Error", code: "ENOENT", errno: -2 } });
    expect(bytes).not.toContain("canary");
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
  });

  it("leaves Local and organization-local failures unchanged without writing cloud state", async () => {
    const f = await fixture(); vi.stubEnv("ZEROS_DATA_DIR", f.directory);
    const error = Object.assign(new Error("Local startup failure"), { code: "ENOENT", errno: -2 });
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      cloudRuntimeConfig: null, startRuntime: async () => { throw error; },
      executionBoundary: { recoverStaleProcesses: async () => { throw error; } },
    });
    await expect(engine.start()).rejects.toBe(error);
    expect(await fs.readdir(f.directory)).toEqual([]);
  });

  it("labels the actual pre-bootstrap restore gate and starts no boot owner after its failure", async () => {
    const f = await fixture(); vi.stubEnv("ZEROS_DATA_DIR", f.directory);
    const error = Object.assign(new Error("private-path-canary"), { code: "ENOENT", errno: -2 });
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      cloudRuntimeConfig: { engine: { instanceId: f.engineInstanceId } }, cloudWorker: {}, cloudAgentLegacyFactory: {},
      cloudRuntimeRegistration: { localCommandsNegotiated: () => true },
      restoreCloudLocalHistory: vi.fn(async () => { throw error; }),
    });
    engine.startRuntime = () => engine.initializeCloudAgentBoot();
    await expect(engine.start()).rejects.toBe(error);
    expect(engine.cloudAgentBoot).toBeUndefined();
    expect(await read(f)).toEqual(closedFailure);
  });

  it("keeps the startup exception when diagnostic publication is unavailable", async () => {
    const f = await fixture(); vi.stubEnv("ZEROS_DATA_DIR", f.directory); await fs.chmod(f.directory, 0o755);
    const error = new Error("private-body-canary");
    const engine = Object.assign(Object.create(ZerosEngine.prototype), {
      cloudRuntimeConfig: { engine: { instanceId: f.engineInstanceId } }, cloudStartupPhase: "startup",
      startRuntime: async () => { throw error; },
    });
    await expect(engine.start()).rejects.toBe(error);
    expect(await fs.readdir(f.directory)).toEqual([]);
  });
});

describe("closed startup evidence", () => {
  it("follows a bounded typed cause without evaluating getters or retaining arbitrary text", () => {
    const error = Object.assign(new Error("credential-canary"), { code: "ENOENT", errno: -2, body: "body-canary" });
    expect(classifyCloudEngineStartupFailure(new Error("wrapper-canary", { cause: error }), "history_restore")).toEqual(closedFailure);
    const getter = vi.fn(() => { throw new Error("getter-canary"); });
    const unclosed = { name: "name-canary", code: "code-canary", errno: 123456789 };
    Object.defineProperty(unclosed, "cause", { get: getter });
    expect(classifyCloudEngineStartupFailure(unclosed, "boot_owner")).toEqual({ phase: "boot_owner", name: "unknown", code: "unknown", errno: null });
    expect(getter).not.toHaveBeenCalled();
    const cycle: { name: string; cause?: unknown } = { name: "Error" }; cycle.cause = cycle;
    expect(classifyCloudEngineStartupFailure(cycle, "startup").code).toBe("unknown");
    let deep = error;
    for (let index = 0; index < 5; index++) deep = new Error("wrapper-canary", { cause: deep }) as typeof error;
    expect(classifyCloudEngineStartupFailure(deep, "registration").code).toBe("unknown");
    expect(parseCloudEngineStartupFailure({ ...closedFailure, stack: "stack-canary" })).toBeNull();
  });

  it("publishes only a regular private child file and refuses a stale or foreign instance", async () => {
    const f = await fixture(), before = await fs.stat(f.directory);
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      expect((await fs.lstat(source)).isFile()).toBe(true);
      return rename(source, destination);
    });
    for (let index = 0; index < 2; index++) expect(await writeCloudEngineStartupFailure({ dataRoot: f.directory,
      engineInstanceId: f.engineInstanceId, phase: "history_restore", error: Object.assign(new Error("secret-canary"), { code: "ENOENT", errno: -2 }) })).toBe(true);
    expect(await read(f)).toEqual(closedFailure);
    expect(await read({ ...f, engineInstanceId: randomUUID() })).toBeNull();
    expect(await read(f, process.getuid!() + 1)).toBeNull();
    const after = await fs.stat(f.directory);
    expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    expect(await fs.readdir(f.directory)).toEqual(["cloud-engine-startup-failure.json"]);
    expect((await fs.stat(f.file)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(f.file, "utf8")).not.toContain("canary");
    expect(vi.mocked(fs.open).mock.calls.some(([, flags]) => typeof flags === "number" && (flags & constants.O_NOFOLLOW) !== 0)).toBe(true);
  });

  it.each(["missing", "symlink", "hardlink", "directory", "public", "oversized", "malformed", "unclosed", "parent-symlink"])(
    "does not observe a %s private startup record", async kind => {
      const f = await fixture();
      if (kind !== "missing" && kind !== "directory") await record(f);
      if (kind === "symlink") { await fs.rename(f.file, `${f.file}.original`); await fs.symlink(`${f.file}.original`, f.file); }
      if (kind === "hardlink") await fs.link(f.file, `${f.file}.link`);
      if (kind === "directory") await fs.mkdir(f.file);
      if (kind === "public") await fs.chmod(f.file, 0o644);
      if (kind === "oversized") await fs.writeFile(f.file, "private-body-canary".repeat(4096));
      if (kind === "malformed") await fs.writeFile(f.file, "{private-body-canary");
      if (kind === "unclosed") await fs.writeFile(f.file, JSON.stringify({ version: 1, engineInstanceId: f.engineInstanceId,
        failure: { ...closedFailure, message: "private-body-canary" } }));
      if (kind === "parent-symlink") { await fs.symlink(f.directory, `${f.directory}.link`); cleanup.push(`${f.directory}.link`); }
      expect(await read(kind === "parent-symlink" ? { ...f, directory: `${f.directory}.link` } : f)).toBeNull();
    });

  it("never joins original metadata to replacement target bytes", async () => {
    const f = await fixture(); await record(f);
    const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const flagsSeen: number[] = [];
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (String(file).endsWith("/cloud-engine-startup-failure.json")) {
        flagsSeen.push(Number(flags));
        await fs.rename(f.file, `${f.file}.original`);
        await fs.writeFile(`${f.file}.target`, JSON.stringify({ version: 1, engineInstanceId: f.engineInstanceId,
          failure: { ...closedFailure, code: "EIO", errno: -5 } }), { mode: 0o600 });
        await fs.symlink(`${f.file}.target`, f.file);
      }
      return handle;
    });
    expect(await read(f)).toBeNull();
    expect(flagsSeen).toHaveLength(1);
    expect(flagsSeen[0]! & constants.O_NOFOLLOW).not.toBe(0);
    expect(flagsSeen[0]! & constants.O_NONBLOCK).not.toBe(0);
  });

  it("returns no observation when the same-fd read fails", async () => {
    const f = await fixture(); await record(f);
    const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (String(file).endsWith("/cloud-engine-startup-failure.json"))
        vi.spyOn(handle, "read").mockRejectedValue(new Error("private-body-canary"));
      return handle;
    });
    expect(await read(f)).toBeNull();
  });
});

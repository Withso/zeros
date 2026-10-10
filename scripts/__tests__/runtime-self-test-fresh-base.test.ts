import type * as fs from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Absolute VM paths are routed into one disposable directory. Only ownership,
// filesystem types and child execution are fake; adoption and cgroup readers
// execute the shipped code without touching host paths or kernel controls.
const vm = vi.hoisted(() => ({
  root: "", owners: new Map<string, { uid: number; gid: number }>(),
  descriptors: new Map<number, string>(), execute: vi.fn(),
  writes: [] as Array<[string, string]>, confirmPlacement: true,
  beforeControlOpen: undefined as (() => void) | undefined,
  afterHostWrite: undefined as (() => void) | undefined,
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  const virtual = (file: unknown): file is string => typeof file === "string" && file.startsWith("/") &&
    !file.startsWith(process.cwd()) && !file.startsWith(vm.root);
  const route = (file: unknown) => virtual(file) ? path.join(vm.root, file) : file;
  const owner = (stat: fs.Stats, file: string) => Object.assign(stat, vm.owners.get(file) ?? { uid: 0, gid: 0 });
  const routed = (name: keyof typeof actual) => (...args: unknown[]) =>
    Reflect.apply(actual[name] as (...args: unknown[]) => unknown, actual, [route(args[0]), ...args.slice(1)]);
  return {
    ...actual,
    ...Object.fromEntries(["chmodSync", "existsSync", "mkdirSync", "readFileSync", "readdirSync", "rmSync", "writeFileSync"]
      .map(name => [name, routed(name as keyof typeof actual)])),
    readFileSync: (file: string | number, options: unknown) => {
      // Only our own temporary-file FD lock metadata is read from real proc.
      const target = typeof file === "string" && file.startsWith("/proc/self/fdinfo/") ? file : route(file);
      return Reflect.apply(actual.readFileSync, actual, [target, options]);
    },
    lstatSync: (file: string) => owner(actual.lstatSync(route(file) as string), file),
    realpathSync: (file: string) => {
      const resolved = actual.realpathSync(route(file) as string);
      return virtual(file) ? resolved.slice(vm.root.length) || "/" : resolved;
    },
    openSync: (file: string, flags: number, mode?: number) => {
      if (file === "/sys/fs/cgroup/system.slice/zeros-host.service/host/cgroup.procs" && flags & actual.constants.O_WRONLY)
        vm.beforeControlOpen?.();
      const fd = actual.openSync(route(file) as string, flags, mode);
      vm.descriptors.set(fd, file); return fd;
    },
    closeSync: (fd: number) => { vm.descriptors.delete(fd); actual.closeSync(fd); },
    fstatSync: (fd: number) => owner(actual.fstatSync(fd), vm.descriptors.get(fd)!),
    fchownSync: (fd: number, uid: number, gid: number) => { vm.owners.set(vm.descriptors.get(fd)!, { uid, gid }); },
    writeSync: (fd: number, bytes: string) => {
      const name = vm.descriptors.get(fd)!;
      vm.writes.push([name, bytes]);
      if (name === "/sys/fs/cgroup/system.slice/zeros-host.service/host/cgroup.procs" && vm.confirmPlacement)
        actual.writeFileSync(path.join(vm.root, "/proc/self/cgroup"), "0::/system.slice/zeros-host.service/host\n");
      if (name === "/sys/fs/cgroup/system.slice/zeros-host.service/host/cgroup.procs") vm.afterHostWrite?.();
      return Buffer.byteLength(bytes);
    },
    statfsSync: (file: string) => {
      const name = file.startsWith("/proc/self/fd/") ? vm.descriptors.get(Number(path.basename(file)))! : file;
      return { type: name.startsWith("/sys/fs/cgroup") ? 0x63677270 : name.startsWith("/proc") ? 0x9fa0 : 0xef53 };
    },
    renameSync: (source: string, target: string) => {
      actual.renameSync(route(source) as string, route(target) as string);
      if (vm.owners.has(source)) vm.owners.set(target, vm.owners.get(source)!);
    },
    unlinkSync: routed("unlinkSync"),
  };
});
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: vm.execute,
}));

const cgroupRoot = "/sys/fs/cgroup/system.slice/zeros-host.service";
const actualPlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const runtimeRoot = `/opt/zeros-infra/r1-${"a".repeat(64)}`;
const runtime = { profile: "v4", root: runtimeRoot, node: `${runtimeRoot}/bin/node`,
  binRoot: `${runtimeRoot}/bin`, libRoot: `${runtimeRoot}/lib/zeros`, workerRoot: `${runtimeRoot}/worker`, cgroupRoot };
const marker = "/srv/zeros/.zeros-engine-ownership-v1.json";
let actual: typeof fs;
const mapped = (file: string) => path.join(vm.root, file);
const file = (name: string, bytes: string) => {
  actual.mkdirSync(path.dirname(mapped(name)), { recursive: true, mode: 0o755 });
  // Backing files are owned by the test runner, which must be able to update
  // fake kernel observations without DAC capabilities. VM owners are separate.
  actual.writeFileSync(mapped(name), bytes, { mode: 0o600 });
};

beforeEach(async () => {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  actual = await vi.importActual<typeof fs>("node:fs");
  vm.root = actual.realpathSync(actual.mkdtempSync(path.join(os.tmpdir(), "zeros-fresh-base-probe-")));
  actual.chmodSync(vm.root, 0o755);
  vm.owners.clear(); vm.descriptors.clear(); vm.execute.mockReset(); vm.writes.length = 0; vm.confirmPlacement = true;
  vm.beforeControlOpen = undefined; vm.afterHostWrite = undefined;
  for (const name of ["getuid", "geteuid", "getgid", "getegid"] as const) vi.spyOn(process, name).mockReturnValue(0);
  const directory = (name: string, uid = 0, gid = uid, mode = 0o755) => {
    actual.mkdirSync(mapped(name), { recursive: true, mode });
    actual.chmodSync(mapped(name), mode); vm.owners.set(name, { uid, gid });
  };
  // v4 build.sh + Bootstrap.persistence(create=True) + sanitize_base:
  // frozen physical sources, five file entries and empty overlay targets.
  for (const name of ["/srv/zeros", "/srv/zeros/files", "/srv/zeros/home", "/srv/zeros/files/repos",
    "/srv/zeros/files/state", "/srv/zeros/files/managed-settings", "/srv/zeros/files/home",
    "/srv/zeros/files/home/agent", "/srv/zeros/files/home/capture"]) directory(name);
  directory("/srv/zeros/home/agent", 10001);
  directory("/srv/zeros/home/capture", 10002, 10002, 0o700);
  directory("/srv/zeros/state", 10003, 10003, 0o700);
  directory("/srv/zeros/files/.zeros-setup", 0, 10001, 0o710);
  directory("/srv/zeros/log", 0, 10001, 0o750);
  directory("/srv/zeros/managed-settings", 0, 10001, 0o750);
  file("/srv/zeros/managed-settings/settings.managed.toml", "");
  actual.chmodSync(mapped("/srv/zeros/managed-settings/settings.managed.toml"), 0o640);
  vm.owners.set("/srv/zeros/managed-settings/settings.managed.toml", { uid: 0, gid: 10001 });
  directory(`${cgroupRoot}/host`);
  file(`${cgroupRoot}/cgroup.procs`, "");
  file(`${cgroupRoot}/cgroup.subtree_control`, "cpu memory pids\n");
  file(`${cgroupRoot}/host/cgroup.procs`, "17\n");
  for (const [name, value] of Object.entries({ "cpu.max": "100000 100000", "memory.max": "268435456",
    "pids.max": "256", "memory.oom.group": "1" })) file(`${cgroupRoot}/host/${name}`, `${value}\n`);
  file("/proc/self/cgroup", "0::/system.slice/ssh.service\n");
  vm.execute.mockImplementation((executable: string) => {
    if (executable === "/usr/bin/python3") return { status: 0, signal: null, stdout: "", stderr: "" };
    throw new Error("Fresh base layout reached fixed launcher invocation");
  });
});
afterEach(() => {
  expect(vm.descriptors.size).toBe(0);
  vi.restoreAllMocks(); Object.defineProperty(process, "platform", platformDescriptor);
  actual.rmSync(vm.root, { recursive: true, force: true });
});

it("prepares the exact sanitized fresh base through the actual adoption and delegated cgroup reader", async () => {
  const { runtimeEngineLifecycleSmoke } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  expect(() => runtimeEngineLifecycleSmoke(runtime, {})).toThrow("Fresh base layout reached fixed launcher invocation");
  expect(actual.readFileSync(mapped(marker), "utf8")).toBe('{"version":1,"uid":10003,"gid":10003}\n');
  expect(actual.statSync(mapped(marker)).mode & 0o7777).toBe(0o600);
  expect(vm.owners.get("/srv/zeros/home/engine")).toEqual({ uid: 10003, gid: 10003 });
  expect(vm.owners.get("/srv/zeros/home/engine-capture")).toEqual({ uid: 10003, gid: 10003 });
  expect(vm.owners.get("/srv/zeros/files/workspace")).toEqual({ uid: 10003, gid: 10003 });
});

it.each(["probe-cursor", "qualify"])("refuses the actual %s launcher inherited from pinned SSH before preparing any scope", async operation => {
  const { launchCloudEngine } = await import("../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs");
  const prepare = vi.fn();
  await expect(launchCloudEngine({ runtime, operation, prepare, signals: new EventEmitter() }))
    .rejects.toThrow("Cloud root monitor placement was refused");
  expect(prepare).not.toHaveBeenCalled();
});

it("control: the original host membership passes the launcher placement gate", async () => {
  file("/proc/self/cgroup", "0::/system.slice/zeros-host.service/host\n");
  const { launchCloudEngine } = await import("../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs");
  const scope = { prepare: vi.fn(() => { throw new Error("Original host placement admitted"); }) };
  await expect(launchCloudEngine({ runtime, operation: "qualify", scope, signals: new EventEmitter() }))
    .rejects.toThrow("Original host placement admitted");
  expect(scope.prepare).toHaveBeenCalledOnce();
});

it.each(["probe-cursor", "qualify"])("places only the root %s wrapper in the original host before the actual launcher gate", async operation => {
  const selfTest = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  const enter = (selfTest as unknown as { enterSelfTestHost: (runtime: object) => void }).enterSelfTestHost;
  enter(runtime);
  expect(vm.writes).toEqual([[`${cgroupRoot}/host/cgroup.procs`, "0"]]);
  const { launchCloudEngine } = await import("../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs");
  const scope = { prepare: vi.fn(() => { throw new Error("Original host placement admitted"); }) };
  await expect(launchCloudEngine({ runtime, operation, scope, signals: new EventEmitter() }))
    .rejects.toThrow("Original host placement admitted");
  expect(scope.prepare).toHaveBeenCalledOnce();
});

it.each(["live-setup", "foreign-host", "writable-host", "foreign-control", "control-symlink", "inside-workload",
  "missing-controller", "changed-host-limit"])("refuses %s before moving the root wrapper", async condition => {
    if (condition === "live-setup") file(`${cgroupRoot}/setup/cgroup.events`, "populated 1\nfrozen 0\n");
    if (condition === "foreign-host") vm.owners.set(`${cgroupRoot}/host`, { uid: 10003, gid: 10003 });
    if (condition === "writable-host") actual.chmodSync(mapped(`${cgroupRoot}/host`), 0o777);
    if (condition === "foreign-control") vm.owners.set(`${cgroupRoot}/host/cgroup.procs`, { uid: 10003, gid: 10003 });
    if (condition === "control-symlink") {
      actual.unlinkSync(mapped(`${cgroupRoot}/host/cgroup.procs`));
      actual.symlinkSync(mapped(`${cgroupRoot}/cgroup.procs`), mapped(`${cgroupRoot}/host/cgroup.procs`));
    }
    if (condition === "inside-workload") file("/proc/self/cgroup", "0::/system.slice/zeros-host.service/engine-runtime/engine-12345678-1234-4234-8234-123456789abc\n");
    if (condition === "missing-controller") file(`${cgroupRoot}/cgroup.subtree_control`, "cpu pids\n");
    if (condition === "changed-host-limit") file(`${cgroupRoot}/host/memory.max`, "max\n");
    const selfTest = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
    const enter = (selfTest as unknown as { enterSelfTestHost: (runtime: object) => void }).enterSelfTestHost;
    // Check the export separately so a missing implementation cannot satisfy
    // a security refusal through an unrelated TypeError.
    expect(enter).toBeTypeOf("function");
    expect(() => enter(runtime)).toThrow();
    expect(vm.writes).toEqual([]);
  });

it("refuses an unconfirmed host placement after its one current-process write", async () => {
  vm.confirmPlacement = false;
  const selfTest = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  const enter = (selfTest as unknown as { enterSelfTestHost: (runtime: object) => void }).enterSelfTestHost;
  expect(enter).toBeTypeOf("function");
  expect(() => enter(runtime)).toThrow();
  expect(vm.writes).toEqual([[`${cgroupRoot}/host/cgroup.procs`, "0"]]);
});

it.each(["getuid", "geteuid", "getgid", "getegid"] as const)("refuses a non-root %s before any placement", async method => {
  vi.spyOn(process, method).mockReturnValue(10003);
  const { enterSelfTestHost } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  expect(() => enterSelfTestHost(runtime)).toThrow();
  expect(vm.writes).toEqual([]);
});

it("refuses a replaced original host before writing its replacement control", async () => {
  vm.beforeControlOpen = () => {
    const host = mapped(`${cgroupRoot}/host`);
    actual.renameSync(host, `${host}-original`);
    actual.mkdirSync(host, { mode: 0o755 });
    actual.writeFileSync(path.join(host, "cgroup.procs"), "17\n", { mode: 0o600 });
  };
  const { enterSelfTestHost } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  expect(() => enterSelfTestHost(runtime)).toThrow();
  expect(vm.writes).toEqual([]);
});

it("refuses a replaced original control after placement rather than accepting a receipt", async () => {
  vm.afterHostWrite = () => {
    const control = mapped(`${cgroupRoot}/host/cgroup.procs`);
    actual.renameSync(control, `${control}-original`);
    actual.writeFileSync(control, "17\n", { mode: 0o600 });
  };
  const { enterSelfTestHost } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  expect(() => enterSelfTestHost(runtime)).toThrow();
  expect(vm.writes).toEqual([[`${cgroupRoot}/host/cgroup.procs`, "0"]]);
});

it.skipIf(actualPlatform !== "linux").each([0o600, 0o640, 0o644])("holds and reuses the original setup lock mode %s without replacing or chmodding it", async mode => {
  const file = "/run/zeros/setup.lock";
  actual.mkdirSync(mapped("/run/zeros"), { recursive: true, mode: 0o700 });
  actual.writeFileSync(mapped(file), "", { mode }); actual.chmodSync(mapped(file), mode);
  const before = actual.lstatSync(mapped(file));
  const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vm.execute.mockImplementation(child.spawnSync);
  const selfTest = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  const { acquireSelfTestSetupLock, assertSelfTestSetupLock } = selfTest;
  const fd = acquireSelfTestSetupLock();
  try {
    assertSelfTestSetupLock(fd);
    expect(actual.fstatSync(fd)).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode, size: 0 });
    expect(actual.lstatSync(mapped(file))).toMatchObject({ dev: before.dev, ino: before.ino, mode: before.mode, size: 0 });
    // A separate opener is not the held original description, even while
    // another descriptor genuinely owns a lock on this same file inode.
    const separate = actual.openSync(mapped(file), actual.constants.O_RDWR | actual.constants.O_NOFOLLOW);
    vm.descriptors.set(separate, file);
    try { expect(() => assertSelfTestSetupLock(separate)).toThrow(); }
    finally { vm.descriptors.delete(separate); actual.closeSync(separate); }
    expect(child.spawnSync("/usr/bin/flock", ["--unlock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] }).status).toBe(0);
    expect(() => assertSelfTestSetupLock(fd)).toThrow();
  } finally { vm.descriptors.delete(fd); actual.closeSync(fd); }
});

it.each(["foreign-owner", "unsafe-mode", "symlink"])("refuses %s setup lock and closes its original descriptor", async condition => {
  const file = "/run/zeros/setup.lock";
  actual.mkdirSync(mapped("/run/zeros"), { recursive: true, mode: 0o700 });
  actual.writeFileSync(mapped(file), "", { mode: 0o600 });
  if (condition === "foreign-owner") vm.owners.set(file, { uid: 10003, gid: 10003 });
  if (condition === "unsafe-mode") actual.chmodSync(mapped(file), 0o666);
  if (condition === "symlink") {
    actual.unlinkSync(mapped(file)); actual.symlinkSync(mapped(`${cgroupRoot}/cgroup.procs`), mapped(file));
  }
  const selfTest = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  expect(() => selfTest.acquireSelfTestSetupLock()).toThrow();
  expect(vm.execute).not.toHaveBeenCalled();
});

it.skipIf(actualPlatform !== "linux")("refuses replacement of the original held setup lock path", async () => {
  const file = "/run/zeros/setup.lock";
  actual.mkdirSync(mapped("/run/zeros"), { recursive: true, mode: 0o700 });
  const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vm.execute.mockImplementation(child.spawnSync);
  const { acquireSelfTestSetupLock, assertSelfTestSetupLock } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  const fd = acquireSelfTestSetupLock();
  try {
    actual.renameSync(mapped(file), mapped(`${file}-original`));
    actual.writeFileSync(mapped(file), "", { mode: 0o600 });
    expect(() => assertSelfTestSetupLock(fd)).toThrow();
  } finally { vm.descriptors.delete(fd); actual.closeSync(fd); }
});

it("routes the actual lifecycle caller through the fixed host entry with only its original lock FD", async () => {
  const { runtimeEngineLifecycleSmoke } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs");
  vm.execute.mockImplementation((executable: string, args: string[], options: { stdio: unknown[] }) => {
    if (executable === "/usr/bin/python3") return { status: 0, signal: null, stdout: "", stderr: "" };
    if (executable === runtime.node && args[0] === `${runtime.libRoot}/runtime-self-test.mjs` &&
      args[1] === "--host-qualify" && args.length === 2 && options.stdio.join(",") === "ignore,pipe,pipe,3")
      return { status: 0, signal: null, stdout: '{"version":2,"boundary":"workspace-vm","qualified":false}\n', stderr: "" };
    return { status: 125, signal: null, stdout: "", stderr: "Original host launch entry was missing" };
  });
  // The layout completes, but fake child output still cannot qualify a VM.
  expect(runtimeEngineLifecycleSmoke(runtime, { PATH: "/usr/bin:/bin" })).toBe(false);
  expect(vm.execute.mock.calls[1]?.slice(0, 2)).toEqual([runtime.node,
    [`${runtime.libRoot}/runtime-self-test.mjs`, "--host-qualify"]]);
});

it.skipIf(actualPlatform !== "linux").each(["fresh", "foreign-host", "changed-host", "live-setup", "missing-controller"])(
  "runs the whole fixed self-test command with %s VM observations and real inherited setup flock", async condition => {
    const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    const manifest = JSON.stringify({ schema: "zeros.runtime-manifest/v1", entrypoints: { selfTest: "lib/zeros/runtime-self-test.mjs" },
      platform: { os: "linux", arch: "x64", node: process.versions.node, nodeModulesAbi: Number(process.versions.modules) },
      agents: { claude: { cli: "1.2.3" }, codex: { package: "1.2.3" } } });
    const manifestSha256 = digest(manifest);
    const runtimeId = `r1-${manifestSha256}`;
    const root = `/opt/zeros-infra/${runtimeId}`;
    const baseCompatibilityId = `bc1-${"b".repeat(64)}`;
    const receipt = JSON.stringify({ schema: "zeros.runtime-install-receipt/v1", runtimeId, manifestSha256, baseCompatibilityId });
    const active = { schema: "zeros.active-runtime/v1", runtimeId, manifestSha256, root, baseCompatibilityId,
      installerReceiptSha256: digest(receipt), bootId: "12345678-1234-4234-8234-123456789abc",
      supervisorSessionId: "22345678-1234-4234-8234-123456789abc", cgroupRoot };
    file("/etc/zeros/cloud-worker.json", JSON.stringify({ version: 4, backend: "cloud-worker", profile: "zeros-cloud-worker-v4", uid: 10001, gid: 10001 }));
    file("/run/zeros/active-runtime.json", JSON.stringify(active));
    file(`${root}/manifest.json`, manifest);
    file(`/srv/zeros/runtime-installs/${runtimeId}.json`, receipt);
    for (const name of ["bin/node", "bin/start-engine.sh", "bin/cloud-engine-namespace",
      "worker/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs", "worker/dist-engine/cli.js",
      "worker/apps/desktop/src/engine/zeros-engine.ts", "worker/package.json"]) file(`${root}/${name}`, "fixture");
    for (const name of ["node", "start-engine.sh", "cloud-engine-namespace"]) actual.chmodSync(mapped(`${root}/bin/${name}`), 0o700);
    const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
    // Runtime staging copies the helper bytes, including source-tree links.
    actual.cpSync(sandbox, mapped(`${root}/lib/zeros`), { recursive: true, dereference: true });
    for (const entry of actual.readdirSync(mapped(`${root}/lib/zeros`)))
      if (actual.lstatSync(mapped(`${root}/lib/zeros/${entry}`)).isFile()) actual.chmodSync(mapped(`${root}/lib/zeros/${entry}`), 0o555);
    for (const name of ["better-sqlite3", "node-pty", "@anthropic-ai/claude-agent-sdk",
      "@anthropic-ai/claude-agent-sdk-linux-x64/claude", "@openai/codex/package.json", "@openai/codex-linux-x64/package.json",
      "@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", "@cursor/sdk", "@cursor/sdk-linux-x64/package.json", "tsx/cjs"])
      file(`${root}/worker/node_modules/${name}`, "fixture");
    // Exact facade spelling is checked by the actual installed-runtime resolver;
    // physical link destinations remain inside this disposable test directory.
    const links = { "/zeros": "/opt/zeros", "/opt/zeros/current": `../zeros-infra/${runtimeId}`,
      "/opt/zeros/bin": "current/bin", "/opt/zeros/worker": "current/worker", "/opt/zeros/manifest.json": "current/manifest.json",
      "/opt/zeros/logs": "/srv/zeros/log", "/opt/zeros/state": "/srv/zeros/state" };
    actual.mkdirSync(mapped("/opt/zeros"), { mode: 0o755 });
    for (const [name, target] of Object.entries(links)) actual.symlinkSync(target.startsWith("/") ? mapped(target) : target, mapped(name));
    if (condition === "foreign-host") vm.owners.set(`${cgroupRoot}/host`, { uid: 10003, gid: 10003 });
    if (condition === "live-setup") file(`${cgroupRoot}/setup/cgroup.events`, "populated 1\nfrozen 0\n");
    if (condition === "missing-controller") file(`${cgroupRoot}/cgroup.subtree_control`, "cpu pids\n");
    const owners = path.join(vm.root, "owners.json"), events = path.join(vm.root, "events.jsonl"), config = path.join(vm.root, "command.json");
    actual.writeFileSync(owners, JSON.stringify(Object.fromEntries(vm.owners)));
    actual.writeFileSync(events, "");
    actual.writeFileSync(config, JSON.stringify({ root: vm.root, runtime: { ...active, node: `${root}/bin/node` }, owners, events, links, condition, readOffsets: {} }));
    const { builderFixedCommand } = await import("../../apps/control-plane/src/cloud-workspaces/cloud-builder-commands.js");
    const command = builderFixedCommand("runtime-self-test", runtimeId)!;
    expect(command).toBe(`${root}/bin/node ${root}/lib/zeros/runtime-self-test.mjs`);
    const child = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const result = child.spawnSync(process.execPath,
      [path.resolve("scripts/__tests__/helpers/runtime-self-test-command-io.cjs"), config, ...command.split(" ").slice(1)],
      { env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(1);
    const observations = actual.readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const prepared = observations.filter(event => event.kind === "scope.prepare");
    if (condition === "fresh") {
      expect(prepared, JSON.stringify({ observations, output: result.stdout, stderr: result.stderr })).toEqual(["--host-probe-cursor", "--host-qualify"].map(role =>
        ({ role, kind: "scope.prepare", membership: "0::/system.slice/zeros-host.service/host\n" })));
      expect(observations.filter(event => event.kind === "placement").map(event => event.bytes)).toEqual(["0", "0"]);
      expect(observations.filter(event => event.kind === "role-command").map(event => [event.args, event.lockForwarded])).toEqual(
        ["--host-probe-cursor", "--host-qualify"].map(role => [[`${root}/lib/zeros/runtime-self-test.mjs`, role], true]));
      expect(observations.filter(event => ["entry", "offline-command", "role-command", "engine-load"].includes(event.kind))
        .every(event => event.membership === "0::/system.slice/ssh.service\n")).toBe(true);
      expect(JSON.parse(result.stdout).failedChecks).toEqual(["cursor_load", "engine_lifecycle"]);
      expect(actual.readFileSync(mapped(marker), "utf8")).toBe('{"version":1,"uid":10003,"gid":10003}\n');
    } else expect(prepared).toEqual([]);
    // The fixture deliberately stops at scope.prepare; no synthetic native
    // success is allowed to escape even when both placement boundaries pass.
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }, 30_000,
);

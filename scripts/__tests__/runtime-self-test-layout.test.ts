import type * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// A real temporary filesystem models B4's sanitized, empty files parent. Only
// VM ownership and kernel/process boundaries are simulated; layout preparation,
// launcher's filesystem validation and qualification helper execute unchanged.
const vm = vi.hoisted(() => ({
  root: "", owners: new Map<string, { uid: number; gid: number }>(),
  descriptors: new Map<number, string>(), execute: vi.fn(), directoryRenames: [] as string[],
  assertRetired: vi.fn<() => void>(),
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof fs>();
  const virtual = (file: unknown): file is string => typeof file === "string" && file.startsWith("/") &&
    !file.startsWith(process.cwd()) && !file.startsWith(vm.root);
  const route = (file: unknown) => virtual(file) ? path.join(vm.root, file) : file;
  const owner = (metadata: fs.Stats, file: string) => Object.assign(metadata, vm.owners.get(file) ?? { uid: 0, gid: 0 });
  const routed = (name: keyof typeof actual, indices = [0]) => (...args: unknown[]) =>
    Reflect.apply(actual[name] as (...args: unknown[]) => unknown, actual, args.map((value, i) => indices.includes(i) ? route(value) : value));
  return {
    ...actual,
    ...Object.fromEntries(["chmodSync", "existsSync", "mkdirSync", "readFileSync", "readdirSync", "rmSync", "writeFileSync"]
      .map(name => [name, routed(name as keyof typeof actual)])),
    lstatSync: (file: string) => owner(actual.lstatSync(route(file) as string), file),
    statSync: (file: string) => owner(actual.statSync(route(file) as string), file),
    realpathSync: (file: string) => {
      const resolved = actual.realpathSync(route(file) as string);
      return virtual(file) ? resolved.slice(vm.root.length) || "/" : resolved;
    },
    chownSync: (file: string, uid: number, gid: number) => { vm.owners.set(file, { uid, gid }); },
    openSync: (file: string, flags: number, mode?: number) => {
      const fd = actual.openSync(route(file) as string, flags, mode);
      vm.descriptors.set(fd, file); return fd;
    },
    closeSync: (fd: number) => { vm.descriptors.delete(fd); actual.closeSync(fd); },
    fstatSync: (fd: number) => owner(actual.fstatSync(fd), vm.descriptors.get(fd)!),
    fchownSync: (fd: number, uid: number, gid: number) => { vm.owners.set(vm.descriptors.get(fd)!, { uid, gid }); },
    statfsSync: () => ({ type: 0x9fa0 }),
    mkdtempSync: (prefix: string) => {
      const result = actual.mkdtempSync(route(prefix) as string);
      return virtual(prefix) ? result.slice(vm.root.length) : result;
    },
    symlinkSync: routed("symlinkSync", [1]),
    renameSync: (from: string, to: string) => {
      if (actual.lstatSync(route(from) as string).isDirectory()) vm.directoryRenames.push(from);
      actual.renameSync(route(from) as string, route(to) as string);
      if (vm.owners.has(from)) vm.owners.set(to, vm.owners.get(from)!);
    },
  };
});
vi.mock("../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs", async original => ({
  ...await original<Record<string, unknown>>(),
  CloudDelegatedCgroups: class { assertRetired() { vm.assertRetired(); } },
}));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: vm.execute,
}));

let actual: typeof fs;
let smoke: (runtime: object, environment: object) => boolean;
let runtime: { profile: string; root: string; node: string; workerRoot: string; binRoot: string; libRoot: string; engineNamespace: string };
let qualified: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let mutableLayout: typeof import("../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs").CLOUD_ENGINE_MUTABLE_LAYOUT;
const observations: { result: Promise<unknown>; releaseView: ReturnType<typeof vi.fn>;
  resourceFile: string; resourceProjection: object; viewArguments: string[] }[] = [];
const mapped = (file: string) => path.join(vm.root, file);

async function observeUnqualifiedRuntime() {
  expect(observations).toHaveLength(1);
  const observation = observations[0]!;
  // The original view must outlive the asynchronous observation, including
  // original controller creation/refusal and owned role cleanup.
  expect(observation.releaseView).not.toHaveBeenCalled();
  expect(JSON.parse(actual.readFileSync(mapped(observation.resourceFile), "utf8"))).toEqual(observation.resourceProjection);
  expect(actual.statSync(mapped(observation.resourceFile)).mode & 0o777).toBe(0o444);
  expect(vm.owners.get(observation.resourceFile)).toEqual({ uid: 0, gid: 0 });
  const binds = observation.viewArguments.flatMap((argument, index, args) =>
    argument === "--bind" ? [args.slice(index, index + 3)] : []);
  expect(binds).toContainEqual(["--bind", mutableLayout.agentHome, "/srv/zeros/home/agent"]);
  expect(binds).toContainEqual(["--bind", mutableLayout.captureHome, "/srv/zeros/home/capture"]);
  expect(binds).not.toContainEqual(["--bind", "/srv/zeros/home/agent", "/srv/zeros/home/agent"]);
  expect(binds).not.toContainEqual(["--bind", "/srv/zeros/home/capture", "/srv/zeros/home/capture"]);
  await expect(observation.result).resolves.toMatchObject({
    version: 2, boundary: "workspace-vm", qualified: false, engineChecksPassed: false,
  });
  expect(observation.releaseView).toHaveBeenCalledOnce();
  expect(actual.existsSync(mapped(observation.resourceFile))).toBe(false);
}

beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs");
  vm.root = actual.realpathSync(actual.mkdtempSync(path.join(os.tmpdir(), "zeros-v2-test-smoke-layout-")));
  actual.chmodSync(vm.root, 0o755);
  vm.owners.clear(); vm.descriptors.clear(); vm.directoryRenames = []; vm.execute.mockReset();
  vm.assertRetired.mockReset();
  vi.spyOn(process,"geteuid").mockReturnValue(0);
  vi.resetModules();
  // Exercise the actual v4 filesystem/adoption path against a fake VM. The
  // original runtime qualifier must refuse this fixture's unknown custody.
  const v4 = actual.existsSync(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-runtime-root.mjs"));
  const root = `/opt/zeros-infra/r1-${"a".repeat(64)}`;
  runtime = { profile: "v4", root, node: `${root}/bin/node`, binRoot: `${root}/bin`, libRoot: `${root}/lib/zeros`,
    workerRoot: `${root}/worker`, engineNamespace: `${root}/libexec/cloud-engine-namespace` };
  if (v4) vi.doMock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async original => ({
    ...await original<Record<string, unknown>>(), resolveCloudRuntime: () => runtime, cloudActiveRuntimeDescriptor: () => ({}),
  }));
  vi.doMock("../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs", () => ({
    readCloudHostRuntimeProfile: () => ({ version: v4 ? 4 : 2,
      runtimeDirectory: "/run/zeros/engine", managedSettingsDirectory: "/srv/zeros/managed-settings" }),
  }));
  const directory = (file: string, uid = 0, mode = 0o755, gid = uid) => {
    actual.mkdirSync(mapped(file), { recursive: true, mode }); actual.chmodSync(mapped(file), mode);
    vm.owners.set(file, { uid, gid });
  };
  const file = (name: string, data = "") => {
    directory(path.dirname(name)); actual.writeFileSync(mapped(name), data, { mode: 0o444 });
  };
  // B4 build/sanitize leave these parents and an empty files directory. A
  // qualification install prepares runtime/facade/receipt paths, not a repo.
  for (const name of ["/srv/zeros/files", "/srv/zeros/home", "/opt/zeros", "/tmp"]) directory(name);
  directory("/run/zeros", 0, 0o700);
  directory("/srv/zeros/home/agent", 10001);
  directory("/srv/zeros/home/capture", 10002, 0o700);
  directory("/srv/zeros/state", 10003, 0o700);
  file("/srv/zeros/managed-settings/settings.managed.toml");
  actual.chmodSync(mapped("/srv/zeros/managed-settings/settings.managed.toml"),0o640);
  vm.owners.set("/srv/zeros/managed-settings/settings.managed.toml",{uid:0,gid:10001});
  directory("/srv/zeros/managed-settings", 0, 0o750, 10001);
  for (const name of ["/usr/bin/bwrap", "/usr/bin/setpriv", "/usr/bin/rg", runtime.node, runtime.engineNamespace,
    `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`, `${runtime.workerRoot}/binaries/rg`, `${runtime.workerRoot}/dist-engine/cli.js`, "/opt/zeros-runtime/bin/node", "/opt/zeros-runtime/cloud-engine-namespace", "/opt/zeros/dist-engine/cli.js"]) file(name);
  file("/opt/zeros/disk-epoch", "1\n");
  file("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0\n");
  file("/proc/sys/kernel/overflowuid", "65534\n"); file("/proc/sys/kernel/overflowgid", "65534\n");
  file("/proc/self/cgroup", "0::/zeros-cloud-engine\n");
  file("/proc/meminfo", "MemTotal: 8388608 kB\n");
  file("/sys/fs/cgroup/zeros-cloud-engine/cpuset.cpus.effective", "0-3\n");
  const resources = Object.freeze({ architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 });
  const { cloudRuntimeBudget } = await import("../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs");
  const budget = cloudRuntimeBudget("/sys/fs/cgroup/zeros-cloud-engine",
    (file: string) => actual.readFileSync(mapped(file), "utf8"), undefined,
    resources.memoryMiB * 1024 ** 2, 1024 ** 3, resources.cpuMillicores);
  const resourceProjection = Object.freeze({ version: 1, resources, memoryBudget: budget.memoryBudget });
  const { prepareCloudEngineView } = await import("../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs");
  const { cloudEngineViewArguments } = await import("../cloud-workspace-validation/sandbox/cloud-engine-view.mjs");
  ({ CLOUD_ENGINE_MUTABLE_LAYOUT: mutableLayout } = await import("../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs"));
  const { qualifyCloudEngineRuntime } = await import("../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs");
  qualified = vi.fn<() => Promise<unknown>>(qualifyCloudEngineRuntime);
  vm.execute.mockImplementation((executable: string, args: string[]) => {
    const success = { status: 0, signal: null, stdout: "", stderr: "" };
    if (executable === "/usr/bin/python3") return success;
    if (args[0] === `${runtime.libRoot}/cloud-engine-launcher.mjs` && args[1] === "--qualify") {
      const view = prepareCloudEngineView(runtime, {}, "qualify", undefined, undefined, resourceProjection);
      const releaseView = vi.fn(() => view.releaseView?.());
      const result = qualified().finally(releaseView);
      observations.push({ result, releaseView, resourceFile: `${view.viewDirectory}/etc/cloud-resource-contract.json`, resourceProjection,
        viewArguments: cloudEngineViewArguments("qualify", 4, runtime, view.viewDirectory) });
      // spawnSync cannot await. The real asynchronous observer is retained and
      // awaited by the test; its explicit unknown kernel is never a success.
      return { ...success, stdout: JSON.stringify({ version: 2, boundary: "workspace-vm",
        qualified: false, engineChecksPassed: false }) };
    }
    return { status: 1, signal: null, stdout: "", stderr: "" };
  });
  ({ runtimeEngineLifecycleSmoke: smoke } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs"));
});
afterEach(async () => {
  await Promise.allSettled(observations.splice(0).map(observation => observation.result));
  vi.restoreAllMocks();
  actual.rmSync(vm.root, { recursive: true, force: true });
  vi.doUnmock("../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs");
  vi.doUnmock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs");
});

it("moves legacy HOME files after positive drain while preserving frozen physical roots and logical aliases",async ()=>{
  const homes = [
    { source: "/srv/zeros/home/agent", target: mutableLayout.agentHome, uid: 10001, mode: 0o755 },
    { source: "/srv/zeros/home/capture", target: mutableLayout.captureHome, uid: 10002, mode: 0o700 },
  ];
  const originals = homes.map(home => {
    const history = `${home.source}/history`, file = `${history}/retained.txt`;
    actual.mkdirSync(mapped(history), { mode: 0o700 });
    vm.owners.set(history, { uid: home.uid, gid: home.uid });
    actual.writeFileSync(mapped(file), "retained HOME state\n", { mode: 0o600 });
    vm.owners.set(file, { uid: home.uid, gid: home.uid });
    return { ...home, file, rootStat: actual.statSync(mapped(home.source)), fileStat: actual.statSync(mapped(file)) };
  });
  expect(smoke(runtime,{PATH:"/usr/bin:/bin",HOME:"/tmp"})).toBe(false);
  expect(qualified).toHaveBeenCalledOnce();
  await observeUnqualifiedRuntime();
  expect(vm.assertRetired).toHaveBeenCalled();
  expect(vm.assertRetired.mock.invocationCallOrder[0]).toBeLessThan(qualified.mock.invocationCallOrder[0]!);
  for (const home of originals) {
    const moved = `${home.target}/history/retained.txt`;
    expect(vm.owners.get(home.source)).toEqual({ uid: home.uid, gid: home.uid });
    expect(actual.statSync(mapped(home.source))).toMatchObject({ ino: home.rootStat.ino, dev: home.rootStat.dev, mode: home.rootStat.mode });
    expect(actual.statSync(mapped(home.source)).mode & 0o777).toBe(home.mode);
    expect(actual.existsSync(mapped(home.file))).toBe(false);
    expect(actual.readFileSync(mapped(moved), "utf8")).toBe("retained HOME state\n");
    expect(actual.statSync(mapped(moved))).toMatchObject({ ino: home.fileStat.ino, dev: home.fileStat.dev, mode: home.fileStat.mode });
    expect(vm.owners.get(home.target)).toEqual({ uid: 10003, gid: 10003 });
    expect(actual.statSync(mapped(home.target)).mode & 0o777).toBe(home.mode);
    expect(vm.owners.get(`${home.target}/history`)).toEqual({ uid: 10003, gid: 10003 });
    expect(vm.owners.get(moved)).toEqual({ uid: 10003, gid: 10003 });
  }
  expect(vm.owners.get("/srv/zeros/state")).toEqual({uid:10003,gid:10003});
  expect(vm.directoryRenames).toEqual([]);
});

it("preserves archived staging, logs and managed settings while preparing separate engine staging",async ()=>{
  const staging = mutableLayout.legacyStagingParent;
  const frozen = [
    { file: staging, mode: 0o710, directory: true },
    { file: "/srv/zeros/log", mode: 0o750, directory: true },
    { file: "/srv/zeros/log/engine.log", mode: 0o640, directory: false },
    { file: "/srv/zeros/managed-settings", mode: 0o750, directory: true },
    { file: "/srv/zeros/managed-settings/settings.managed.toml", mode: 0o640, directory: false },
  ].map(entry => {
    if (entry.directory) actual.mkdirSync(mapped(entry.file), { recursive: true, mode: entry.mode });
    else actual.writeFileSync(mapped(entry.file), "frozen base bytes\n");
    actual.chmodSync(mapped(entry.file), entry.mode);
    vm.owners.set(entry.file, { uid: 0, gid: 10001 });
    return { ...entry, stat: actual.statSync(mapped(entry.file)) };
  });
  const seed = `${staging}/seed`, seedFile = `${seed}/retained.txt`;
  actual.mkdirSync(mapped(seed), { mode: 0o700 });
  actual.writeFileSync(mapped(seedFile), "retained old setup seed\n", { mode: 0o600 });
  vm.owners.set(seed, { uid: 10001, gid: 10001 });
  vm.owners.set(seedFile, { uid: 10001, gid: 10001 });
  const seedStat = actual.statSync(mapped(seed)), seedFileStat = actual.statSync(mapped(seedFile));
  expect(smoke(runtime,{PATH:"/usr/bin:/bin",HOME:"/tmp"})).toBe(false);
  expect(qualified).toHaveBeenCalledOnce();
  await observeUnqualifiedRuntime();
  for (const entry of frozen) {
    expect(vm.owners.get(entry.file)).toEqual({ uid: 0, gid: 10001 });
    expect(actual.statSync(mapped(entry.file))).toMatchObject({ ino: entry.stat.ino, dev: entry.stat.dev, mode: entry.stat.mode });
    if (!entry.directory) expect(actual.readFileSync(mapped(entry.file), "utf8")).toBe("frozen base bytes\n");
  }
  expect(vm.owners.get(mutableLayout.stagingParent)).toEqual({ uid: 0, gid: 10003 });
  expect(actual.statSync(mapped(mutableLayout.stagingParent)).mode & 0o777).toBe(0o710);
  expect(vm.owners.get(seed)).toEqual({ uid: 10003, gid: 10003 });
  expect(vm.owners.get(seedFile)).toEqual({ uid: 10003, gid: 10003 });
  expect(actual.statSync(mapped(seed))).toMatchObject({ ino: seedStat.ino, dev: seedStat.dev, mode: seedStat.mode });
  expect(actual.statSync(mapped(seedFile))).toMatchObject({ ino: seedFileStat.ino, dev: seedFileStat.dev, mode: seedFileStat.mode });
  expect(actual.readFileSync(mapped(seedFile), "utf8")).toBe("retained old setup seed\n");
  expect(vm.directoryRenames).toEqual([]);
});

it.each(["busy", "unknown"])("refuses %s old-engine drain before migrating any HOME entry", condition => {
  const file = "/srv/zeros/home/agent/retained.txt";
  actual.writeFileSync(mapped(file), "unchanged pending drain\n");
  vm.owners.set(file, { uid: 10001, gid: 10001 });
  vm.assertRetired.mockImplementation(() => { throw new Error(`Synthetic ${condition} old-engine drain`); });
  expect(() => smoke(runtime, {})).toThrow(/old-engine drain/);
  expect(qualified).not.toHaveBeenCalled();
  expect(vm.execute).not.toHaveBeenCalled();
  expect(actual.readFileSync(mapped(file), "utf8")).toBe("unchanged pending drain\n");
  expect(vm.owners.get("/srv/zeros/home/agent")).toEqual({ uid: 10001, gid: 10001 });
  expect(actual.existsSync(mapped(mutableLayout.agentHome))).toBe(false);
  expect(actual.existsSync(mapped(mutableLayout.captureHome))).toBe(false);
  expect(vm.directoryRenames).toEqual([]);
});

it.each([
  { file: "/srv/zeros/home/agent", uid: 10003, gid: 10003, mode: 0o755 },
  { file: "/srv/zeros/home/capture", uid: 10002, gid: 10002, mode: 0o755 },
  { file: "/srv/zeros/managed-settings", uid: 0, gid: 10003, mode: 0o750 },
  { file: "/srv/zeros/files/.zeros-setup", uid: 0, gid: 10003, mode: 0o710 },
  { file: "/srv/zeros/log", uid: 0, gid: 10003, mode: 0o750 },
  { file: "/srv/zeros/home/engine", uid: 10001, gid: 10001, mode: 0o755 },
  { file: "/srv/zeros/home/engine-capture", uid: 10003, gid: 10003, mode: 0o755 },
  { file: "/srv/zeros/files/.zeros-engine-setup", uid: 0, gid: 10001, mode: 0o710 },
])("refuses invalid fixed source/traversal identity at $file before qualification", entry => {
  actual.mkdirSync(mapped(entry.file), { recursive: true, mode: entry.mode });
  actual.chmodSync(mapped(entry.file), entry.mode);
  vm.owners.set(entry.file, { uid: entry.uid, gid: entry.gid });
  expect(() => smoke(runtime, {})).toThrow(/ownership/);
  expect(qualified).not.toHaveBeenCalled();
  expect(vm.owners.get(entry.file)).toEqual({ uid: entry.uid, gid: entry.gid });
  expect(vm.directoryRenames).toEqual([]);
});

it("refuses a HOME file collision without overwriting either side", () => {
  actual.mkdirSync(mapped(mutableLayout.agentHome), { mode: 0o755 });
  vm.owners.set(mutableLayout.agentHome, { uid: 10003, gid: 10003 });
  const old = "/srv/zeros/home/agent/retained.txt", current = `${mutableLayout.agentHome}/retained.txt`;
  actual.writeFileSync(mapped(old), "legacy state\n");
  actual.writeFileSync(mapped(current), "current state\n");
  vm.owners.set(old, { uid: 10001, gid: 10001 });
  vm.owners.set(current, { uid: 10003, gid: 10003 });
  expect(() => smoke(runtime, {})).toThrow(/ownership/);
  expect(qualified).not.toHaveBeenCalled();
  expect(actual.readFileSync(mapped(old), "utf8")).toBe("legacy state\n");
  expect(actual.readFileSync(mapped(current), "utf8")).toBe("current state\n");
  expect(actual.existsSync(mapped(mutableLayout.captureHome))).toBe(false);
  expect(vm.directoryRenames).toEqual([]);
});

it("prepares a sanitized B4 layout and reaches the real launcher and qualification helper", async () => {
  expect(actual.readdirSync(mapped("/srv/zeros/files"))).toEqual([]);
  const umask = process.umask(0o077);
  try { expect(smoke(runtime, { PATH: "/usr/bin:/bin", HOME: "/tmp" })).toBe(false); }
  finally { process.umask(umask); }
  expect(qualified).toHaveBeenCalledOnce();
  await observeUnqualifiedRuntime();
  for (const name of ["home", "state", "managed-settings", "home/agent", "home/capture"]) {
    const file = `/srv/zeros/files/${name}`;
    expect(vm.owners.get(file)).toEqual({ uid: 0, gid: 0 });
    expect(actual.statSync(mapped(file)).mode & 0o777).toBe(0o755);
    if (name !== "home") expect(actual.readdirSync(mapped(file))).toEqual([]);
  }
  expect(vm.owners.get("/srv/zeros/files/workspace")).toEqual({ uid: 10003, gid: 10003 });
  expect(actual.readdirSync(mapped("/srv/zeros/files/workspace"))).toEqual([]);
  expect(vm.directoryRenames).toEqual([]);
});

it("preserves a populated build workspace while reaching the real qualification helper", async () => {
  const workspace = "/srv/zeros/files/workspace";
  actual.mkdirSync(mapped(workspace), { mode: 0o755 });
  actual.chmodSync(mapped(workspace), 0o755);
  vm.owners.set(workspace, { uid: 10001, gid: 10001 });
  actual.writeFileSync(mapped(`${workspace}/build-artifact.txt`), "retained build output\n", { mode: 0o640 });
  actual.mkdirSync(mapped(`${workspace}/source`));
  actual.writeFileSync(mapped(`${workspace}/source/main.js`), "export default 42;\n");
  const before = actual.statSync(mapped(workspace));

  expect(smoke(runtime, { PATH: "/usr/bin:/bin", HOME: "/tmp" })).toBe(false);

  expect(qualified).toHaveBeenCalledOnce();
  await observeUnqualifiedRuntime();
  expect(actual.readFileSync(mapped(`${workspace}/build-artifact.txt`), "utf8")).toBe("retained build output\n");
  expect(actual.statSync(mapped(`${workspace}/build-artifact.txt`)).mode & 0o777).toBe(0o640);
  expect(actual.readFileSync(mapped(`${workspace}/source/main.js`), "utf8")).toBe("export default 42;\n");
  expect(actual.readdirSync(mapped(workspace)).sort()).toEqual(["build-artifact.txt", "source"]);
  expect(actual.statSync(mapped(workspace)).ino).toBe(before.ino);
  expect(actual.statSync(mapped(workspace)).mode & 0o777).toBe(0o755);
  expect(vm.owners.get(workspace)).toEqual({ uid: 10003, gid: 10003 });
  expect(vm.directoryRenames).toEqual([]);
});

it.each(["symlink", "populated-mount", "legacy-workspace"])("refuses %s without reaching qualification or moving directories", kind => {
  if (kind === "symlink") actual.symlinkSync(mapped("/tmp"), mapped("/srv/zeros/files/home"));
  if (kind === "populated-mount") {
    actual.mkdirSync(mapped("/srv/zeros/files/state"));
    actual.writeFileSync(mapped("/srv/zeros/files/state/private"), "private-value");
  }
  if (kind === "legacy-workspace") actual.mkdirSync(mapped("/srv/zeros/workspace"));
  expect(() => smoke(runtime, {})).toThrow();
  expect(qualified).not.toHaveBeenCalled();
  expect(vm.directoryRenames).toEqual([]);
});

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
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: vm.execute,
}));

let actual: typeof fs;
let smoke: (runtime: object, environment: object) => boolean;
let runtime: { profile: string; root: string; node: string; workerRoot: string; binRoot: string; libRoot: string; engineNamespace: string };
let qualified: ReturnType<typeof vi.fn>;
const mapped = (file: string) => path.join(vm.root, file);

beforeEach(async () => {
  actual = await vi.importActual<typeof fs>("node:fs");
  vm.root = actual.realpathSync(actual.mkdtempSync(path.join(os.tmpdir(), "zeros-v2-test-smoke-layout-")));
  actual.chmodSync(vm.root, 0o755);
  vm.owners.clear(); vm.descriptors.clear(); vm.directoryRenames = []; vm.execute.mockReset();
  vi.resetModules();
  // B7 stays stacked on B5b until instructed to rebase. The inherited launcher
  // has the same mount contract; once B2 is present this exercises its v4 path.
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
  directory("/srv/zeros/managed-settings", 0, 0o750, 10001);
  for (const name of ["/usr/bin/bwrap", "/usr/bin/setpriv", "/usr/bin/rg", runtime.node, runtime.engineNamespace,
    `${runtime.workerRoot}/dist-engine/cli.js`, "/opt/zeros-runtime/bin/node", "/opt/zeros-runtime/cloud-engine-namespace", "/opt/zeros/dist-engine/cli.js"]) file(name);
  file("/opt/zeros/disk-epoch", "1\n");
  file("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "0\n");
  file("/proc/sys/kernel/overflowuid", "65534\n"); file("/proc/sys/kernel/overflowgid", "65534\n");
  file("/proc/self/cgroup", "0::/zeros-cloud-engine\n");
  const { prepareCloudEngineView } = await import("../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs");
  const { qualifyCloudEngineIdentity } = await import("../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs");
  qualified = vi.fn(qualifyCloudEngineIdentity);
  vm.execute.mockImplementation((executable: string, args: string[]) => {
    const success = { status: 0, signal: null, stdout: "", stderr: "" };
    if (executable === "/usr/bin/python3") return success;
    if (args[0] === `${runtime.libRoot}/cloud-engine-launcher.mjs` && args[1] === "--qualify") {
      const view = prepareCloudEngineView(runtime);
      try {
        const identity = qualified();
        // The local fake kernel cannot qualify. Reaching the real helper is
        // the boundary under test; no fake successful containment is returned.
        return { ...success, stdout: JSON.stringify({ version: 1, secure: identity.secure, identity }) };
      } finally { view.releaseView?.(); }
    }
    return { status: 1, signal: null, stdout: "", stderr: "" };
  });
  ({ runtimeContainmentSmoke: smoke } = await import("../cloud-workspace-validation/sandbox/runtime-self-test.mjs"));
});
afterEach(() => {
  actual.rmSync(vm.root, { recursive: true, force: true });
  vi.doUnmock("../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs");
  vi.doUnmock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs");
});

it("prepares a sanitized B4 layout and reaches the real launcher and qualification helper", () => {
  expect(actual.readdirSync(mapped("/srv/zeros/files"))).toEqual([]);
  const umask = process.umask(0o077);
  try { expect(smoke(runtime, { PATH: "/usr/bin:/bin", HOME: "/tmp" })).toBe(false); }
  finally { process.umask(umask); }
  expect(qualified).toHaveBeenCalledOnce();
  expect(qualified.mock.results[0].value.checks).toContainEqual({ name: "fixed-engine-user-namespace", status: "fail" });
  for (const name of ["home", "state", "managed-settings", "home/agent", "home/capture"]) {
    const file = `/srv/zeros/files/${name}`;
    expect(vm.owners.get(file)).toEqual({ uid: 0, gid: 0 });
    expect(actual.statSync(mapped(file)).mode & 0o777).toBe(0o755);
    if (name !== "home") expect(actual.readdirSync(mapped(file))).toEqual([]);
  }
  expect(vm.owners.get("/srv/zeros/files/workspace")).toEqual({ uid: 10001, gid: 10001 });
  expect(actual.readdirSync(mapped("/srv/zeros/files/workspace"))).toEqual([]);
  expect(vm.directoryRenames).toEqual([]);
});

it("preserves a populated build workspace while reaching the real qualification helper", () => {
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
  expect(actual.readFileSync(mapped(`${workspace}/build-artifact.txt`), "utf8")).toBe("retained build output\n");
  expect(actual.statSync(mapped(`${workspace}/build-artifact.txt`)).mode & 0o777).toBe(0o640);
  expect(actual.readFileSync(mapped(`${workspace}/source/main.js`), "utf8")).toBe("export default 42;\n");
  expect(actual.readdirSync(mapped(workspace)).sort()).toEqual(["build-artifact.txt", "source"]);
  expect(actual.statSync(mapped(workspace)).ino).toBe(before.ino);
  expect(actual.statSync(mapped(workspace)).mode & 0o777).toBe(0o755);
  expect(vm.owners.get(workspace)).toEqual({ uid: 10001, gid: 10001 });
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

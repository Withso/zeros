import { EventEmitter } from "node:events";
import {spawnSync,execFileSync} from "node:child_process";
import {copyFileSync,chmodSync,readFileSync,unlinkSync} from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { cloudEngineViewArguments, cloudEngineViewEnvironment, cloudEngineWorkerProjection } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { CloudEngineCgroup, CloudDelegatedCgroups, CLOUD_RUNTIME_LIMITS } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { launchCloudEngine } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";
import { CLOUD_ENGINE_MUTABLE_LAYOUT } from "../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

const trees: ReturnType<typeof cloudRuntimeFixture>[] = [];
const instance = "32345678-1234-4234-8234-123456789abc";
const view = `/run/zeros/view/runtime-${instance}`;
const nativeNamespaces=process.platform==="linux"&&spawnSync("sudo",["-n","/usr/bin/bwrap","--ro-bind","/","/","--unshare-pid","--proc","/proc","--","/usr/bin/true"],{stdio:"ignore"}).status===0;
function fixture(mapAbsoluteLinks = true) {
  const tree = cloudRuntimeFixture({ mapAbsoluteLinks }); trees.push(tree);
  const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
  return { tree, runtime };
}
afterEach(() => { for (const tree of trees.splice(0)) tree.dispose(); });

describe("v4 runtime launch containment", () => {
  // Positive native launch requires the explicitly authorized root/cgroup
  // fixture in cloud-engine-root-kernel.test.ts. A namespace alone supplies
  // neither original placement nor outside-root controller custody.
  it.skipIf(!nativeNamespaces)("refuses native engine execution without original cgroup placement",()=>{
    const {tree,runtime}=fixture(false);
    tree.write(`${runtime.workerRoot}/package.json`,{});
    const resolver=`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs`;
    tree.write(resolver,readFileSync(path.resolve("apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs"),"utf8"));
    tree.write(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`,"// fixed Host fixture");
    tree.write(`${runtime.workerRoot}/binaries/rg`,"fixture",0o555);
    for(const file of [runtime.node,runtime.engineNamespace])unlinkSync(tree.physical(file));
    copyFileSync(process.execPath,tree.physical(runtime.node));chmodSync(tree.physical(runtime.node),0o555);
    execFileSync("cc",["-std=c11","-O2","-Wall","-Wextra","-Werror","scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c","-o",tree.physical(runtime.engineNamespace)],{stdio:"pipe"});
    chmodSync(tree.physical(runtime.engineNamespace),0o500);
    tree.write(`${runtime.workerRoot}/dist-engine/cli.js`,
      "require('node:fs').writeFileSync('/srv/zeros/state/engine-executed','unexpected');");
    for(const directory of ["/srv/zeros/files/workspace/Design","/srv/zeros/state",CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome,CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome,"/run/zeros/engine","/run/zeros/view/settings",`${view}/facade/sessions`,`${view}/etc`])tree.mkdir(directory);
    tree.write(`${view}/etc/cloud-worker.json`,cloudEngineWorkerProjection(runtime));
    tree.write(`${view}/active-runtime.json`,tree.descriptor);
    for(const [name,target] of Object.entries({current:`../zeros-infra/${tree.descriptor.runtimeId}`,bin:"current/bin",worker:"current/worker","manifest.json":"current/manifest.json",logs:"/srv/zeros/log",state:"/srv/zeros/state"}))tree.link(`${view}/facade/${name}`,target);
    const args=cloudEngineViewArguments("serve",4,runtime,view);
    for(let i=0;i<args.length;i++)if(["--bind","--ro-bind"].includes(args[i])){
      const source=args[i+1];if(source.startsWith("/srv/zeros")||source.startsWith("/run/zeros")||source===runtime.root)args[i+1]=tree.physical(source);
    }
    try {
      execFileSync("sudo",["-n","/usr/bin/chown","-hR","0:0",tree.directory]);
      for(const directory of ["/srv/zeros/files/workspace","/srv/zeros/state","/run/zeros/engine",CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome,CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome])
        execFileSync("sudo",["-n","/usr/bin/chown","-hR","10003:10003",tree.physical(directory)]);
      const result=spawnSync("sudo",["-n","/usr/bin/unshare","--mount","--pid","--fork","--mount-proc","--","/usr/bin/bwrap",...args],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:15000,maxBuffer:4096});
      expect(result.error).toBeUndefined();expect(result.signal).toBeNull();
      expect(result.stderr).toBe("cloud engine namespace admission failed\n");
      expect(result.status).toBe(125);expect(result.stdout).toBe("");
      expect(()=>readFileSync(tree.physical("/srv/zeros/state/engine-executed"))).toThrow();
    } finally {execFileSync("sudo",["-n","/usr/bin/chown","-hR",`${process.getuid!()}:${process.getgid!()}`,tree.directory]);}
  },20000);
  it("mounts only the pinned physical runtime and private read-only descriptor projection", () => {
    const { runtime } = fixture();
    const args = cloudEngineViewArguments("serve", 4, runtime, view);
    const mounts = args.flatMap((arg: string, index: number) => ["--bind", "--ro-bind"].includes(arg)
      ? [[arg, args[index + 1], args[index + 2]]] : []);
    expect(mounts).toContainEqual(["--ro-bind", runtime.root, runtime.root]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/etc`, "/etc/zeros"]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/active-runtime.json`, "/run/zeros/active-runtime.json"]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/facade`, "/opt/zeros"]);
    expect(mounts).toContainEqual(["--bind", CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, "/srv/zeros/home/agent"]);
    expect(mounts).toContainEqual(["--bind", CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome, "/srv/zeros/home/capture"]);
    expect(cloudEngineWorkerProjection(runtime)).toMatchObject({ uid: 10003, gid: 10003 });
    expect(args.join("\n")).toContain("--tmpfs\n/srv/zeros/.zeros-setup\n--chmod\n0000\n/srv/zeros/.zeros-setup\n--remount-ro\n/srv/zeros/.zeros-setup");
    expect(mounts.some(([, source]: string[]) => source.startsWith("/home/user"))).toBe(false);
    for (const forbidden of ["/zeros", "/opt/zeros", "/opt/zeros-infra", "/opt/zeros-bootstrap", "/srv/zeros/runtime-installs", "/run/zeros", "/etc/zeros"])
      expect(mounts.some(([, source]: string[]) => source === forbidden)).toBe(false);
    expect(args.slice(-3)).toEqual([runtime.engineNamespace, "--runtime-id", runtime.profile === "v4" ? runtime.runtimeId : ""]);
    const env = cloudEngineViewEnvironment({ ZEROS_RUNTIME_ROOT: "/tmp/forged", NODE_OPTIONS: "--require=/tmp/forged" }, "serve", runtime);
    expect(env.PATH).toBe(`${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(env.ZEROS_PTY_HOST_SCRIPT).toBe(`${runtime.workerRoot}/apps/desktop/src/engine/pty/pty-host.cjs`);
    expect(env).not.toHaveProperty("ZEROS_RUNTIME_ROOT");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });
  it("never infers v4 from the common v3 UID map or an arbitrary view path", () => {
    expect(() => cloudEngineViewArguments("serve", 4)).toThrow();
    const { runtime } = fixture();
    for (const directory of ["/tmp/view", "/run/zeros/view/runtime-../../bad", "/run/zeros/engine"])
      expect(() => cloudEngineViewArguments("serve", 4, runtime, directory)).toThrow();
    expect(() => cloudEngineViewArguments("serve", 3, runtime, view)).toThrow();
  });
  it("passes the same resolved runtime through the native launch barrier and drains descendants on parent exit", async () => {
    const { runtime } = fixture();
    const order: string[] = [];
    const scopeDirectory = `${runtime.cgroupRoot}/engine-runtime/engine-${instance}`;
    const scope = { directory: scopeDirectory, placement: `${scopeDirectory}@0:11`, custodySeed: vi.fn(() => ({ version: 1,
      common: { directory: `${runtime.cgroupRoot}/engine-runtime`, dev: "0", ino: "9" },
      workload: { directory: `${runtime.cgroupRoot}/engine-runtime/engine-workload-shared/workload`, dev: "0", ino: "10" }, infrastructure: [] })),
      prepare: vi.fn(() => order.push("prepare")), attach: vi.fn(() => order.push("attach")),
      retire: vi.fn(async () => { order.push("retire-descendants"); }) };
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null,
      kill: vi.fn(), unref: vi.fn(), stdio: [null, null, null, new Writable({ write(_chunk, _encoding, done) {
        order.push("release"); done(); setImmediate(() => { child.exitCode = 0; child.emit("exit", 0); });
      } })] });
    const spawnProcess = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
    const result = await launchCloudEngine({ prepare: () => ({ version: 4, runtime, viewDirectory: view }),
      runtime, scope, spawnProcess, signals: new EventEmitter(), source: {}, assertOutside: vi.fn() });
    expect(result).toBe(0);
    expect(spawnProcess.mock.calls[0][0]).toBe(runtime.engineNamespace);
    expect(order).toEqual(["prepare", "release", "retire-descendants"]);
    expect(scope.attach).not.toHaveBeenCalled();
    expect(scope.retire).toHaveBeenCalledOnce();
  });
  it("does not create the private projection when scope admission fails before spawning", async () => {
    const { runtime }=fixture(),releaseView=vi.fn(),spawnProcess=vi.fn();
    await expect(launchCloudEngine({runtime,source:{},spawnProcess,
      prepare:()=>({version:4,runtime,viewDirectory:view,releaseView}),
      scope:{prepare(){throw new Error("scope refused");}}, assertOutside: vi.fn(),
    })).rejects.toThrow("scope refused");
    expect(spawnProcess).not.toHaveBeenCalled();expect(releaseView).not.toHaveBeenCalled();
  });
});

describe("v4 delegated cgroup lifecycle", () => {
  function groups() {
    const { runtime } = fixture();
    const root = runtime.cgroupRoot;
    const state = new Map<string, Map<string, string>>([
      [root, new Map([["cgroup.procs", ""], ["cgroup.controllers", "cpu memory pids"], ["cgroup.subtree_control", ""]])],
      [`${root}/host`, new Map([["cgroup.events", "populated 1"], ["cgroup.procs", "17"]])],
    ]);
    const io = { exists: vi.fn((file: string) => state.has(file)),
      create: vi.fn((file: string) => state.set(file, new Map([["cgroup.events", "populated 0"], ["cgroup.procs", ""]]))),
      children: vi.fn((file: string) => [...state.keys()].filter(key => key.startsWith(file + "/")).map(key => key.slice(file.length + 1))),
      read: vi.fn((file: string, control: string) => state.get(file)?.get(control) ?? ""),
      write: vi.fn((file: string, control: string, value: string) => {
        state.get(file)!.set(control, value.replaceAll("+", ""));
        if (control === "cgroup.kill") state.get(file)!.set("cgroup.events", "populated 0");
      }),
      remove: vi.fn((file: string) => { state.delete(file); }),
    };
    return { runtime, root, state, io };
  }
  it("retains finite setup and archived direct engine leaves under the descriptor root", async () => {
    const { runtime, root, state, io } = groups();
    for (const kind of ["setup", "engine"]) {
      const scope = new CloudEngineCgroup({ runtime, kind, instanceId: instance, io,
        directory: `${root}/${kind === "engine" ? `engine-${instance}` : kind}` });
      expect(scope.directory).toBe(`${root}/${kind === "engine" ? `engine-${instance}` : kind}`);
      scope.prepare(); scope.attach(123);
      for (const [key, value] of Object.entries(CLOUD_RUNTIME_LIMITS)) expect(state.get(scope.directory)?.get(key)).toBe(value);
      // A detached descendant remains after the launcher's exit.
      state.get(scope.directory)!.set("cgroup.events", "populated 1");
      state.get(scope.directory)!.set("cgroup.procs", "456");
      await scope.retire();
      expect(io.write).toHaveBeenCalledWith(scope.directory, "cgroup.kill", "1");
      expect(state.has(scope.directory)).toBe(false);
    }
    for (const directory of ["/sys/fs/cgroup/zeros-cloud-engine", `${root}/host`, `${root}/setup/nested`, `${root}/engine-arbitrary`])
      expect(() => new CloudEngineCgroup({ runtime, directory, io })).toThrow(/scope identity/);
  });
  it("bounds host resources only after proving the delegated parent empty and its host membership", async () => {
    const { runtime, root, state, io } = groups();
    const delegated = new CloudDelegatedCgroups({ runtime, io,
      readMembership: () => `0::${root.slice("/sys/fs/cgroup".length)}/host\n` });
    delegated.prepareHost();
    expect(state.get(root)?.get("cgroup.subtree_control")).toBe("cpu memory pids");
    for (const name of ["cpu.max", "memory.max", "pids.max"]) expect(state.get(`${root}/host`)?.get(name)).not.toContain("max");
    expect(state.get(`${root}/host`)?.get("memory.oom.group")).toBe("1");
    const engine = `${root}/engine-${instance}`;
    state.set(engine, new Map([["cgroup.events", "populated 1"]]));
    state.set(`${root}/setup`, new Map([["cgroup.events", "populated 1"]]));
    await delegated.retire();
    expect([...state.keys()]).toEqual([root, `${root}/host`]);
    expect(io.write).not.toHaveBeenCalledWith(`${root}/host`, "cgroup.kill", "1");
    state.get(root)!.set("cgroup.procs", "123");
    expect(() => delegated.prepareHost()).toThrow(/parent/);
  });
  it("fails closed for unexpected children, wrong service membership and unconfirmed drain", async () => {
    const { runtime, root, state, io } = groups();
    const delegated = new CloudDelegatedCgroups({ runtime, io, readMembership: () => "0::/other.service/host\n" });
    expect(() => delegated.prepareHost()).toThrow(/membership/);
    state.set(`${root}/untrusted`, new Map());
    await expect(delegated.retire()).rejects.toThrow(/unexpected/i);
    state.delete(`${root}/untrusted`);
    const scope = new CloudEngineCgroup({ runtime, kind: "setup", io, now: () => 100, pause: async () => {} });
    scope.prepare(); state.get(scope.directory)!.set("cgroup.events", "populated 1");
    io.write.mockImplementation(() => {});
    let now = 0; scope.now = () => now += 100;
    await expect(scope.retire(1)).rejects.toThrow(/unconfirmed/);
    expect(state.has(scope.directory)).toBe(true);
  });
});

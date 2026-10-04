import { EventEmitter } from "node:events";
import {spawnSync,execFileSync} from "node:child_process";
import {copyFileSync,chmodSync,readFileSync} from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { cloudEngineViewArguments, cloudEngineViewEnvironment } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { CloudEngineCgroup, CloudDelegatedCgroups, CLOUD_ENGINE_LIMITS } from "../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { launchCloudEngine } from "../cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs";

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
  it.skipIf(!nativeNamespaces)("preserves host, engine and cross-actor read boundaries through the actual v4 native transition",()=>{
    const {tree,runtime}=fixture(false);
    const resolverSource=path.resolve("apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs");
    const resolver=`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs`;
    tree.write(`${runtime.workerRoot}/package.json`,{});
    tree.write(resolver,readFileSync(resolverSource,"utf8"));
    copyFileSync(process.execPath,tree.physical(runtime.node));chmodSync(tree.physical(runtime.node),0o555);
    execFileSync("cc",["-std=c11","-O2","-Wall","-Wextra","-Werror",
      "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c","-o",tree.physical(runtime.engineNamespace)],{stdio:"pipe"});
    chmodSync(tree.physical(runtime.engineNamespace),0o500);
    const childSource=`import fs from 'node:fs';
      import {resolveCloudRuntimeChild} from ${JSON.stringify(resolver)};
      if(resolveCloudRuntimeChild().root!==${JSON.stringify(runtime.root)})process.exit(20);
      const uid=process.getuid();
      for(const other of [0,10001,10002,10004]) {
        let readable=false;try{readable=fs.readFileSync('/tmp/actor-'+other+'/private','utf8')==='fixture';}catch(e){if(e.code!=='EACCES')throw e;}
        if(readable!==(uid===other))process.exit(21);
      }
      for(const file of ['/run/zeros/active-runtime.json','/srv/zeros/state/private','/proc/1/environ']){
        try{fs.readFileSync(file);process.exit(22);}catch(e){if(!['EACCES','EPERM','ENOENT','ESRCH'].includes(e.code))throw e;}
      }
      try{process.setuid(0);process.exit(23);}catch{}
      process.stdout.write('isolated');`;
    tree.write(`${runtime.workerRoot}/dist-engine/cli.js`,`const fs=require('node:fs'),{spawnSync}=require('node:child_process');
      (async()=>{
        const {resolveCloudRuntime,hasCloudEngineUserNamespace}=await import(${JSON.stringify(resolver)});
        const runtime=resolveCloudRuntime();
        if(runtime.profile!=='v4'||!hasCloudEngineUserNamespace(4))throw new Error('profile');
        for(const file of ['/opt/zeros-bootstrap','/srv/zeros/runtime-installs','/root','/run/zeros/cloud-worker-supervisor.sock'])
          if(fs.existsSync(file))throw new Error('host exposure');
        for(const uid of [0,10001,10002,10004]){
          const directory='/tmp/actor-'+uid;fs.mkdirSync(directory,{mode:0o700});fs.chownSync(directory,uid,uid);
          fs.writeFileSync(directory+'/private','fixture',{mode:0o600});fs.chownSync(directory+'/private',uid,uid);
        }
        for(const uid of [10001,10002,10004]){
          const result=spawnSync('/usr/bin/setpriv',['--reuid='+uid,'--regid='+uid,'--clear-groups','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--no-new-privs','--',runtime.node,'--input-type=module','-e',${JSON.stringify(childSource)}],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});
          if(result.status!==0||result.stdout!=='isolated')throw new Error('actor '+uid+' status '+result.status+' '+result.stderr);
        }
        process.stdout.write('v4 actors isolated');
      })().catch(e=>{process.stderr.write(e.message);process.exitCode=1;});`);
    for(const directory of ["/srv/zeros/files/workspace","/srv/zeros/state","/srv/zeros/home/agent","/srv/zeros/home/capture","/run/zeros/engine","/run/zeros/view/settings",`${view}/facade/sessions`,`${view}/etc`])tree.mkdir(directory);
    tree.write("/srv/zeros/state/private","fixture",0o600);
    for(const name of ["policy.json","registries.conf"])tree.write(`/etc/containers/${name}`,"{}");
    tree.write(`${view}/etc/cloud-worker.json`,{...tree.marker,toolchain:{node:runtime.node,supervisor:`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`,bwrap:"/usr/bin/bwrap",setpriv:"/usr/bin/setpriv"}});
    tree.write(`${view}/active-runtime.json`,tree.descriptor);
    for(const [name,target] of Object.entries({current:`../zeros-infra/${tree.descriptor.runtimeId}`,bin:"current/bin",worker:"current/worker","manifest.json":"current/manifest.json",logs:"/srv/zeros/log",state:"/srv/zeros/state"}))tree.link(`${view}/facade/${name}`,target);
    const args=cloudEngineViewArguments("serve",4,runtime,view);
    for(let i=0;i<args.length;i++)if(["--bind","--ro-bind"].includes(args[i])){
      const source=args[i+1];
      if(source.startsWith("/srv/zeros")||source.startsWith("/run/zeros")||source.startsWith("/etc/containers")||source===runtime.root)args[i+1]=tree.physical(source);
    }
    // All ownership changes are confined to the injectable fixture tree.
    // Never follow its intentional facade symlinks onto the host filesystem.
    try {
      execFileSync("sudo",["-n","/usr/bin/chown","-hR","0:0",tree.directory]);
      for(const [directory,uid] of [["/srv/zeros/state",10003],["/run/zeros/engine",10003],["/srv/zeros/home/agent",10001],["/srv/zeros/home/capture",10002]] as const){
        execFileSync("sudo",["-n","/usr/bin/chown","-hR",`${uid}:${uid}`,tree.physical(directory)]);
        execFileSync("sudo",["-n","/usr/bin/chmod","0700",tree.physical(directory)]);
      }
      const result=spawnSync("sudo",["-n","/usr/bin/bwrap",...args],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:20000,maxBuffer:4096});
      expect(result.stderr).toBe("");expect(result.status).toBe(0);expect(result.stdout).toBe("v4 actors isolated");
    } finally {execFileSync("sudo",["-n","/usr/bin/chown","-hR",`${process.getuid!()}:${process.getgid!()}`,tree.directory]);}
  },30000);
  it("mounts only the pinned physical runtime and private read-only descriptor projection", () => {
    const { runtime } = fixture();
    const args = cloudEngineViewArguments("serve", 4, runtime, view);
    const mounts = args.flatMap((arg: string, index: number) => ["--bind", "--ro-bind"].includes(arg)
      ? [[arg, args[index + 1], args[index + 2]]] : []);
    expect(mounts).toContainEqual(["--ro-bind", runtime.root, runtime.root]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/etc`, "/etc/zeros"]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/active-runtime.json`, "/run/zeros/active-runtime.json"]);
    expect(mounts).toContainEqual(["--ro-bind", `${view}/facade`, "/opt/zeros"]);
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
    const scope = { prepare: vi.fn(() => order.push("prepare")), attach: vi.fn(() => order.push("attach")),
      retire: vi.fn(async () => { order.push("retire-descendants"); }) };
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null,
      kill: vi.fn(), unref: vi.fn(), stdio: [null, null, null, new Writable({ write(_chunk, _encoding, done) {
        order.push("release"); done(); setImmediate(() => { child.exitCode = 0; child.emit("exit", 0); });
      } })] });
    const spawnProcess = vi.fn(() => { setImmediate(() => child.emit("spawn")); return child; });
    const result = await launchCloudEngine({ prepare: () => ({ version: 4, runtime, viewDirectory: view }),
      runtime, scope, spawnProcess, signals: new EventEmitter(), source: {} });
    expect(result).toBe(0);
    expect(spawnProcess.mock.calls[0][0]).toBe(runtime.engineNamespace);
    expect(order).toEqual(["prepare", "attach", "release", "retire-descendants"]);
    expect(scope.retire).toHaveBeenCalledOnce();
  });
  it("removes the private projection when scope admission fails before spawning", async () => {
    const { runtime }=fixture(),releaseView=vi.fn(),spawnProcess=vi.fn();
    await expect(launchCloudEngine({runtime,source:{},spawnProcess,
      prepare:()=>({version:4,runtime,viewDirectory:view,releaseView}),
      scope:{prepare(){throw new Error("scope refused");}},
    })).rejects.toThrow("scope refused");
    expect(spawnProcess).not.toHaveBeenCalled();expect(releaseView).toHaveBeenCalledOnce();
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
  it("uses only setup and per-instance engine leaves under the descriptor root with finite group limits", async () => {
    const { runtime, root, state, io } = groups();
    for (const kind of ["setup", "engine"]) {
      const scope = new CloudEngineCgroup({ runtime, kind, instanceId: instance, io });
      expect(scope.directory).toBe(`${root}/${kind === "engine" ? `engine-${instance}` : kind}`);
      scope.prepare(); scope.attach(123);
      for (const [key, value] of Object.entries(CLOUD_ENGINE_LIMITS)) expect(state.get(scope.directory)?.get(key)).toBe(value);
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

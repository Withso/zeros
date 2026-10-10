import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { Writable } from "node:stream";
import { cloudRuntimeFixture } from "../../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { createCloudRuntimeResolver } from "../../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudEngineViewArguments, cloudEngineViewEnvironment } from "../../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { CloudEngineCgroup, CloudRuntimeCgroup, CLOUD_HOST_LIMITS } from "../../cloud-workspace-validation/sandbox/cloud-engine-cgroup.mjs";
import { cloudRootControllerBirth, cloudRootProcessBirth } from "../../cloud-workspace-validation/sandbox/publish-cloud-workload-custody.mjs";
import { CLOUD_ENGINE_MUTABLE_LAYOUT } from "../../cloud-workspace-validation/sandbox/prepare-cloud-image-files.mjs";

/** Single explicitly authorized kernel venue. Existing host cgroups and their
 * limits stay untouched; root memory/pids enablement is restored byte-exactly. */
export async function runCloudEngineRootKernelFixture() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || fs.statfsSync("/sys/fs/cgroup").type !== 0x63677270)
    throw new Error("runtime_kernel_fixture_unavailable");
  const tree = cloudRuntimeFixture({ mapAbsoluteLinks: false });
  const id = randomUUID(), prefix = "/sys/fs/cgroup/zeros-c4-qual";
  const service = `${prefix}/zeros-host.service`, common = `${service}/engine-runtime`;
  const control = `${common}/engine-${id}`, container = `${common}/engine-workload-shared`, workload = `${container}/workload`;
  const host = `${service}/host`, view = `/run/zeros/view/runtime-${id}`;
  let monitor: ReturnType<typeof spawn> | undefined;
  let venueOwned = false;
  let result: Record<string, unknown> | undefined;
  const rootControllersBefore = fs.readFileSync("/sys/fs/cgroup/cgroup.subtree_control", "utf8");
  const write = (directory: string, name: string, value: string) => fs.writeFileSync(`${directory}/${name}`, value);
  const create = (directory: string, controllers = "") => {
    fs.mkdirSync(directory, { mode: 0o755 });
    if (controllers) write(directory, "cgroup.subtree_control", controllers);
  };
  const identity = (directory: string) => {
    const stat = fs.statSync(directory, { bigint: true });
    return { directory, dev: String(stat.dev), ino: String(stat.ino) };
  };
  const removeEmpty = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) removeEmpty(`${directory}/${entry.name}`);
    fs.rmdirSync(directory);
  };
  const readProcess = (pid: number) => ({ source: fs.readFileSync(`/proc/${pid}/stat`, "utf8"),
    status: fs.readFileSync(`/proc/${pid}/status`, "utf8"), membership: fs.readFileSync(`/proc/${pid}/cgroup`, "utf8") });
  try {
    if (fs.existsSync(prefix)) throw new Error("runtime_kernel_venue_already_exists");
    const needed = ["memory", "pids"].filter(name => !rootControllersBefore.trim().split(/\s+/).includes(name));
    if (needed.length) {
      try { fs.writeFileSync("/sys/fs/cgroup/cgroup.subtree_control", needed.map(name => `+${name}`).join(" ")); }
      catch { throw new Error("runtime_kernel_controllers_refused"); }
    }
    create(prefix, "+cpu +memory +pids"); venueOwned = true;
    create(service, "+cpu +memory +pids"); create(host);
    for (const [name, value] of Object.entries(CLOUD_HOST_LIMITS)) write(host, name, value as string);
    const descriptor = { ...tree.descriptor, cgroupRoot: service };
    tree.write("/run/zeros/active-runtime.json", descriptor, 0o600);
    const runtime = createCloudRuntimeResolver({ filesystem: tree.filesystem }).resolve();
    const resourceContract = { architecture: "linux/amd64", cpuMillicores: 8000, memoryMiB: 8192, storageMiB: 20480 };
    const original = new CloudEngineCgroup({ runtime, instanceId: id, resourceContract }); original.prepare();
    tree.write(`${runtime.workerRoot}/package.json`, {});
    for (const filename of [runtime.node, runtime.engineNamespace]) fs.unlinkSync(tree.physical(filename));
    fs.copyFileSync(process.execPath, tree.physical(runtime.node)); fs.chmodSync(tree.physical(runtime.node), 0o555);
    execFileSync("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c", "-o", tree.physical(runtime.engineNamespace)], { stdio: "pipe" });
    fs.chmodSync(tree.physical(runtime.engineNamespace), 0o500);
    tree.write(`${runtime.libRoot}/publish-cloud-workload-custody.mjs`,
      fs.readFileSync("scripts/cloud-workspace-validation/sandbox/publish-cloud-workload-custody.mjs", "utf8"));
    for (const filename of ["cloud-runtime-root.mjs", "cloud-deployment-authority.mjs", "cloud-workload-cgroup.mjs", "cloud-host-workload-entry.mjs"])
      tree.write(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/${filename}`,
        fs.readFileSync(`apps/desktop/src/engine/agents/containment/${filename}`, "utf8"));
    for (const directory of ["/srv/zeros/files/workspace", "/srv/zeros/state", CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome,
      "/run/zeros/engine", "/run/zeros/view/settings", "/run/zeros/workload-custody", `${view}/facade/sessions`, `${view}/etc`]) tree.mkdir(directory);
    fs.chmodSync(tree.physical("/run/zeros/workload-custody"), 0o700);
    tree.write(`${view}/etc/cloud-worker.json`, { ...tree.marker, uid: 10003, gid: 10003,
      toolchain: { node: runtime.node, supervisor: `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } });
    tree.write(`${view}/active-runtime.json`, descriptor);
    const seed = original.custodySeed();
    tree.write(`${view}/etc/cloud-workload-custody.json`, seed);
    for (const [name, target] of Object.entries({ current: `../zeros-infra/${runtime.runtimeId}`, bin: "current/bin", worker: "current/worker",
      "manifest.json": "current/manifest.json", logs: "/srv/zeros/log", state: "/srv/zeros/state" })) tree.link(`${view}/facade/${name}`, target);
    const kernelHelper = `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs`;
    const entryHelper = `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-host-workload-entry.mjs`;
    tree.write(`${runtime.workerRoot}/dist-engine/kernel-agent.mjs`, `
      import fs from 'node:fs';import cp from 'node:child_process';import assert from 'node:assert/strict';
      import {enterCloudHostWorkload} from ${JSON.stringify(entryHelper)};
      const projection=JSON.parse(fs.readFileSync('/etc/zeros/cloud-workload-custody.json','utf8'));
      enterCloudHostWorkload(Buffer.from(JSON.stringify({version:1,common:projection.common,workload:projection.workload})).toString('base64url'));
      assert.deepEqual([process.getuid(),process.geteuid(),process.getgid(),process.getegid()],[10003,10003,10003,10003]);
      for(const map of ['uid_map','gid_map'])assert.deepEqual(fs.readFileSync('/proc/self/'+map,'utf8').trim().split(/\\s+/),['10003','10003','1']);
      const status=new Map(fs.readFileSync('/proc/self/status','utf8').split('\\n').map(line=>{const colon=line.indexOf(':');return [line.slice(0,colon),line.slice(colon+1).trim()]}));
      for(const cap of ['CapEff','CapPrm','CapInh','CapBnd','CapAmb'])assert.equal(status.get(cap),'0000000000000000');
      assert.equal(status.get('NoNewPrivs'),'1');assert.equal(status.get('Seccomp'),'2');
      assert.equal(fs.readFileSync('/srv/zeros/state/shared','utf8'),'engine state');
      fs.writeFileSync('/srv/zeros/state/shared','child state');
      fs.writeFileSync('/srv/zeros/workspace/Design/edit','shared');
      fs.writeFileSync('/srv/zeros/state/entry-proof',fs.readFileSync('/proc/self/cgroup','utf8'));
      const sibling=${JSON.stringify(common + "/fixture-sibling")};fs.mkdirSync(sibling);
      const marker='/srv/zeros/state/detached-marker';
      const child=cp.spawn(process.execPath,['-e','const fs=require("node:fs");fs.writeFileSync('+JSON.stringify(sibling+'/cgroup.procs')+',"0");setInterval(()=>fs.writeFileSync('+JSON.stringify(marker)+',String(Date.now())),15);'],
        {detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:'/srv/zeros/home/agent'}});child.unref();
      fs.writeFileSync('/srv/zeros/state/writer-pid',String(child.pid));
    `);
    tree.write(`${runtime.workerRoot}/dist-engine/cli.js`, `
      const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
      (async()=>{
      const {resolveCloudRuntime,hasCloudEngineUserNamespace}=await import(${JSON.stringify(`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs`)});
      assert.equal(resolveCloudRuntime().root,${JSON.stringify(runtime.root)});assert(hasCloudEngineUserNamespace(4));
      for(const file of ['/opt/zeros-bootstrap','/srv/zeros/runtime-installs','/root','/home/user','/srv/zeros/setup','/run/zeros/cloud-worker-supervisor.sock'])assert(!fs.existsSync(file));
      const {loadCloudWorkloadCustody,inspectCloudWorkloadTree}=await import(${JSON.stringify(kernelHelper)});
      const custody=loadCloudWorkloadCustody(${JSON.stringify(service)});
      const common=${JSON.stringify(common)},pool=${JSON.stringify(workload)};
      const before=fs.readFileSync('/proc/self/cgroup','utf8');
      const status=fs.readFileSync('/proc/self/status','utf8');
      const projection=JSON.parse(fs.readFileSync('/etc/zeros/cloud-workload-custody.json','utf8'));
      const closed=!fs.existsSync('/run/zeros/workload-custody');
      let limitsDenied=false,hostDenied=false;
      try{fs.writeFileSync(common+'/cpu.max','max 100000')}catch{limitsDenied=true}
      try{fs.writeFileSync(${JSON.stringify(host)}+'/cgroup.procs','0')}catch{hostDenied=true}
      fs.mkdirSync('/srv/zeros/workspace/Design');
      fs.writeFileSync('/srv/zeros/state/shared','engine state',{mode:0o600});
      const marker='/srv/zeros/state/detached-marker';
      const child=cp.spawn(process.execPath,[${JSON.stringify(runtime.workerRoot + "/dist-engine/kernel-agent.mjs")}],
        {stdio:'ignore',env:{PATH:'/usr/bin:/bin',HOME:'/srv/zeros/home/agent'}});
      const code=await new Promise(resolve=>child.once('exit',resolve));if(code!==0)process.exit(125);
      const sharedStateReadback=fs.readFileSync('/srv/zeros/state/shared','utf8'),checkoutEditReadback=fs.readFileSync('/srv/zeros/workspace/Design/edit','utf8');
      const started=Date.now();const timer=setInterval(()=>{
        if(!fs.existsSync(marker)){if(Date.now()-started>3000)process.exit(125);return;}clearInterval(timer);
        const census=inspectCloudWorkloadTree(custody),writerPid=Number(fs.readFileSync('/srv/zeros/state/writer-pid','utf8'));
        process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),pid:process.pid,childPid:child.pid,
          writerPid,agentExit:code,sharedStateReadback,checkoutEditReadback,census:{complete:census.complete,workloadPids:census.workloadPids,infrastructurePids:census.infrastructurePids},
          uidMap:fs.readFileSync('/proc/self/uid_map','utf8').trim(),gidMap:fs.readFileSync('/proc/self/gid_map','utf8').trim(),
          status:Object.fromEntries(['CapEff','CapPrm','CapInh','CapBnd','CapAmb','NoNewPrivs','Seccomp'].map(k=>[k,status.match(new RegExp('^'+k+':\\\\s+(\\\\S+)','m'))?.[1]])),
          initialMembership:before.trim(),membership:fs.readFileSync('/proc/self/cgroup','utf8').trim(),
          projection,controlAliasAbsent:closed,limitsDenied,hostDenied,entryMembership:fs.readFileSync('/srv/zeros/state/entry-proof','utf8').trim()})+'\\n');
      },10);setInterval(()=>{if(fs.existsSync('/srv/zeros/state/move-controller'))fs.writeFileSync(pool+'/cgroup.procs','0')},10);
      })().catch(()=>{process.stderr.write('runtime_kernel_engine_refused');process.exitCode=125;});
    `);
    for (const directory of ["/srv/zeros/files/workspace", "/srv/zeros/state", "/run/zeros/engine", CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome, CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome])
      fs.chownSync(tree.physical(directory), 10003, 10003);
    const originalScope = original.original.control, placement = original.placement;
    const args = cloudEngineViewArguments("serve", 4, runtime, view, undefined, undefined, placement);
    for (let index = 0; index < args.length; index++) if (["--bind", "--ro-bind"].includes(args[index])) {
      const source = args[index + 1];
      if (source.startsWith("/srv/zeros") || source.startsWith("/run/zeros") || source === runtime.root) args[index + 1] = tree.physical(source);
    }
    const monitorFile = path.join(tree.directory, "root-monitor.cjs");
    fs.writeFileSync(monitorFile, `const fs=require('node:fs'),{spawn}=require('node:child_process');
      const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));let b=Buffer.alloc(1);if(fs.readSync(3,b,0,1,null)!==1||b[0]!==49)process.exit(125);fs.closeSync(3);
      const child=spawn(config.binary,['--await-launch',...config.args],{cwd:'/',env:config.env,stdio:['ignore','inherit','inherit','pipe']});
      child.once('spawn',()=>child.stdio[3].end('1'));child.once('error',()=>process.exitCode=125);
      child.once('exit',code=>process.exitCode=code??125);`, { mode: 0o600 });
    const configFile = path.join(tree.directory, "root-monitor.json");
    fs.writeFileSync(configFile, JSON.stringify({ binary: tree.physical(runtime.engineNamespace), args, env: cloudEngineViewEnvironment({}, "serve", runtime) }), { mode: 0o600 });
    monitor = spawn(process.execPath, [monitorFile, configFile], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    if (!monitor.pid || !monitor.stdout || !monitor.stderr || !(monitor.stdio[3] instanceof Writable)) throw new Error("runtime_kernel_monitor_unavailable");
    write(host, "cgroup.procs", String(monitor.pid));
    const ownerBirth = cloudRootProcessBirth(monitor.pid, fs.readFileSync(`/proc/${monitor.pid}/stat`, "utf8"));
    const context = { version: 1, episode: randomUUID(), runtime: { runtimeId: runtime.runtimeId,
      bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId }, scope: originalScope,
      owner: { pid: monitor.pid, startToken: ownerBirth.startToken } };
    tree.write(`/run/zeros/workload-custody/${path.basename(control)}.launch.json`, context, 0o444);
    let output = "", stderrBytes = 0;
    const exited = new Promise<number | null>(resolve => { monitor!.once("exit", resolve); monitor!.once("error", () => resolve(null)); });
    monitor.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    const proof = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("runtime_kernel_target_timeout")), 10_000);
      monitor!.stdout!.on("data", chunk => {
        output += chunk;
        if (output.length > 65536) { clearTimeout(timer); reject(new Error("runtime_kernel_output_overflow")); }
        if (output.endsWith("\n")) { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch { reject(new Error("runtime_kernel_output_invalid")); } }
      });
      void exited.then(() => { if (!output) { clearTimeout(timer); reject(new Error(`runtime_kernel_target_refused_${stderrBytes}`)); } });
    });
    monitor.stdio[3].end("1");
    const witness = await proof;
    const record = JSON.parse(fs.readFileSync(tree.physical(`/run/zeros/workload-custody/${path.basename(control)}.json`), "utf8"));
    const verifiedBirth = cloudRootControllerBirth(record, context, { identity, process: readProcess });
    const recordBeforeEntry = verifiedBirth.pid === witness.pid && record.scope.ino === originalScope.ino && record.owner.pid === monitor.pid;
    const rootOutside = [record.owner.pid, record.monitor.pid].every(pid => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() === `0::${host.slice("/sys/fs/cgroup".length)}`);
    const sibling = `${common}/fixture-sibling`;
    const detachedMembership = fs.readFileSync(`/proc/${witness.writerPid}/cgroup`, "utf8").trim();
    const marker = tree.physical("/srv/zeros/state/detached-marker");
    const before = fs.readFileSync(marker, "utf8");
    await new Promise(resolve => setTimeout(resolve, 50));
    const detachedWriting = fs.readFileSync(marker, "utf8") !== before;
    const kernelMembers = [control, workload, sibling].flatMap(directory => fs.readFileSync(`${directory}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean).map(Number));
    const everyTreeMemberNonRoot = kernelMembers.length >= 2 && kernelMembers.every(pid => /^Uid:\s+10003\s+10003\s+10003\s+10003$/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8")));
    const actualLimits = { common: Object.fromEntries(["cpu.max", "memory.max", "pids.max", "memory.oom.group"].map(name => [name, fs.readFileSync(`${common}/${name}`, "utf8").trim()])),
      engine: Object.fromEntries(["cpu.max", "cpu.weight"].map(name => [name, fs.readFileSync(`${control}/${name}`, "utf8").trim()])),
      workload: Object.fromEntries(["cpu.max", "cpu.weight"].map(name => [name, fs.readFileSync(`${workload}/${name}`, "utf8").trim()])),
      controllers: fs.readFileSync(`${container}/cgroup.subtree_control`, "utf8").trim() };
    tree.write("/srv/zeros/state/move-controller", "1");
    for (let attempt = 0; attempt < 200 && fs.readFileSync(`/proc/${witness.pid}/cgroup`, "utf8").trim() !== `0::${workload.slice("/sys/fs/cgroup".length)}`; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    let movedControllerRefused = false;
    try { cloudRootControllerBirth(record, context, { identity, process: readProcess }); } catch { movedControllerRefused = true; }
    const finalReceipt = await new CloudRuntimeCgroup({ runtime }).retire();
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("runtime_kernel_monitor_retirement_unconfirmed")), 5000))]);
    const stopped = fs.readFileSync(marker, "utf8"); await new Promise(resolve => setTimeout(resolve, 50));
    result = { ...witness, recordBeforeEntry, rootOutside, everyTreeMemberNonRoot, detachedWriting, movedControllerRefused, actualLimits,
      detachedMembership, expectedSiblingMembership: `0::${sibling.slice("/sys/fs/cgroup".length)}`,
      finalReceipt, treeRemoved: !fs.existsSync(common), detachedWritesStopped: fs.readFileSync(marker, "utf8") === stopped,
      stderrBytes, resourceQualification: false, hostEntryQualification: true, kernel: "private-domain",
      memoryBudget: original.memoryBudget, rootControllersBefore };
    return result;
  } finally {
    if (venueOwned && fs.existsSync(common)) { write(common, "cgroup.kill", "1"); }
    if (monitor?.pid && monitor.exitCode === null && monitor.signalCode === null) {
      monitor.kill("SIGKILL"); await new Promise(resolve => { monitor!.once("exit", resolve); setTimeout(resolve, 5000); });
    }
    if (venueOwned && fs.existsSync(prefix)) {
      for (let attempt = 0; attempt < 200 && /populated 1/.test(fs.readFileSync(`${prefix}/cgroup.events`, "utf8")); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      removeEmpty(prefix);
    }
    const current = fs.readFileSync("/sys/fs/cgroup/cgroup.subtree_control", "utf8").trim().split(/\s+/);
    const originalControllers = rootControllersBefore.trim().split(/\s+/);
    const added = ["memory", "pids"].filter(name => current.includes(name) && !originalControllers.includes(name));
    if (added.length) fs.writeFileSync("/sys/fs/cgroup/cgroup.subtree_control", added.map(name => `-${name}`).join(" "));
    const rootControllersAfter = fs.readFileSync("/sys/fs/cgroup/cgroup.subtree_control", "utf8");
    if (result) Object.assign(result, { rootControllersAfter, rootControllersRestored: rootControllersAfter === rootControllersBefore,
      venueRemoved: !fs.existsSync(prefix), platform: "AL2023", boatUbuntuQualified: false });
    // Restoration failure must remain fatal even if the fixture body failed.
    // eslint-disable-next-line no-unsafe-finally
    if (rootControllersAfter !== rootControllersBefore) throw new Error("runtime_kernel_root_controllers_not_restored");
    tree.dispose();
  }
}

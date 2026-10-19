import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { cloudEnginePrivilegeStatus } from "./cloud-engine-privilege.mjs";
import { startCloudRunnerRuntime, type CloudRunnerRuntime } from "../../../apps/desktop/src/engine/agents/containment/cloud-runner-runtime";
import { cloudRunnerManagerEnvironment } from "../../../apps/desktop/src/engine/agents/containment/cloud-runner-manager.mjs";
import { nativeCloudWorkloadIO } from "../../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs";
import { hasCloudBackgroundServers } from "../../../apps/desktop/src/engine/agents/containment/cloud-background-processes";
import type { PreparedBoundary } from "../../../apps/desktop/src/engine/agents/containment/types";
import type { CloudQualificationRuntime } from "./cloud-qualification-runtime";

/** Bounded observation only. On refusal the caller still joins original
 * native retirement; a timer never replaces that positive custody proof. */
function output(stream: Readable | null, line = false): Promise<Buffer> {
  assert(stream);
  const result = new Promise<Buffer>((resolve, reject) => {
    let bytes = Buffer.alloc(0), done = false;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      stream.off("data", data); stream.off("error", fail); stream.off("end", end);
      if (error) reject(error); else resolve(bytes);
    };
    const fail = () => finish(new Error("cloud_runner_qualification_failed"));
    const end = () => line && !bytes.includes(10) ? fail() : finish();
    const data = (chunk: Buffer) => {
      if (bytes.length + chunk.length > 8192) { fail(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (line && bytes.includes(10)) finish();
    };
    const timer = setTimeout(fail, 15_000); timer.unref();
    stream.on("data", data); stream.once("error", fail); stream.once("end", end);
    if (stream.destroyed || stream.readableEnded) fail();
  });
  void result.catch(() => {});
  return result;
}

function privilegedIdentity(pid: number): void {
  const privilege = cloudEnginePrivilegeStatus(readFileSync(`/proc/${pid}/status`, "utf8"));
  assert.equal(privilege.noNewPrivs, 1); assert.equal(privilege.seccompMode, 2);
  assert(Object.values(privilege.capabilities).every(value => value === 0));
  for (const name of ["mnt", "pid", "user", "net", "cgroup"])
    assert.equal(readlinkSync(`/proc/${pid}/ns/${name}`), readlinkSync(`/proc/self/ns/${name}`));
}

/** Runs only inside the installed original qualification controller. No model,
 * real provider account, CP grant or external network is used. The root
 * launcher still independently drains and proves the complete Host tree. */
export async function qualifyCloudRunners(context: CloudQualificationRuntime) {
  const runtime = resolveCloudRuntime(), { custody, boundary, workloads } = context;
  const scope = { organizationId: randomUUID(), workspaceId: randomUUID(), generation: 1,
    engineInstanceId: randomUUID(), bootId: randomUUID(), writerEpoch: randomUUID(), runtimeId: runtime.runtimeId };
  let live = true, failed = false, owner: CloudRunnerRuntime | null = null;
  const signal = AbortSignal.timeout(60_000);
  const current = () => { assert(live && !failed && !signal.aborted); custody.assertLive(); };
  const prepared: PreparedBoundary[] = [];
  const scratch = await mkdtemp("/tmp/zeros-runner-qualification-");
  const secret = `synthetic-runner-${randomUUID()}`;
  const workspace = "/srv/zeros/workspace";
  const prepare = async () => {
    current();
    const workload = await boundary.prepare({ executionId: randomUUID(), actor: "agent-code", cwd: workspace, workspaceRoot: workspace });
    prepared.push(workload); current();
    return { workload, runner: owner!.boundary(workload, current) };
  };
  const request = (code: string) => ({ command: runtime.node, args: ["-e", code], cwd: workspace,
    env: { PATH: `${runtime.binRoot}:/usr/bin:/bin`, HOME: "/tmp", CURSOR_API_KEY: secret }, stdio: "pipe" as const });
  const identityCode = `
    const fs=require('node:fs'), __name=target=>target;
    const privilege=(${cloudEnginePrivilegeStatus.toString()})(fs.readFileSync('/proc/self/status','utf8'));
    if([process.getuid(),process.geteuid(),process.getgid(),process.getegid()].some(value=>value!==10003)||
      privilege.noNewPrivs!==1||privilege.seccompMode!==2||Object.values(privilege.capabilities).some(value=>value!==0)||
      process.env.CURSOR_API_KEY!==${JSON.stringify(secret)}||
      !fs.readFileSync('/proc/self/cgroup','utf8').startsWith(${JSON.stringify(`0::${custody.entry.workload.directory.slice("/sys/fs/cgroup".length)}/runner-${scope.bootId}/`)}))process.exit(91);
  `;
  try {
    owner = await startCloudRunnerRuntime({ boundary, negotiated: true, scope, assertCurrent: current, failed: () => { failed = true; } });
    assert(owner); current();
    const manager = owner.inspect();
    privilegedIdentity(manager.manager.pid);
    const env = Object.fromEntries(readFileSync(`/proc/${manager.manager.pid}/environ`, "utf8").split("\0").filter(Boolean).map(entry => {
      const index = entry.indexOf("="); return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    assert.match(env.XDG_RUNTIME_DIR!, /^\/tmp\/zeros-runners-[A-Za-z0-9]{6}$/);
    assert.deepEqual(env, cloudRunnerManagerEnvironment(env.XDG_RUNTIME_DIR!));
    const socket = lstatSync(`${env.XDG_RUNTIME_DIR}/systemd/private`);
    assert(socket.isSocket() && socket.uid === 10003 && !(socket.mode & 0o077));

    // EOF and the transport's exit must both complete while systemd retains
    // only metadata, not the provider's anonymous stdio descriptors.
    const first = await prepare(), input = Buffer.from([0, 255, 10, 123, 125]);
    const echo = await first.runner.spawn(() => request(identityCode + `
      let chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
      process.stdin.on('end',()=>{const value=Buffer.concat(chunks);if(value.toString('hex')!==${JSON.stringify(input.toString("hex"))})process.exit(92);
        process.stdout.write(value);process.stderr.write('runner-stdio-qualified');});`));
    const stdout = output(echo.stdout), stderr = output(echo.stderr);
    echo.stdin!.end(input);
    const [exit, bytes, errors] = await Promise.all([echo.wait(), stdout, stderr]);
    assert.deepEqual(exit, { code: 0, signal: null }); assert.deepEqual(bytes, input);
    assert.equal(errors.toString(), "runner-stdio-qualified");
    assert.equal(first.runner.originalGroups().length, 0);
    await first.workload.stopAndProve(); current();

    // A grandchild creates its own session, loses its immediate parent and
    // ignores TERM. It must remain visible in the original unit's census.
    const marker = `${scratch}/progress`;
    const descendantCode = `const fs=require('node:fs'),net=require('node:net');let value=0;
      process.on('SIGTERM',()=>{});setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},String(++value)),20);
      net.createServer().listen(0,'127.0.0.1',()=>process.send({pid:process.pid}));`;
    const intermediateCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],
      {detached:true,stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',message=>{child.disconnect();child.unref();process.send(message,()=>process.disconnect());});`;
    const second = await prepare();
    const provider = await second.runner.spawn(() => request(identityCode + `
      const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(intermediateCode)}],{stdio:['ignore','ignore','ignore','ipc']});
      let descendant;child.once('message',message=>{descendant=message.pid;});child.once('close',code=>{
        if(code!==0||!descendant)process.exit(93);process.stdout.write(JSON.stringify({provider:process.pid,descendant})+'\\n');});
      process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`));
    provider.stderr?.resume();
    const hello = JSON.parse((await output(provider.stdout, true)).toString());
    for (let count = 0; count < 200 && second.runner.snapshot().pendingLaunches; count++) { current(); await delay(25); }
    assert.equal(second.runner.snapshot().pendingLaunches, 0);
    const proof = second.runner.originalProofs()[0]; assert(proof);
    for (const pid of [hello.provider, hello.descendant]) {
      assert(Number.isSafeInteger(pid) && pid > 1);
      const observed = nativeCloudWorkloadIO.process(pid); assert(observed);
      assert.equal(observed.directory, proof.cgroup.directory); assert.equal(observed.uid, 10003);
      privilegedIdentity(pid);
    }
    const descendant = nativeCloudWorkloadIO.process(hello.descendant)!;
    assert.notEqual(descendant.parent, hello.provider);
    for (const pid of [manager.manager.pid, proof.pid, provider.child!.pid!])
      for (const file of ["cmdline", "environ"])
        assert(!readFileSync(`/proc/${pid}/${file}`, "utf8").includes(secret));
    const roots = second.runner.backgroundRoots();
    assert(roots.some(member => member.pid === hello.descendant));
    assert(await hasCloudBackgroundServers(roots.map(member => member.pid)));
    const census = await workloads.inspect();
    assert(census.complete && census.workloadPids.includes(hello.descendant));
    assert(census.infrastructurePids.includes(manager.manager.pid));
    assert(!census.infrastructurePids.includes(hello.descendant));
    for (let count = 0; count < 100; count++) {
      try { if ((await readFile(marker)).length) break; } catch { /* wait for the synthetic writer */ }
      current(); await delay(20);
    }
    assert((await readFile(marker)).length);
    live = false;
    assert.throws(() => second.runner.wrapSpawn(() => request("process.exit(94)")));
    await second.workload.stopAndProve();
    assert.notEqual(nativeCloudWorkloadIO.process(descendant.pid)?.startToken, descendant.startToken);
    const stopped = await readFile(marker, "utf8"); await delay(60);
    assert.equal(await readFile(marker, "utf8"), stopped);
    await owner.stop();
    assert.notEqual(nativeCloudWorkloadIO.process(manager.manager.pid)?.startToken, manager.manager.startToken);
    const final = await workloads.inspect();
    assert(final.complete && !final.pendingLaunches && !final.failedRetirements && !final.workloadPids.length);
    assert(!failed); custody.assertLive();
    return { version: 1, managerIdentity: true, privateMaterial: true, stdio: true, originalRetirement: true,
      descendantsRetired: true, census: true, revocation: true, managerRetired: true };
  } finally {
    live = false;
    // Never erase receipts after unknown custody; the outer root drain owns
    // failure cleanup and cannot report this role as qualified.
    for (const workload of prepared) await workload.stopAndProve();
    await owner?.stop();
    await rm(scratch, { recursive: true, force: true });
  }
}

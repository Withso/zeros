import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const cases = ["preparation", "finally", "result"].flatMap(stage => [
  { stage, phase: "pending", retirement: "unknown" },
  { stage, phase: "refused", retirement: "unknown" },
  { stage, phase: "pending", retirement: "confirmed" },
]);

// Real monitor processes and inherited kernel flocks; only guest/cgroup IO is
// injected. The pending-preparation and refused controls retain the review red.
it.skipIf(process.platform !== "linux").each(cases)(
  "$stage/$phase/$retirement retains original locks through repeated TERM/INT until positive retirement", async ({ stage, phase, retirement }) => {
  const directory = mkdtempSync(path.join(tmpdir(), "zeros-boot-retire-signal-"));
  const files = ["setup", "engine"].map(name => path.join(directory, `${name}.lock`));
  const fds = files.map(file => openSync(file, "wx+", 0o600));
  let child: ReturnType<typeof spawn> | undefined;
  const events: string[] = [], waiters: ((event: string) => void)[] = [];
  const push = (event: string) => { const waiter = waiters.shift(); if (waiter) waiter(event); else events.push(event); };
  const next = () => new Promise<string>((resolve, reject) => {
    if (events.length) return resolve(events.shift()!);
    const timer = setTimeout(() => reject(new Error("fixture event timeout")), 5000);
    waiters.push(event => { clearTimeout(timer); resolve(event); });
  });
  try {
    for (const fd of fds) expect(spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd], timeout: 5000,
    }).status).toBe(0);
    const source = String.raw`
      import {ChildProcess} from 'node:child_process';
      import {PassThrough, Writable} from 'node:stream';
      const {launchCloudEngine} = await import(process.argv[1]);
      const pending = process.argv[2] === 'pending';
      const stage = process.argv[3], confirmed = process.argv[4] === 'confirmed';
      const runtime = JSON.parse(process.argv[5]);
      const wrappers = new Map();
      const say = value => process.stdout.write(value + '\n');
      const attach = (once, name, listener) => {
        const wrapper = (...args) => { listener(...args); say('signal:' + name); };
        wrappers.set(listener, wrapper);
        process[once ? 'once' : 'on'](name, wrapper);
      };
      const signals = {on:(name, listener)=>attach(false,name,listener), once:(name,listener)=>attach(true,name,listener),
        off:(name,listener)=>process.off(name,wrappers.get(listener) ?? listener)};
      const release = pending ? new Promise(resolve=>process.stdin.once('data', resolve)) : Promise.resolve();
      const engine = new ChildProcess(), stdout = new PassThrough();
      Object.assign(engine, {pid:12345, exitCode:null, signalCode:null, stdout, stdin:new PassThrough(),
        kill(){return true}, unref(){}});
      const barrier = new Writable({write(_chunk, _encoding, done){
        if(stage === 'finally') {done(new Error('fixture launch barrier refused')); return}
        done();
        queueMicrotask(()=>{stdout.end(); engine.exitCode=125; engine.emit('exit',125)});
      }});
      Object.assign(engine, {stdio:[null,null,null,barrier]});
      try {
        await launchCloudEngine({operation:'boot-check', bootBudgetMs:5000, source:{},
          runtime, signals, assertOutside(){}, assertBootIdle(){}, publish(){say('published')},
          scope:{prepare(){}, custodySeed(){return {}},
            placement:runtime.cgroupRoot+'/engine-runtime/engine-11111111-1111-4111-8111-111111111111@0:23',
            pinBootRetirement(){return {assertCurrent(){}, async retire(){
              say('retirement-started'); await release;
              if(confirmed) {say('retirement-confirmed'); return {populated:0,pruned:true}}
              throw new Error('unknown original retirement');
            }, close(){}}}},
          prepare(){
            if(stage === 'preparation') throw new Error('fixture view refused');
            return {version:4,runtime,viewDirectory:'/run/zeros/view/runtime-11111111-1111-4111-8111-111111111111',
              releaseView(){say('view-released')}};
          },
          spawnProcess(){queueMicrotask(()=>engine.emit('spawn')); return engine}
        });
        process.exitCode=1;
      } catch {
        process.exitCode=125;
        say(confirmed ? 'launch-refused' : 'custody-retained');
      }
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", source,
      pathToFileURL(path.resolve("scripts/cloud-workspace-validation/sandbox/cloud-engine-launcher.mjs")).href,
      phase, stage, retirement, JSON.stringify(testCloudRuntime())], {
      env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore", "ignore", ...fds],
    });
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => { buffer += chunk; const lines = buffer.split("\n"); buffer = lines.pop()!; for (const line of lines) push(line); });
    child.once("close", (code, signal) => push(`closed:${code}:${signal}`));
    for (const fd of fds.splice(0)) closeSync(fd);
    const contenders = () => files.map(file => spawnSync("/usr/bin/flock", ["--nonblock", "--conflict-exit-code", "73", file, "/usr/bin/true"], { timeout: 5000 }).status);
    expect(await next()).toBe("retirement-started");
    if (phase === "refused") expect(await next()).toBe("custody-retained");
    expect(contenders()).toEqual([73, 73]);
    // Each acknowledgement precedes the next delivery, so Unix signal
    // coalescing cannot turn the repeated-signal case into a single signal.
    const signalAndCheck = async (signal: NodeJS.Signals) => {
      child!.kill(signal);
      expect({ event: await next(), locks: contenders() }).toEqual({ event: `signal:${signal}`, locks: [73, 73] });
    };
    for (const signal of ["SIGTERM", "SIGTERM", "SIGINT", "SIGINT"] as const) await signalAndCheck(signal);
    if (phase === "pending") {
      child.stdin!.end("release");
      if (retirement === "confirmed") {
        expect(await next()).toBe("retirement-confirmed");
        if (stage !== "preparation") expect(await next()).toBe("view-released");
        expect(await next()).toBe("launch-refused");
        expect(await next()).toBe("closed:125:null");
        expect(contenders()).toEqual([0, 0]);
      } else expect(await next()).toBe("custody-retained");
    }
    if (retirement === "unknown") {
      expect(contenders()).toEqual([73, 73]);
      for (const signal of ["SIGINT", "SIGTERM", "SIGTERM"] as const) await signalAndCheck(signal);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child!.once("close", resolve)); child.kill("SIGKILL"); await closed;
    }
    for (const fd of fds) closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

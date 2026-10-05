import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalDevelopment } from "../electron-local.mjs";

const { pidProbe } = vi.hoisted(() => ({ pidProbe: { mode: "normal" } }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: ((...args: Parameters<typeof actual.execFileSync>) => {
      if (
        args[0] === "ps" &&
        Array.isArray(args[1]) &&
        args[1].includes("command=")
      ) {
        if (pidProbe.mode === "failed")
          throw new Error("synthetic exited PID probe");
        if (pidProbe.mode === "empty") return "";
      }
      return actual.execFileSync(...args);
    }) as typeof actual.execFileSync,
  };
});

const roots: string[] = [];
const workers: ChildProcess[] = [];
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-lock-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".context/zeros-local"), { recursive: true });
  return root;
}
const lockPath = (root: string) =>
  path.join(root, ".context/zeros-local/launcher.lock");
afterEach(async () => {
  pidProbe.mode = "normal";
  await Promise.all(
    workers.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 500);
      await exited;
      clearTimeout(timer);
    }),
  );
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("Local launcher lock ownership", () => {
  it("does not release a replacement owner's token", async () => {
    const root = directory(),
      replacement = {
        pid: process.pid,
        slug: "replacement",
        token: "replacement-owner",
      };
    await runLocalDevelopment({
      root,
      platform: "darwin",
      environment: {},
      listProcesses: () => "",
      portProber: async () => true,
      run: async () => {
        fs.writeFileSync(lockPath(root), JSON.stringify(replacement));
        return { code: 1, cancelled: false };
      },
    });
    expect(fs.existsSync(lockPath(root))).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath(root), "utf8"))).toEqual(
      replacement,
    );
  });
  it("recovers a stale owner whose PID now belongs to an unrelated process", async () => {
    const root = directory();
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({ pid: process.pid, slug: "old", token: "old-boot" }),
    );
    let entered = false;
    const code = await runLocalDevelopment({
      root,
      platform: "darwin",
      environment: {},
      listProcesses: () => "",
      portProber: async () => true,
      run: async () => {
        entered = true;
        expect(
          JSON.parse(fs.readFileSync(lockPath(root), "utf8")).token,
        ).not.toBe("old-boot");
        return { code: 1, cancelled: false };
      },
    });
    expect(entered).toBe(true);
    expect(code).toBe(1);
    expect(fs.existsSync(lockPath(root))).toBe(false);
  });
  it.each(["failed", "empty"])(
    "recovers when the PID command probe is %s",
    async (mode) => {
      const root = directory();
      fs.writeFileSync(
        lockPath(root),
        JSON.stringify({
          pid: process.pid,
          slug: "old",
          token: "exited-before-ps",
        }),
      );
      pidProbe.mode = mode;
      let entered = false;
      await expect(
        runLocalDevelopment({
          root,
          platform: "darwin",
          environment: {},
          listProcesses: () => "",
          portProber: async () => true,
          run: async () => {
            entered = true;
            return { code: 1, cancelled: false };
          },
        }),
      ).resolves.toBe(1);
      expect(entered).toBe(true);
      expect(fs.existsSync(lockPath(root))).toBe(false);
    },
  );

  it.each([false, true])(
    "handles a recovery fence (abandoned=%s)",
    async (abandoned) => {
      const root = directory();
      const stale = JSON.stringify({
        pid: 2147483647,
        slug: "old",
        token: "stale-fence-owner",
      });
      fs.writeFileSync(lockPath(root), stale);
      const generation = createHash("sha256").update(stale).digest("hex");
      const fence = path.join(
        root,
        ".context/zeros-local",
        `recovery-${generation}.lock`,
      );
      fs.writeFileSync(fence, "");
      if (abandoned)
        fs.utimesSync(
          fence,
          new Date(Date.now() - 31_000),
          new Date(Date.now() - 31_000),
        );
      let entered = false;
      const launch = runLocalDevelopment({
        root,
        platform: "darwin",
        environment: {},
        listProcesses: () => "",
        portProber: async () => true,
        run: async () => {
          entered = true;
          return { code: 1, cancelled: false };
        },
      });
      if (abandoned) {
        await expect(launch).resolves.toBe(1);
        expect(entered).toBe(true);
        expect(fs.existsSync(fence)).toBe(false);
        expect(fs.existsSync(lockPath(root))).toBe(false);
      } else {
        await expect(launch).rejects.toThrow("recovery is already in progress");
        expect(entered).toBe(false);
        expect(fs.readFileSync(lockPath(root), "utf8")).toBe(stale);
        expect(fs.existsSync(fence)).toBe(true);
      }
    },
  );

  it("serializes concurrent stale recovery and leaves the winner's lock intact", async () => {
    const root = directory();
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({
        pid: 2147483647,
        slug: "stale",
        token: "stale-generation",
      }),
    );
    const file = path.join(root, "worker.mjs");
    fs.writeFileSync(
      file,
      `
import fs from 'node:fs';import path from 'node:path';
const root=process.argv[2],role=process.argv[3],lock=path.join(root,'.context/zeros-local/launcher.lock');
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
const read=fs.readFileSync,unlink=fs.unlinkSync;let inspected=false;
fs.readFileSync=function(file,...args){const value=read.call(fs,file,...args);if(file===lock&&!inspected){inspected=true;fs.writeFileSync(path.join(root,'read-'+role),'ready');const deadline=Date.now()+1500;while((!fs.existsSync(path.join(root,'read-A'))||!fs.existsSync(path.join(root,'read-B')))&&Date.now()<deadline)sleep(10);}return value;};
fs.unlinkSync=function(file){if(file===lock&&role==='B'){const deadline=Date.now()+1000;while(!fs.existsSync(path.join(root,'started-A'))&&Date.now()<deadline)sleep(10);}return unlink.call(fs,file);};
const {runLocalDevelopment}=await import(process.argv[4]);
const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());const keepAlive=setInterval(()=>{},1000);
try{await runLocalDevelopment({root,platform:'darwin',environment:{},listProcesses:()=>'',portProber:async()=>true,signal:controller.signal,
run:async()=>{fs.writeFileSync(path.join(root,'started-'+role),String(process.pid));await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));return{code:0,cancelled:true};}});}
catch{fs.writeFileSync(path.join(root,'declined-'+role),'declined');}finally{clearInterval(keepAlive);}
`,
    );
    for (const role of ["A", "B"]) {
      workers.push(
        spawn(
          process.execPath,
          [file, root, role, path.resolve("scripts/electron-local.mjs")],
          { stdio: "ignore" },
        ),
      );
    }
    await expect
      .poll(
        () =>
          ["A", "B"].filter(
            (role) =>
              fs.existsSync(path.join(root, "started-" + role)) ||
              fs.existsSync(path.join(root, "declined-" + role)),
          ).length,
        { timeout: 5000 },
      )
      .toBe(2);
    const winners = ["A", "B"].filter((role) =>
      fs.existsSync(path.join(root, "started-" + role)),
    );
    expect(winners).toHaveLength(1);
    const owner = JSON.parse(fs.readFileSync(lockPath(root), "utf8"));
    expect(owner.pid).toBe(
      Number(fs.readFileSync(path.join(root, "started-" + winners[0]), "utf8")),
    );
    expect(owner.token).not.toBe("stale-generation");
  });
});

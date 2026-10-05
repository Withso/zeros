import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalDevelopment, runOwnedProcess } from "../electron-local.mjs";

const roots: string[] = [];
const processes: ChildProcess[] = [];
const groups: number[] = [];
const launcherPath = path.resolve("scripts/electron-local.mjs");
const watchdogPath = path.resolve("scripts/electron-local-watchdog.mjs");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function directory() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "zeros-local-process-test-"),
  );
  roots.push(root);
  return root;
}

function alive(pid: number) {
  try {
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function cliFixture(failure?: "stdout" | "exception") {
  const root = directory();
  const marker = path.join(root, "owned.pid");
  const worker = path.join(root, "worker.cjs");
  fs.writeFileSync(
    worker,
    `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "pnpm"),
    `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(worker)}\n`,
    { mode: 0o700 },
  );
  const fail =
    failure === "stdout"
      ? `process.stdout.emit('error',Object.assign(new Error('synthetic EPIPE'),{code:'EPIPE'}));`
      : `throw new Error('synthetic uncaught launcher error');`;
  const bootstrap = `Object.defineProperty(process,'platform',{value:'darwin'});process.argv[1]=${JSON.stringify(launcherPath)};
  ${failure ? `const tick=setInterval(()=>{if(requireFs.existsSync(${JSON.stringify(marker)})){clearInterval(tick);${fail}}},25);` : ""}
  ${failure ? "const requireFs=await import('node:fs');" : ""}
  await import(${JSON.stringify(pathToFileURL(launcherPath).href)});`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", bootstrap],
    {
      cwd: root,
      env: {
        HOME: root,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stdio: "ignore",
    },
  );
  processes.push(child);
  const exited = once(child, "exit");
  await expect.poll(() => fs.existsSync(marker), { timeout: 15000 }).toBe(true);
  const owned = Number(fs.readFileSync(marker, "utf8"));
  groups.push(owned);
  return { root, child, exited, owned };
}

describe("Local process ownership", () => {
  it.each([false, true])(
    "runs steady watchdog ticks without invoking ps (guardian=%s)",
    async (guardian) => {
      const root = directory(),
        trace = path.join(root, "counts.json"),
        preload = path.join(root, "probe.cjs");
      fs.writeFileSync(
        preload,
        `
const fs=require('node:fs'),cp=require('node:child_process'),timers=require('node:timers/promises');
let ps=0,ticks=0;const delay=timers.setTimeout;
cp.execFileSync=(command,args)=>{if(command==='ps'){ps++;return args.includes('stat=')?'S':process.argv[3]+' '+process.argv[3]+' S';}throw new Error('unexpected process probe');};
timers.setTimeout=(...args)=>{ticks++;fs.writeFileSync(process.env.WATCHDOG_TEST_TRACE,JSON.stringify({ps,ticks}));return delay(...args);};
require('node:module').syncBuiltinESMExports();
`,
      );
      const owned = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { detached: true, stdio: "ignore" },
      );
      processes.push(owned);
      groups.push(owned.pid!);
      const watcher = spawn(
        process.execPath,
        [
          "-r",
          preload,
          watchdogPath,
          String(process.pid),
          ...(guardian ? [String(owned.pid)] : []),
        ],
        {
          stdio: "ignore",
          env: { ...process.env, WATCHDOG_TEST_TRACE: trace },
        },
      );
      processes.push(watcher);
      await expect
        .poll(
          () =>
            fs.existsSync(trace)
              ? JSON.parse(fs.readFileSync(trace, "utf8")).ticks
              : 0,
          { timeout: 15000 },
        )
        .toBeGreaterThanOrEqual(3);
      expect(JSON.parse(fs.readFileSync(trace, "utf8")).ps).toBe(0);
    },
    30000,
  );
  it.each(["SIGHUP", "SIGQUIT"] as const)(
    "drains preparation and releases its lock on %s",
    async (signal) => {
      const app = await cliFixture();
      app.child.kill(signal);
      expect(await app.exited).toEqual([0, null]);
      expect(alive(app.owned)).toBe(false);
      expect(
        fs.existsSync(
          path.join(app.root, ".context/zeros-local/launcher.lock"),
        ),
      ).toBe(false);
    },
    30000,
  );

  it.each(["stdout", "exception"] as const)(
    "cleans up after a fatal %s error",
    async (failure) => {
      const app = await cliFixture(failure);
      expect((await app.exited)[0]).toBe(1);
      expect(alive(app.owned)).toBe(false);
      expect(
        fs.existsSync(
          path.join(app.root, ".context/zeros-local/launcher.lock"),
        ),
      ).toBe(false);
    },
    30000,
  );

  it.each([true, false])(
    "escalates until a TERM-ignoring grandchild is gone (abort=%s)",
    async (abort) => {
      const root = directory(),
        marker = path.join(root, "grandchild.pid");
      const controller = new AbortController();
      const grandchild = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
      const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore'});const timer=setInterval(()=>{if(require('fs').existsSync(process.argv[1])){clearInterval(timer);console.log('ready');${abort ? "" : "process.exit(0);"}}},10);setInterval(()=>{},1000);`;
      const result = await runOwnedProcess(
        process.execPath,
        ["-e", parent, marker],
        {
          cwd: root,
          env: process.env,
          signal: controller.signal,
          killGraceMs: 1000,
          output: (text: string) => {
            if (text.includes("ready") && abort) controller.abort();
          },
        },
      );
      const pid = Number(fs.readFileSync(marker, "utf8"));
      groups.push(pid);
      expect(result.code).toBe(0);
      expect(result.cancelled).toBe(abort);
      expect(alive(pid)).toBe(false);
    },
    30000,
  );

  it("releases the launcher lock on spawn failure without a pid", async () => {
    const root = directory();
    await expect(
      runLocalDevelopment({
        root,
        platform: "darwin",
        environment: {},
        listProcesses: () => "",
        run: (_command: string, _args: string[], options: object) =>
          runOwnedProcess(path.join(root, "missing-executable"), [], options),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      fs.existsSync(path.join(root, ".context/zeros-local/launcher.lock")),
    ).toBe(false);
  }, 30000);

  it("waits for group cleanup when forwarding output throws", async () => {
    const root = directory(),
      marker = path.join(root, "owned.pid");
    const pending = runOwnedProcess(
      process.execPath,
      [
        "-e",
        `require('fs').writeFileSync(process.argv[1],String(process.pid));console.log('ready');setInterval(()=>{},1000);`,
        marker,
      ],
      {
        cwd: root,
        env: process.env,
        killGraceMs: 1000,
        output: () => {
          groups.push(Number(fs.readFileSync(marker, "utf8")));
          throw new Error("synthetic output failure");
        },
      },
    );
    await expect(pending).rejects.toThrow("synthetic output failure");
    const pid = Number(fs.readFileSync(marker, "utf8"));
    groups.push(pid);
    expect(alive(pid)).toBe(false);
  }, 30000);

  it("has a watchdog that exits when a SIGKILLed launcher disappears", async () => {
    const parent = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      {
        stdio: "ignore",
      },
      30000,
    );
    processes.push(parent);
    const watcher = spawn(
      process.execPath,
      [watchdogPath, String(parent.pid)],
      { stdio: "ignore" },
    );
    processes.push(watcher);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(watcher.exitCode).toBe(null);
    parent.kill("SIGKILL");
    await expect.poll(() => watcher.exitCode, { timeout: 15000 }).toBe(1);
  }, 30000);

  it("stops owned preparation even when the launcher is SIGKILLed", async () => {
    const app = await cliFixture();
    app.child.kill("SIGKILL");
    await app.exited;
    await expect.poll(() => alive(app.owned), { timeout: 15000 }).toBe(false);
  }, 30000);
});

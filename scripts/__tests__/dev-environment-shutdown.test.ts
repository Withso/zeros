import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentProcesses } from "../dev-environment/processes.mjs";
import { acquireWorkspaceLock, ensureWorkspace, readPrivateJson, saveWorkspace } from "../dev-environment/state.mjs";
import { REBOOT_RECOVERED, recoverLaunchAfterReboot } from "../dev-environment/reboot-recovery.mjs";

const directories: string[] = [];
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "electron-cloud-stop-"));
  directories.push(value); return value;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of directories.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});
function alive(pid: number) {
  const rows = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" });
  return rows.trim().split("\n").some(row => {
    const [id, status] = row.trim().split(/\s+/);
    return Number(id) === pid && !status.startsWith("Z") && status !== "?E";
  });
}
function kill(pid: number | undefined) {
  if (!pid || !alive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function tree(manager: DevelopmentProcesses, exitParent = false) {
  const root = directory(), ready = path.join(root, "ready"), terminate = path.join(root, "terminate");
  // Paths travel as arguments, never spliced into generated code.
  const leaf = `process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], 'seen'));
    process.send('ready'); setInterval(() => {}, 1000);`;
  const child = manager.start("Desktop fixture", process.execPath, ["-e", `
    const [leafCode, terminate, ready, exitParent] = process.argv.slice(1);
    const leaf = require('node:child_process').spawn(process.execPath, ['-e', leafCode, terminate], { stdio: ['ignore','ignore','ignore','ipc'] });
    leaf.once('message', () => {
      require('node:fs').writeFileSync(ready, String(leaf.pid));
      if (exitParent === "exit") process.exit(0);
    });
    setInterval(() => {}, 1000);
  `, leaf, terminate, ready, exitParent ? "exit" : "stay"], {});
  await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
  return { child, leaf: Number(fs.readFileSync(ready, "utf8")), terminate };
}

describe.skipIf(process.platform === "win32")("owned electron:cloud process trees", () => {
  it.each([false, true])("waits for the desktop descendants, including after wrapper exit (%s), and spares a sibling", async exited => {
    const manager = new DevelopmentProcesses({ shutdownGraceMs: 100, killGraceMs: 1000 });
    const siblingManager = new DevelopmentProcesses({ shutdownGraceMs: 100, killGraceMs: 1000 });
    const owned = await tree(manager, exited), sibling = await tree(siblingManager);
    try {
      if (exited) await vi.waitFor(() => expect(owned.child.exitCode).toBe(0));
      await expect(manager.stop()).resolves.toBeUndefined();
      expect(alive(owned.leaf)).toBe(false);
      expect(fs.existsSync(owned.terminate)).toBe(true);
      expect(alive(sibling.child.pid!)).toBe(true); expect(alive(sibling.leaf)).toBe(true);
      expect(() => manager.start("Late desktop", process.execPath, [], {})).toThrow(/cancelled/);
    } finally {
      for (const entry of [owned, sibling]) { kill(entry.child.pid); kill(entry.leaf); }
      await Promise.all([manager.stop().catch(() => {}), siblingManager.stop().catch(() => {})]);
    }
  });

  it("keeps both stop callers and the checkout lock pending until graceful cleanup finishes", async () => {
    const root = directory(), workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
    const release = acquireWorkspaceLock(workspace), manager = new DevelopmentProcesses({ shutdownGraceMs: 2000, killGraceMs: 1000 });
    const ready = path.join(root, "ready"), stopping = path.join(root, "stopping"), allow = path.join(root, "allow"), flushed = path.join(root, "flushed");
    const child = manager.start("Desktop fixture", process.execPath, ["-e", `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {
        fs.writeFileSync(${JSON.stringify(stopping)}, 'seen');
        setInterval(() => { if (fs.existsSync(${JSON.stringify(allow)})) {
          fs.writeFileSync(${JSON.stringify(flushed)}, 'done'); process.exit(0);
        } }, 10);
      });
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);
    `], {});
    let first: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
      first = manager.stop().then(release);
      await vi.waitFor(() => expect(fs.existsSync(stopping)).toBe(true));
      let confirmed = false;
      const second = manager.stop().then(() => { confirmed = true; });
      await Promise.resolve(); await Promise.resolve();
      expect(confirmed).toBe(false);
      expect(() => acquireWorkspaceLock(workspace)).toThrow(/already running/);
      fs.writeFileSync(allow, "continue");
      await Promise.all([first, second]);
      expect(fs.existsSync(flushed)).toBe(true); expect(alive(child.pid!)).toBe(false);
      acquireWorkspaceLock(workspace)();
    } finally {
      fs.writeFileSync(allow, "continue"); kill(child.pid);
      await first; await manager.stop(); release();
    }
  });

  it("fails within a bounded escalation if termination cannot be confirmed", { timeout: 25_000 }, async () => {
    const manager = new DevelopmentProcesses({ shutdownGraceMs: 25, killGraceMs: 25 });
    const owned = await tree(manager);
    const original = process.kill;
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, name) => {
      if ((pid === owned.child.pid || pid === -owned.child.pid!) && name !== 0) return true;
      return original(pid, name);
    });
    try {
      await expect(manager.stop()).rejects.toThrow(/shutdown.*not.*confirmed/i);
      expect(alive(owned.leaf)).toBe(true);
    } finally {
      signal.mockRestore(); kill(owned.child.pid); kill(owned.leaf);
      await manager.stop().catch(() => {});
    }
  });
});

// Drive the actual launcher boundaries without provisioning a backend or app.
const source = fs.readFileSync(new URL("../dev-environment/launcher.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("launcher.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const callbacks = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
  ["start", "stop", "main"].includes(node.name?.text ?? "")).map(node => node.getText(ast));
expect(callbacks).toHaveLength(3);
function launcher({ boot = "this-boot" } = {}) {
  const root = directory(), workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  workspace.state.launcher = { port: 4242, token: "synthetic-supervisor-token", runId: "prior-run", pid: process.pid, boot };
  saveWorkspace(workspace);
  const fetch = vi.fn(async () => ({ ok: true }));
  const createServer = vi.fn(() => { throw new Error("A second supervisor must not start"); });
  const context = vm.createContext({ fs, path, readPrivateJson, saveWorkspace, acquireWorkspaceLock, DevelopmentProcesses,
    profileIssues: () => [], systemEnvironment: () => ({}), process, AbortController, globalThis: { AbortSignal },
    REBOOT_RECOVERED, currentBoot: () => "this-boot",
    recoverLaunchAfterReboot: (value: typeof workspace) => recoverLaunchAfterReboot(value, { boot: "this-boot" }),
    randomUUID: () => "new-run", createServer, fetch, delay: async () => {}, console: { log: vi.fn(), warn: vi.fn() } });
  vm.runInContext(callbacks.join("\n") + "\nglobalThis.callbacks = {start, stop, main};", context);
  return { workspace, fetch, createServer, context,
    callbacks: context.globalThis.callbacks as { start: (w: typeof workspace, p: object) => Promise<void>; stop: (w: typeof workspace) => Promise<void>; main: () => Promise<void> } };
}
describe("electron:cloud launcher shutdown proof", () => {
  it("refuses to replace a previous launch receipt even if its process lock was lost", async () => {
    const h = launcher(), previous = structuredClone(h.workspace.state.launcher);
    await expect(h.callbacks.start(h.workspace, {})).rejects.toThrow(/previous.*shutdown|previous.*launch/i);
    expect(h.createServer).not.toHaveBeenCalled();
    expect(readPrivateJson(h.workspace.file).launcher).toEqual(previous);
  });
  it("does not accept a missing lock as proof while the supervisor receipt remains", async () => {
    const h = launcher();
    await expect(h.callbacks.stop(h.workspace)).rejects.toThrow(/shutdown.*not.*confirmed/i);
    expect(readPrivateJson(h.workspace.file).launcher).toBeDefined();
  });
  it("does not claim shutdown during the gap before the supervisor publishes its receipt", async () => {
    const h = launcher(); delete h.workspace.state.launcher; saveWorkspace(h.workspace);
    const release = acquireWorkspaceLock(h.workspace);
    try {
      await expect(h.callbacks.stop(h.workspace)).rejects.toThrow(/shutdown.*not.*confirmed/i);
      expect(h.fetch).not.toHaveBeenCalled();
    } finally { release(); }
  });
  it("refuses a different instance's cleared receipt without reporting shutdown", async () => {
    const h = launcher();
    h.fetch.mockImplementation(async () => {
      delete h.workspace.state.launcher; saveWorkspace(h.workspace);
      const changed = readPrivateJson(h.workspace.file); changed.instanceId = "33333333-3333-4333-8333-333333333333";
      fs.writeFileSync(h.workspace.file, JSON.stringify(changed)); return { ok: true };
    });
    await expect(h.callbacks.stop(h.workspace)).rejects.toThrow(/shutdown.*not.*confirmed/i);
    expect(h.context.console.log).not.toHaveBeenCalled();
  });
  it("reports shutdown only after the supervisor clears its confirmed receipt", async () => {
    const h = launcher();
    h.fetch.mockImplementation(async () => { delete h.workspace.state.launcher; saveWorkspace(h.workspace); return { ok: true }; });
    const prior = structuredClone(h.workspace);
    await h.callbacks.stop(prior);
    expect(h.context.console.log).toHaveBeenCalledWith(expect.stringMatching(/desktop.*stopped/i));
  });
  it("clears a launch from an earlier boot on stop and start, instead of waiting on its dead supervisor", async () => {
    const stopped = launcher({ boot: "earlier-boot" });
    stopped.fetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await stopped.callbacks.stop(stopped.workspace);
    expect(stopped.context.console.log).toHaveBeenCalledWith(REBOOT_RECOVERED);
    expect(readPrivateJson(stopped.workspace.file).launcher).toBeUndefined();
    const started = launcher({ boot: "earlier-boot" });
    await expect(started.callbacks.start(started.workspace, {})).rejects.toThrow("A second supervisor must not start");
    expect(started.context.console.log).toHaveBeenCalledWith(REBOOT_RECOVERED);
  });
  it("keeps an unreachable supervisor from this boot unconfirmed", async () => {
    const h = launcher();
    h.fetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(h.callbacks.stop(h.workspace)).rejects.toThrow(/supervisor is unavailable/i);
    expect(readPrivateJson(h.workspace.file).launcher).toMatchObject({ boot: "this-boot" });
  });
  it("reset never starts drain or removes data after an unconfirmed desktop stop", async () => {
    const h = launcher(), ensure = vi.fn(() => h.workspace), lock = vi.fn(() => () => {});
    Object.assign(h.context, { action: "archive", root: "/unused", ensureWorkspace: ensure, loadProfile: () => ({}),
      confirmReset: async () => {}, acquireWorkspaceLock: lock });
    // main calls the same real stop() boundary, which sees the retained receipt.
    const error = await h.callbacks.main().catch(error => error);
    expect(ensure).toHaveBeenCalledOnce(); expect(lock).not.toHaveBeenCalled();
    expect(error.message).toMatch(/shutdown.*not.*confirmed/i);
    expect(readPrivateJson(h.workspace.file).status).toBe("active");
  });
});

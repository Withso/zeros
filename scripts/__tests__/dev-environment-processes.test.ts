import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { run } from "../dev-environment/processes.mjs";

it("rejects truncated provider inventories instead of returning false absence", async () => {
  await expect(run(process.execPath, ["-e", "process.stdout.write('x'.repeat(256 * 1024))"], { label: "Inventory" })).rejects.toThrow(/Inventory.*failed/);
});
it("withholds private stdout and stderr on a failed operator command", async () => {
  const error = await run(process.execPath, ["-e", "console.log('private-output');console.error('private-error');process.exit(1)"], { label: "Operator" }).catch(error => error);
  expect(error.message).toBe("Operator failed; credentials and captured output were withheld.");
});

it("honors the deadline when a descendant retains the command's output pipe", async () => {
  const started = Date.now();
  const error = await run(process.execPath, ["-e", `
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 1, 2] }).unref();
  `], { timeout: 100, label: "Dev dispatch" }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(1000);
});

it("cancels after the parent exits even if its descendant still holds stdout", async () => {
  const controller = new AbortController(), reason = new Error("cancelled by archive"), started = Date.now();
  const timer = setTimeout(() => controller.abort(reason), 100);
  try {
    const result = await run(process.execPath, ["-e", `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 1, 2] }).unref();
    `], { timeout: 3000, signal: controller.signal }).catch(error => error);
    expect(result).toBe(reason);
    expect(Date.now() - started).toBeLessThan(1000);
  } finally { clearTimeout(timer); }
});

it("allows the normal Dev shutdown handler to flush state on cancellation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-shutdown-"));
  const ready = path.join(directory, "ready"), flushed = path.join(directory, "flushed");
  const controller = new AbortController();
  const result = run(process.execPath, ["-e", `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(flushed)}, 'flushed'); process.exit(0); }, 50));
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);
  `], { signal: controller.signal, timeout: 5000 }).catch(error => error);
  try {
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
    controller.abort(new Error("Dev stopped"));
    await expect(result).resolves.toBe(controller.signal.reason);
    await vi.waitFor(() => expect(fs.existsSync(flushed)).toBe(true));
  } finally { controller.abort(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("keeps ownership through delayed shutdown and escalates an ignoring descendant", async () => {
  const { acquireWorkspaceLock } = await import("../dev-environment/state.mjs");
  const { cleanupHostedLocalState } = await import("../dev-environment/hosted-local.mjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-owned-shutdown-"));
  const state = { owner: "a".repeat(24), generation: "11111111-1111-4111-8111-111111111111" };
  const ready = path.join(directory, "ready"), flushed = path.join(directory, "flushed");
  const release = acquireWorkspaceLock({ directory, state });
  const controller = new AbortController();
  let finished = false;
  const result = run(process.execPath, ["-e", `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => { fs.writeFileSync(${JSON.stringify(flushed)}, 'done'); process.exit(0); }, 250));
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);
  `], { signal: controller.signal, timeout: 5000, shutdownGraceMs: 1000 }).catch(error => error)
    .finally(() => { finished = true; release(); });
  try {
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
    controller.abort(new Error("stopped"));
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(finished).toBe(false);
    expect(cleanupHostedLocalState(directory, state)).toBe(false);
    expect(() => acquireWorkspaceLock({ directory, state })).toThrow(/already running/);
    await result;
    expect(fs.existsSync(flushed)).toBe(true);
    expect(() => process.kill(Number(fs.readFileSync(ready, "utf8")), 0)).toThrow();
    expect(cleanupHostedLocalState(directory, state)).toBe(true);
  } finally { controller.abort(); await result; release(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it("waits for a stubborn owned process tree after escalation without waiting for inherited pipes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-tree-shutdown-")), ready = path.join(directory, "ready");
  const controller = new AbortController();
  const result = run(process.execPath, ["-e", `
    process.on('SIGTERM', () => {});
    const child = require('node:child_process').spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(child.pid)), 100);
    setInterval(() => {}, 1000);
  `], { signal: controller.signal, timeout: 3000, shutdownGraceMs: 100 }).catch(error => error);
  try {
    await vi.waitFor(() => expect(fs.existsSync(ready)).toBe(true));
    controller.abort(new Error("stopped")); await result;
    const pid = Number(fs.readFileSync(ready, "utf8"));
    // A dead orphan may remain as a zombie until the container init reaps it.
    if (process.platform === "linux" && fs.existsSync(`/proc/${pid}/stat`)) expect(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0]).toBe("Z");
    else expect(() => process.kill(pid, 0)).toThrow();
  } finally { controller.abort(); await result; fs.rmSync(directory, { recursive: true, force: true }); }
});

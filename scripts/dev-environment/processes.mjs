import fs from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { groupAlive, signalGroup } from "../electron-local-process-group.mjs";

/** Commands receive explicit environments. Diagnostics never echo argv, env,
 * SQL input or captured provider/driver output, which can contain credentials. */
export function run(command, args, { cwd, env, input, inherit = false, label = "Development command", timeout = 120_000, signal, shutdownGraceMs = 20_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // A dedicated process group lets cancellation include grandchildren even
    // after the command parent exits. Never signal the caller's process group.
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: [input === undefined ? "ignore" : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    const terminated = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    const output = [];
    let size = 0, settled = false, stopping = false;
    const send = signalName => {
      if (!child.pid) return;
      try { if (grouped) process.kill(-child.pid, signalName); else child.kill(signalName); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const alive = () => {
      if (!child.pid) return false;
      if (!grouped) return child.exitCode === null && child.signalCode === null;
      try {
        // Ignore dead zombies awaiting the container's init; they cannot touch
        // files. Read only pid/group/status, never command lines or environment.
        const rows = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2000 });
        return rows.trim().split("\n").some(row => {
          const [, group, status] = row.trim().split(/\s+/);
          return Number(group) === child.pid && !status?.startsWith("Z");
        });
      } catch {
        try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
      }
    };
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (error) reject(error); else resolve(Buffer.concat(output).toString("utf8").trim());
    };
    const stop = async (error, immediate = false) => {
      if (settled || stopping) return;
      stopping = true; clearTimeout(timer);
      // Pipes may be inherited by unrelated detached descendants. Completion
      // follows owned process termination, never pipe EOF alone.
      send(immediate ? "SIGKILL" : "SIGTERM");
      const deadline = Date.now() + (immediate ? 0 : shutdownGraceMs);
      while (alive() && Date.now() < deadline) await delay(25);
      if (alive()) send("SIGKILL");
      while (alive()) await delay(25);
      // Reap the direct child as well as observing the group. It can briefly
      // be a zombie before Node receives SIGCHLD, especially under load.
      await terminated;
      finish(error);
    };
    const failure = kind => new Error(`${label} ${kind}; credentials and captured output were withheld.`);
    const abort = () => { void stop(signal.reason); };
    const timer = setTimeout(() => { void stop(failure("timed out"), true); }, timeout);
    child.once("error", () => { void stop(failure("failed"), true); });
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", chunk => {
      size += chunk.length;
      if (size <= 128 * 1024) output.push(chunk);
      else void stop(failure("failed"), true);
    });
    child.stderr?.resume();
    child.once("close", code => {
      if (stopping) return;
      if (code !== 0) { void stop(Object.assign(failure("failed"), { exitCode: code })); return; }
      void (async () => {
        while (!settled && !stopping && alive()) await delay(25);
        if (!settled && !stopping) finish();
      })();
      // A surviving owned descendant remains subject to cancellation/deadline.
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    if (signal?.aborted) abort();
  });
}

export async function withDevPortRetry(launch, { attempts = 3, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    try { return await launch(attempt); }
    catch (error) { if (error?.exitCode !== 98 || attempt + 1 === attempts) throw error; }
  }
}

export async function waitForHttp(url, { signal, timeout = 60_000, headers = {}, accept = response => response.ok, label = "Development service" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { redirect: "manual", headers,
        signal: signal ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(3000)]) : globalThis.AbortSignal.timeout(3000) });
      const ready = await accept(response); await response.body?.cancel().catch(() => {});
      if (ready) return;
    } catch { signal?.throwIfAborted(); }
    await delay(250, undefined, { signal });
  }
  throw new Error(`${label} did not become ready before the deadline`);
}

export function waitForDevSignIn(profile, options = {}) {
  return waitForHttp(`${profile.appOrigin}/auth/start`, { label: "Desktop sign-in through the tunnel", ...options, accept: response => {
    if (response.status !== 303) return false;
    const redirect = new URL(response.headers.get("location") ?? "");
    return redirect.origin === "https://api.workos.com" && redirect.searchParams.get("client_id") === profile.webClientId &&
      redirect.searchParams.get("redirect_uri") === `${profile.appOrigin}/auth/callback`;
  } });
}

/** Own each service's process group, including descendants whose wrapper has
 * exited. An unexpected exit aborts readiness; it never proves tree cleanup. */
export class DevelopmentProcesses {
  children = new Set();
  controller = new AbortController();
  stopping = false;
  stopPromise;
  grouped = process.platform !== "win32";
  constructor({ shutdownGraceMs = 20_000, killGraceMs = 5000 } = {}) {
    this.shutdownGraceMs = shutdownGraceMs;
    this.killGraceMs = killGraceMs;
  }
  start(label, command, args, { logFile, ...options } = {}) {
    if (this.stopping) throw new Error("Development launch was cancelled");
    // A service's own output stays in a private log; the previous run's is kept once.
    let log;
    if (logFile) {
      if (fs.existsSync(logFile)) fs.renameSync(logFile, logFile.replace(/\.log$/, ".previous.log"));
      log = fs.openSync(logFile, "a", 0o600);
    }
    let child;
    try { child = spawn(command, args, { ...options, detached: this.grouped,
      stdio: log === undefined ? options.stdio ?? "ignore" : ["ignore", log, log] }); }
    finally { if (log !== undefined) fs.closeSync(log); }
    this.children.add(child);
    child.once("error", () => this.controller.abort(new Error(`${label} could not start`)));
    child.once("exit", () => {
      if (!this.stopping) this.controller.abort(new Error(`${label} exited; restart Zeros Dev`));
    });
    return child;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      const pending = () => {
        for (const child of this.children) {
          const running = child.pid && ((child.exitCode === null && child.signalCode === null) ||
            this.grouped && groupAlive(child.pid));
          // Once confirmed gone, never signal this PID again on a later stop.
          if (!running) this.children.delete(child);
        }
        return this.children.size > 0;
      };
      const signal = name => {
        for (const child of this.children) {
          if (this.grouped) signalGroup(child.pid, name);
          else child.kill(name);
        }
      };
      const wait = async grace => {
        const deadline = performance.now() + grace;
        while (pending() && performance.now() < deadline) await delay(50);
      };
      if (!pending()) return;
      signal("SIGTERM"); await wait(this.shutdownGraceMs);
      if (pending()) { signal("SIGKILL"); await wait(this.killGraceMs); }
      if (pending()) throw new Error("Development shutdown could not be confirmed; process ownership and existing state were preserved");
    })();
    return this.stopPromise;
  }
}

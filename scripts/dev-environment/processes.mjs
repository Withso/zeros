import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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

export async function waitForHttp(url, { signal, timeout = 60_000, headers = {}, accept = response => response.ok } = {}) {
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
  throw new Error("Development service did not become ready before the deadline");
}

export function waitForDevSignIn(profile, options = {}) {
  return waitForHttp(`${profile.appOrigin}/auth/start`, { ...options, accept: response => {
    if (response.status !== 303) return false;
    const redirect = new URL(response.headers.get("location") ?? "");
    return redirect.origin === "https://api.workos.com" && redirect.searchParams.get("client_id") === profile.webClientId &&
      redirect.searchParams.get("redirect_uri") === `${profile.appOrigin}/auth/callback`;
  } });
}

/** Every service stays in the launcher's process group. An unexpected service
 * exit aborts readiness and tears down the stack; no stale API is accepted. */
export class DevelopmentProcesses {
  children = new Set();
  controller = new AbortController();
  stopping = false;
  start(label, command, args, options) {
    if (this.stopping) throw new Error("Development launch was cancelled");
    const child = spawn(command, args, { ...options, stdio: options.stdio ?? "ignore" });
    this.children.add(child);
    child.once("error", () => this.controller.abort(new Error(`${label} could not start`)));
    child.once("exit", () => {
      this.children.delete(child);
      if (!this.stopping) this.controller.abort(new Error(`${label} exited; restart Zeros Dev`));
    });
    return child;
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const child of this.children) child.kill("SIGTERM");
    const deadline = Date.now() + 20_000;
    while (this.children.size && Date.now() < deadline) await delay(100);
    for (const child of this.children) child.kill("SIGKILL");
  }
}

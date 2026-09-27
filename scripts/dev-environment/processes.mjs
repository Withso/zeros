import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

/** Commands receive explicit environments. Diagnostics never echo argv, env,
 * SQL input or captured provider/driver output, which can contain credentials. */
export function run(command, args, { cwd, env, input, inherit = false, label = "Development command", timeout = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, signal, stdio: [input === undefined ? "ignore" : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    let output = "", size = 0, expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, timeout);
    const fail = () => { clearTimeout(timer); reject(signal?.aborted ? signal.reason : new Error(`${label} ${expired ? "timed out" : "failed"}; credentials and captured output were withheld.`)); };
    child.once("error", fail);
    child.stdout?.on("data", chunk => { size += chunk.length; if (size <= 128 * 1024) output += chunk; });
    child.stderr?.resume();
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : fail(); });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export async function waitForHttp(url, { signal, timeout = 60_000, headers = {}, accept = response => response.ok } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(url, { redirect: "manual", headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
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

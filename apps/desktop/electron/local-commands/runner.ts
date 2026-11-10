import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { LocalCommandMacResult } from "@zeros/protocol/local-commands";

const STREAM_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;
const FALLBACK_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];

/** The account's login shell when /etc/shells lists it, else a stock shell. */
export async function resolveLoginShell(options: { shell?: string; shellsFile?: string; exists?: (path: string) => boolean } = {}): Promise<string> {
  const shell = options.shell ?? (() => { try { return userInfo().shell ?? undefined; } catch { return undefined; } })();
  const exists = options.exists ?? existsSync;
  const listed = await readFile(options.shellsFile ?? "/etc/shells", "utf8").then(text => new Set(text.split("\n").map(line => line.trim()).filter(line => line.startsWith("/"))), () => new Set<string>());
  if (shell && isAbsolute(shell) && listed.has(shell) && exists(shell)) return shell;
  return FALLBACK_SHELLS.find(candidate => exists(candidate)) ?? "/bin/sh";
}

/** The app's own environment (its login PATH and HOME included) without Zeros
 * and Electron internals or loader injection. The shared user-variable rules
 * do not apply here: they also forbid PATH and HOME, which this shell needs. */
export function localCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source))
    if (value !== undefined && !/^(ZEROS_|ELECTRON_|DYLD_)/i.test(name) && !["NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(name)) env[name] = value;
  return env;
}

async function directory(home: string, cwd: string | undefined): Promise<string | undefined> {
  const path = cwd === undefined ? home : cwd === "~" ? home : cwd.startsWith("~/") ? join(home, cwd.slice(2)) : resolve(home, cwd);
  try { const real = await realpath(path); return (await stat(real)).isDirectory() ? real : undefined; }
  catch { return undefined; }
}

export interface LocalCommandRun { command: string; cwd?: string; timeoutMs: number }
export interface LocalCommandRunOptions { signal?: AbortSignal; shell?: string; home?: string; env?: NodeJS.ProcessEnv; streamBytes?: number }

/** One approved command in the person's login shell. Only `command` is
 * interpreted, by their shell; cwd is a path. Output stays in memory, capped
 * per stream, and is never logged. */
export async function runLocalCommand(request: LocalCommandRun, options: LocalCommandRunOptions = {}): Promise<LocalCommandMacResult> {
  const home = options.home ?? homedir();
  const cwd = await directory(home, request.cwd);
  if (!cwd) return { outcome: "failed", error: "cwd_not_found" };
  if (options.signal?.aborted) return { outcome: "cancelled" };
  const shell = options.shell ?? await resolveLoginShell();
  const limit = options.streamBytes ?? STREAM_BYTES;
  return new Promise(settle => {
    const child = spawn(shell, ["-l", "-c", request.command], { cwd, env: localCommandEnvironment(options.env ?? process.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const streams = { stdout: { text: "", bytes: 0, cut: false, decoder: new StringDecoder("utf8") }, stderr: { text: "", bytes: 0, cut: false, decoder: new StringDecoder("utf8") } };
    const take = (name: keyof typeof streams) => (chunk: Buffer) => {
      const stream = streams[name];
      if (stream.bytes >= limit) { stream.cut = true; return; }
      const part = chunk.subarray(0, limit - stream.bytes);
      if (part.length < chunk.length) stream.cut = true;
      stream.bytes += part.length; stream.text += stream.decoder.write(part);
    };
    child.stdout!.on("data", take("stdout")); child.stderr!.on("data", take("stderr"));
    let ended: "command_timed_out" | "cancelled" | undefined, killer: ReturnType<typeof setTimeout> | undefined, closed = false;
    // The command runs as its own process group; ending it ends its children too.
    // Gate on close, not the shell's exit: a background job holding stdout keeps the command open.
    const end = (reason: "command_timed_out" | "cancelled") => {
      if (ended || closed) return;
      ended = reason;
      const group = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* Already gone. */ } };
      group("SIGTERM");
      killer = setTimeout(() => group("SIGKILL"), KILL_GRACE_MS); killer.unref();
    };
    const timer = setTimeout(() => end("command_timed_out"), request.timeoutMs);
    const abort = () => end("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: LocalCommandMacResult) => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      settle(result);
    };
    child.once("error", () => finish({ outcome: "failed", error: "spawn_failed", cwd }));
    child.once("close", code => {
      closed = true;
      // Reap anything the shell left in its group before reporting.
      if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch { /* None left. */ }
      if (killer) clearTimeout(killer);
      const stdout = streams.stdout.text + streams.stdout.decoder.end(), stderr = streams.stderr.text + streams.stderr.decoder.end();
      finish({ outcome: ended ?? "completed", code: ended ? null : code, cwd, stdout, stderr,
        stdoutTruncated: streams.stdout.cut, stderrTruncated: streams.stderr.cut, ...(ended === "command_timed_out" ? { timedOut: true } : {}) });
    });
  });
}

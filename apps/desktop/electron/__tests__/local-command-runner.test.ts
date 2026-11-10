import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localCommandEnvironment, resolveLoginShell, runLocalCommand } from "../local-commands/runner";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function home() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-command-home-"))); directories.push(directory);
  await mkdir(join(directory, "src", "app"), { recursive: true });
  return directory;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform === "win32")("local command runner", () => {
  it("runs in the login shell from home by default, resolving relative and ~ paths from home", async () => {
    const h = await home(), options = { shell: "/bin/sh", home: h, env: { PATH: process.env.PATH } };
    expect(await runLocalCommand({ command: "pwd; echo out; echo err >&2; exit 3", timeoutMs: 10_000 }, options))
      .toEqual({ outcome: "completed", code: 3, cwd: h, stdout: `${h}\nout\n`, stderr: "err\n", stdoutTruncated: false, stderrTruncated: false });
    expect((await runLocalCommand({ command: "pwd", cwd: "src/app", timeoutMs: 10_000 }, options)).stdout).toBe(`${join(h, "src", "app")}\n`);
    expect((await runLocalCommand({ command: "pwd", cwd: "~/src", timeoutMs: 10_000 }, options)).stdout).toBe(`${join(h, "src")}\n`);
    const missing = await runLocalCommand({ command: "touch ran", cwd: "nope", timeoutMs: 10_000 }, options);
    expect(missing).toEqual({ outcome: "failed", error: "cwd_not_found" });
    expect(await runLocalCommand({ command: "true", timeoutMs: 10_000 }, { ...options, shell: join(h, "no-such-shell") })).toMatchObject({ outcome: "failed", error: "spawn_failed" });
    await expect(readFile(join(h, "ran"))).rejects.toThrow();
  });

  it("interprets only the command: a cwd that looks like shell syntax is a path, never run", async () => {
    const h = await home(), marker = join(h, "pwned");
    const result = await runLocalCommand({ command: "true", cwd: `$(touch ${marker})`, timeoutMs: 10_000 }, { shell: "/bin/sh", home: h, env: {} });
    expect(result).toEqual({ outcome: "failed", error: "cwd_not_found" });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("kills the command's whole process group on timeout and on cancel", async () => {
    const h = await home(), pidFile = join(h, "child.pid");
    const timedOut = await runLocalCommand({ command: `sleep 60 & echo $! > ${pidFile}; wait`, timeoutMs: 500 }, { shell: "/bin/sh", home: h, env: { PATH: process.env.PATH } });
    expect(timedOut).toMatchObject({ outcome: "command_timed_out", timedOut: true });
    const child = Number(await readFile(pidFile, "utf8"));
    await expect.poll(() => alive(child), { timeout: 5_000 }).toBe(false);
    const controller = new AbortController();
    const running = runLocalCommand({ command: `sleep 60 & echo $! > ${pidFile}; wait`, timeoutMs: 60_000 }, { shell: "/bin/sh", home: h, env: { PATH: process.env.PATH }, signal: controller.signal });
    await expect.poll(async () => readFile(pidFile, "utf8").then(Number).catch(() => 0)).not.toBe(child);
    const second = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    expect(await running).toMatchObject({ outcome: "cancelled" });
    await expect.poll(() => alive(second), { timeout: 5_000 }).toBe(false);
  });

  it("is one-shot: a background job does not outlive the shell, and one holding stdout holds the command to its timeout", async () => {
    const h = await home(), pidFile = join(h, "bg.pid"), env = { PATH: process.env.PATH };
    const detached = await runLocalCommand({ command: `sleep 60 >/dev/null 2>&1 & echo $! > ${pidFile}`, timeoutMs: 10_000 }, { shell: "/bin/sh", home: h, env });
    expect(detached).toMatchObject({ outcome: "completed", code: 0 });
    const background = Number(await readFile(pidFile, "utf8"));
    await expect.poll(() => alive(background), { timeout: 5_000 }).toBe(false);
    const holding = await runLocalCommand({ command: `sleep 60 & echo $! > ${pidFile}`, timeoutMs: 500 }, { shell: "/bin/sh", home: h, env });
    expect(holding).toMatchObject({ outcome: "command_timed_out", timedOut: true });
    const holder = Number(await readFile(pidFile, "utf8"));
    await expect.poll(() => alive(holder), { timeout: 5_000 }).toBe(false);
  });

  it("caps each stream at its limit, flags the cut, and never logs output", async () => {
    const h = await home(), log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    const result = await runLocalCommand({ command: "head -c 3000 /dev/zero | tr '\\0' a; echo short >&2", timeoutMs: 10_000 },
      { shell: "/bin/sh", home: h, env: { PATH: process.env.PATH }, streamBytes: 1000 });
    expect(result.stdout).toBe("a".repeat(1000));
    expect(result.stdoutTruncated).toBe(true);
    expect(result).toMatchObject({ stderr: "short\n", stderrTruncated: false });
    for (const spy of [log, warn, error]) expect(JSON.stringify(spy.mock.calls)).not.toContain("aaaa");
  });

  it("never hands Zeros internals or injection variables to the command", () => {
    const env = localCommandEnvironment({ PATH: "/usr/bin", HOME: "/Users/alex", ZEROS_ENGINE_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require x",
      DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", LANG: "en_US.UTF-8" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/alex", LANG: "en_US.UTF-8" });
  });

  it("uses the account's login shell only when /etc/shells lists it", async () => {
    const shells = join(await home(), "shells");
    await writeFile(shells, "# shells\n/bin/zsh\n/bin/bash\n");
    expect(await resolveLoginShell({ shell: "/bin/bash", shellsFile: shells, exists: () => true })).toBe("/bin/bash");
    expect(await resolveLoginShell({ shell: "/tmp/evil", shellsFile: shells, exists: () => true })).toBe("/bin/zsh");
    expect(await resolveLoginShell({ shell: "relative/sh", shellsFile: shells, exists: path => path === "/bin/sh" })).toBe("/bin/sh");
  });
});

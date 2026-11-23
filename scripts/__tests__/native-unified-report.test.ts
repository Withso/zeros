import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { descendants, foreignSockets, identify, isLauncherCommand, killRun, namesRunFolder, parseProcessTable, selectRunProcesses, signalTargets } from "../native-unified/processes.mjs";
import { isLocalUrl, isLoopbackAddress, PERSON_MUST_LOOK, scrub, table } from "../native-unified/report.mjs";
import { electronInstall, worktreeRemoval } from "../native-unified/setup.mjs";

describe("native check: loopback only (N12)", () => {
  it("accepts every loopback spelling and nothing else", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"])
      expect(isLoopbackAddress(address), address).toBe(true);
    for (const address of ["0.0.0.0", "::", "10.0.0.1", "192.168.1.2", "128.0.0.1", "127.0.0.1.example.com", "github.com", "", undefined])
      expect(isLoopbackAddress(address), String(address)).toBe(false);
  });

  it("lets the app load its own servers and local schemes, never a remote host", () => {
    for (const url of ["http://127.0.0.1:5173/src/main.tsx", "ws://localhost:4000/", "data:text/plain,x", "blob:http://127.0.0.1/x", "devtools://devtools/x"])
      expect(isLocalUrl(url), url).toBe(true);
    for (const url of ["https://github.com/", "https://api.github.com/user", "http://0.0.0.0:80/", "https://alpha.example/", "not a url"])
      expect(isLocalUrl(url), url).toBe(false);
  });

  it("fails a socket listening beyond loopback or connected to a remote address", () => {
    const sockets = [
      { pid: 1, state: "LISTEN", local: "127.0.0.1" },
      { pid: 2, state: "LISTEN", local: "0.0.0.0" },
      { pid: 3, state: "ESTABLISHED", local: "127.0.0.1", remote: "127.0.0.1" },
      { pid: 4, state: "ESTABLISHED", local: "10.0.0.2", remote: "140.82.112.3" },
    ];
    expect(foreignSockets(sockets).map(socket => socket.pid)).toEqual([2, 4]);
  });
});

describe("native check: output", () => {
  it("never prints the run's folder or the home folder, nor the synthetic token", () => {
    const text = scrub("/tmp/zeros-native-unified/run/home and /Users/someone/Documents/zeros synthetic-native-check",
      { root: "/tmp/zeros-native-unified", home: "/Users/someone" });
    expect(text).toBe("<tmp>/run/home and ~/Documents/zeros synthetic");
  });

  it("counts passes, failures and checks that do not apply, and clips long facts", () => {
    const { text, failed } = table([
      { check: "N1 settings rail", result: "pass", fact: "x".repeat(500) },
      { check: "N4", result: "fail", fact: "lib HEAD=missing" },
      { check: "N9", result: "n/a", fact: "not in this checkout" },
    ]);
    expect(failed).toBe(1);
    expect(text).toContain("1 passed, 1 failed, 1 not applicable of 3");
    expect(text.split("\n").find(line => line.startsWith("N1 "))!.length).toBeLessThan(450);
  });

  it("names what only a person can confirm", () => {
    expect(PERSON_MUST_LOOK.length).toBeGreaterThanOrEqual(5);
    expect(PERSON_MUST_LOOK.join(" ")).toMatch(/sign-in/i);
  });
});

const T = "Sun Nov 22 17:00:00 2026", LATER = "Sun Nov 22 17:30:00 2026";
const row = (pid: number, ppid: number, pgid: number, command: string, started = T) => ({ pid, ppid, pgid, started, command });

describe("native check: teardown", () => {
  it("reads ps with each process's start time", () => {
    expect(parseProcessTable("  42     1    42 Sun Nov 22 17:00:00 2026 /tmp/run/bin/bun engine\n 7 1 7 Mon Nov  3 09:05:01 2026 sh -c x\n"))
      .toEqual([row(42, 1, 42, "/tmp/run/bin/bun engine"), row(7, 1, 7, "sh -c x", "Mon Nov 3 09:05:01 2026")]);
  });

  it("finds every descendant of the run's roots", () => {
    const table = [row(10, 1, 10, "electron"), row(11, 10, 10, "bun engine"), row(12, 11, 12, "git clone"), row(20, 1, 20, "unrelated")];
    expect(descendants(table, [{ pid: 10, started: T }]).map(entry => entry.pid).sort()).toEqual([10, 11, 12]);
  });

  it("ignores a root whose pid now belongs to a later process, and everything below it", () => {
    // Electron (pid 10) exited; a person's typecheck under timeout was given pid 10 afterwards.
    const table = [row(10, 300, 10, "timeout 900 pnpm typecheck", LATER), row(11, 10, 10, "tsgo --build", LATER)];
    expect(descendants(table, [{ pid: 10, started: T }])).toEqual([]);
    expect(selectRunProcesses(table, [{ pid: 10, started: T }], "/tmp/zeros-native-unified/run", 999)).toEqual([]);
  });

  it("names the run's folder only as a folder, never a sibling that shares its prefix", () => {
    const root = "/home/someone/zeros";
    expect(namesRunFolder("/home/someone/zeros/node_modules/.bin/vite", root)).toBe(true);
    expect(namesRunFolder("electron /home/someone/zeros", root)).toBe(true);
    expect(namesRunFolder("electron /home/someone/zeros --flag", root)).toBe(true);
    expect(namesRunFolder("/home/someone/zeros-review-p3/node_modules/.bin/tsgo --build", root)).toBe(false);
    expect(namesRunFolder("node /home/someone/zeros2/x.js", root)).toBe(false);
  });

  it("signals a whole group only when a run process leads it", () => {
    const before = [row(10, 1, 10, "electron"), row(11, 10, 10, "bun engine"), row(50, 40, 40, "/run/thing in someone else's group")];
    const table = [...before, row(40, 1, 40, "their shell"), row(999, 998, 998, "this script")];
    const { groups, singles } = signalTargets(before, table, 999);
    expect(groups).toEqual([10]);
    expect(singles.map(entry => entry.pid)).toEqual([50]);
  });

  it("never treats the shell that started the run as the app's, even when it names the folder", () => {
    const root = "/tmp/zeros-native-unified/run";
    expect(isLauncherCommand("/bin/bash -c ZEROS_NATIVE_CHECK_ROOT=/tmp/zeros-native-unified node x", root)).toBe(true);
    expect(isLauncherCommand("sh -c cd /tmp/zeros-native-unified", root)).toBe(true);
    expect(isLauncherCommand("/bin/zsh -c x", root)).toBe(true);
    expect(isLauncherCommand("timeout 900 node scripts/native-unified-check.mjs --run", root)).toBe(true);
    expect(isLauncherCommand("/usr/bin/coreutils --coreutils-prog-shebang=timeout /usr/bin/timeout 900 node x", root)).toBe(true);
    expect(isLauncherCommand(`/bin/sh ${root}/bin/login-shell -ilc env`, root)).toBe(false);
    expect(isLauncherCommand(`${root}/bin/bun run engine`, root)).toBe(false);
    expect(isLauncherCommand("/tmp/zeros-native-unified/stage/node_modules/electron/dist/electron -r hook", root)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("native check: teardown against real processes", () => {
  const started: ChildProcess[] = [];
  const base = mkdtempSync(path.join(os.tmpdir(), "znc-teardown-"));
  // A long-lived Node process whose command line names `file`, in a process group of its own (as a person's tool is).
  const sleeper = (file: string) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", file], { detached: true, stdio: "ignore" });
    started.push(child);
    return child;
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));
  afterEach(() => {
    for (const child of started.splice(0)) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
  });

  it("stops the run's own process and leaves a foreign one whose path shares the folder's prefix", async () => {
    const root = path.join(base, "zeros");
    const own = sleeper(path.join(root, "run", "engine.js"));
    const foreign = sleeper(path.join(`${root}-review-p3`, "node_modules", ".bin", "tsgo"));
    await settle();
    const result = await killRun([], root, { graceMs: 1000 });
    await settle();
    expect(alive(foreign.pid!)).toBe(true);
    expect(alive(own.pid!)).toBe(false);
    expect(result.left).toBe(0);
  });

  it("leaves a foreign process that was given a root's pid later", async () => {
    const root = path.join(base, "zeros");
    const foreign = sleeper(path.join(`${root}-review-p3`, "typecheck.js"));
    await settle();
    const now = await identify(foreign.pid!);
    expect(now).not.toBeNull();
    // The run's root had this pid once, at another time.
    await killRun([{ pid: foreign.pid!, started: now!.started === T ? LATER : T }], root, { graceMs: 500 });
    await settle();
    expect(alive(foreign.pid!)).toBe(true);
  });

  it("cleans its temp folder", () => {
    rmSync(base, { recursive: true, force: true });
  });
});

describe("native check: --cleanup removes its worktree from the main checkout", () => {
  const tmp = "/private/var/folders/x/T";
  const linked = { repo: `${tmp}/zeros-native/wt`, gitDir: "/Users/p/zeros/.git/worktrees/wt", common: "/Users/p/zeros/.git", realTop: `${tmp}/zeros-native/wt`, tmp };

  it("runs both commands from the main checkout, never from the worktree it deletes", () => {
    const removal = worktreeRemoval(linked);
    expect(removal?.main).toBe("/Users/p/zeros");
    expect(removal?.commands.map(command => command.args)).toEqual([
      ["-C", "/Users/p/zeros", "worktree", "remove", "--force", linked.realTop],
      ["-C", "/Users/p/zeros", "worktree", "prune"],
    ]);
    for (const command of removal!.commands) expect(command.cwd).toBe("/Users/p/zeros");
  });

  it("leaves a person's checkout, a worktree outside the temp directory and an unreadable Git alone", () => {
    expect(worktreeRemoval({ ...linked, gitDir: ".git", common: ".git", repo: "/Users/p/zeros", realTop: "/Users/p/zeros" })).toBeNull();
    expect(worktreeRemoval({ ...linked, realTop: "/Users/p/zeros-wt" })).toBeNull();
    expect(worktreeRemoval({ ...linked, realTop: `${tmp}-other/wt` })).toBeNull();
    for (const missing of ["gitDir", "common", "realTop"]) expect(worktreeRemoval({ ...linked, [missing]: "" }), missing).toBeNull();
  });

  it("finishes after the worktree it ran from is gone (the prune that failed with spawn git ENOENT)", () => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-cleanup-")));
    try {
      const main = path.join(base, "main"), worktree = path.join(base, "wt");
      const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
      mkdirSync(main);
      git(main, "init", "-q", "-b", "main");
      writeFileSync(path.join(main, "file"), "x");
      git(main, "add", "file");
      git(main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x");
      git(main, "worktree", "add", "-q", worktree);
      const removal = worktreeRemoval({ repo: worktree, gitDir: git(worktree, "rev-parse", "--git-dir").toString().trim(),
        common: git(worktree, "rev-parse", "--git-common-dir").toString().trim(), realTop: worktree, tmp: base });
      expect(removal?.main).toBe(main);
      for (const command of removal!.commands) git(command.cwd, ...command.args);
      expect(existsSync(worktree)).toBe(false);
      expect(git(main, "worktree", "list", "--porcelain").toString()).not.toContain(worktree);
      // The old prune, from the deleted worktree, is what failed on the Mac.
      expect(() => git(worktree, "-C", main, "worktree", "prune")).toThrow(/ENOENT/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("native check: --build finds a missing Electron binary", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "native-electron-"));
  const pkg = (name: string, files: Record<string, string>) => {
    const dir = path.join(base, name);
    for (const [file, content] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), content); }
    return dir;
  };
  const manifest = JSON.stringify({ name: "electron", version: "43.8.3" });

  it("reports the package's version and installs when pnpm skipped the postinstall (no dist)", () => {
    expect(electronInstall(pkg("skipped", { "package.json": manifest }))).toEqual({ installed: false, version: "43.8.3", reason: "no dist" });
  });

  it("installs when dist holds another version or path.txt names a missing executable", () => {
    expect(electronInstall(pkg("old", { "package.json": manifest, "dist/version": "v42.0.0", "path.txt": "electron", "dist/electron": "" })))
      .toMatchObject({ installed: false, reason: "dist holds 42.0.0" });
    expect(electronInstall(pkg("partial", { "package.json": manifest, "dist/version": "43.8.3", "path.txt": "Electron.app/Contents/MacOS/Electron" })).installed).toBe(false);
  });

  it("uses an installed Electron, and stops with no package at all", () => {
    expect(electronInstall(pkg("ok", { "package.json": manifest, "dist/version": "v43.8.3", "path.txt": "electron", "dist/electron": "" })))
      .toEqual({ installed: true, version: "43.8.3", reason: null });
    expect(electronInstall(path.join(base, "absent"))).toMatchObject({ installed: false, version: null });
  });

  it("cleans its temp folder", () => {
    rmSync(base, { recursive: true, force: true });
  });
});

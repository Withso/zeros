import { describe, expect, it } from "vitest";

import { descendants, foreignSockets, isLauncherCommand } from "../native-unified/processes.mjs";
import { isLocalUrl, isLoopbackAddress, PERSON_MUST_LOOK, scrub, table } from "../native-unified/report.mjs";

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

describe("native check: teardown", () => {
  it("finds every descendant of the run's roots", () => {
    const table = [
      { pid: 10, ppid: 1, pgid: 10, command: "electron" },
      { pid: 11, ppid: 10, pgid: 10, command: "bun engine" },
      { pid: 12, ppid: 11, pgid: 12, command: "git clone" },
      { pid: 20, ppid: 1, pgid: 20, command: "unrelated" },
    ];
    expect(descendants(table, [10]).map(row => row.pid).sort()).toEqual([10, 11, 12]);
  });

  it("never treats the shell that started the run as the app's, even when it names the folder", () => {
    const root = "/tmp/zeros-native-unified/run";
    expect(isLauncherCommand("/bin/bash -c ZEROS_NATIVE_CHECK_ROOT=/tmp/zeros-native-unified node x", root)).toBe(true);
    expect(isLauncherCommand("sh -c cd /tmp/zeros-native-unified", root)).toBe(true);
    expect(isLauncherCommand("/bin/zsh -c x", root)).toBe(true);
    expect(isLauncherCommand("timeout 900 node scripts/native-unified-check.mjs --run", root)).toBe(true);
    expect(isLauncherCommand(`/bin/sh ${root}/bin/login-shell -ilc env`, root)).toBe(false);
    expect(isLauncherCommand(`${root}/bin/bun run engine`, root)).toBe(false);
    expect(isLauncherCommand("/tmp/zeros-native-unified/stage/node_modules/electron/dist/electron -r hook", root)).toBe(false);
  });
});

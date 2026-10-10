// ──────────────────────────────────────────────────────────
// PTY host client — integration tests
// ──────────────────────────────────────────────────────────
//
// Exercises the real out-of-process Node PTY host (pty-host.cjs) through the
// engine-side client. This is the path that fixes the bun regression: the
// engine drives node-pty in a Node subprocess instead of loading it in-process
// (where bun's PTY I/O is dead). These run under vitest (Node), so the host
// child is spawned with `node` from PATH and node-pty works.
//
// Real shells + real timing, so timeouts are generous and assertions are
// liberal (we only need to prove bytes/keystrokes/exit flow end to end).
// ──────────────────────────────────────────────────────────

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnPtyViaHost,
  disposePtyHost,
  ptyHostRespawnHoldOffMsForTests,
  currentPtyHostBirth,
} from "../pty-host-client";
import type { PtyHandle } from "../service";
import type { PtyExitReason } from "@zeros/protocol/messages";
import { HostExecutionBoundary } from "../../agents/containment/host-boundary";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const SHELL =
  process.env.SHELL && process.env.SHELL.length > 0
    ? process.env.SHELL
    : "/bin/sh";

/** The host script THIS checkout owns. Resolved from the module URL, not
 *  process.cwd() — vitest's cwd is the repo root today, but the descendant-reap
 *  test below must exercise the source host either way (a desktop test env can
 *  otherwise inherit a packaged ZEROS_PTY_HOST_SCRIPT). */
const SOURCE_HOST_SCRIPT = fileURLToPath(
  new URL("../pty-host.cjs", import.meta.url),
);

/** An interactive shell with job control AND `disown`. Rules out /bin/sh
 *  (dash on Linux has neither), so the reap test skips rather than fails on a
 *  runner that ships neither zsh nor bash. `-f`/`--norc` keep user rc files out
 *  of the spawned shell. `prelude` covers the one difference that bites here:
 *  interactive bash has history expansion on, so `$!` dies with "event not
 *  found" instead of yielding the background job's pid. It has to be its OWN
 *  line — expansion is applied when the line is READ, so `set +H` sharing a
 *  line with `$!` is already too late. */
const JOB_CONTROL_SHELL = [
  { shell: "/bin/zsh", args: ["-f", "-i"], prelude: "" },
  {
    shell: "/bin/bash",
    args: ["--norc", "--noprofile", "-i"],
    prelude: "set +H",
  },
].find((candidate) => existsSync(candidate.shell));

/** Diagnostics only — never let the failure message itself fail the test on a
 *  runner whose `ps` rejects one of these format specifiers. */
function describeProcess(pid: number | null): string {
  if (!pid) return "no pid";
  try {
    return execFileSync(
      "ps",
      ["-o", "pid=,ppid=,pgid=,stat=,command=", "-p", String(pid)],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return "process details unavailable";
  }
}

function makeHandle(): {
  handle: PtyHandle;
  data: () => string;
  exit: Promise<{
    code: number | null;
    signal: number | null;
    reason?: PtyExitReason;
  }>;
} {
  let buf = "";
  let resolveExit: (v: {
    code: number | null;
    signal: number | null;
    reason?: PtyExitReason;
  }) => void;
  const exit = new Promise<{
    code: number | null;
    signal: number | null;
    reason?: PtyExitReason;
  }>((r) => {
    resolveExit = r;
  });
  const handle = spawnPtyViaHost({
    shell: SHELL,
    args: [],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    env: process.env as Record<string, string>,
  });
  handle.onData((d) => {
    buf += d;
  });
  handle.onExit((code, signal, reason) =>
    resolveExit({ code, signal, reason }),
  );
  return { handle, data: () => buf, exit };
}

/** Poll until `pred(data())` is true or we time out. */
async function waitFor(
  data: () => string,
  pred: (s: string) => boolean,
  timeoutMs = 4000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(data())) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred(data());
}

afterEach(() => {
  // Tear down the shared host between tests so a lingering shell can't bleed
  // output into the next case.
  disposePtyHost();
  vi.mocked(fs.openSync).mockReset();
  vi.restoreAllMocks();
});

describe.runIf(process.platform === "linux")("original shared PTY host birth", () => {
  it("captures the original child at spawn and retains it after its last session exits", async () => {
    expect(currentPtyHostBirth()).toBeNull();
    const opened = vi.mocked(fs.openSync);
    const { handle, data, exit } = makeHandle();
    const birth = currentPtyHostBirth();
    expect(birth).not.toBeNull();
    expect(Object.keys(birth!).sort()).toEqual(["parent", "pid", "startToken"]);
    expect(Object.isFrozen(birth)).toBe(true);
    expect(birth!.parent).toBe(process.pid);
    const call = opened.mock.calls.find(([file]) => file === `/proc/${birth!.pid}/stat`);
    expect(call).toBeDefined();
    expect(Number(call![1]) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
    const stat = fs.readFileSync(`/proc/${birth!.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    expect(stat.startsWith(`${birth!.pid} (`)).toBe(true);
    expect(Number(fields[1])).toBe(birth!.parent);
    expect(fields[19]).toBe(birth!.startToken);
    expect(await waitFor(data, () => handle.pid > 0)).toBe(true);
    expect(handle.pid).not.toBe(birth!.pid);
    handle.write("exit 0\r");
    await exit;
    expect(currentPtyHostBirth()).toBe(birth);
  });

  it("clears on disposal and never lets an old child's close clear its successor", async () => {
    const first = makeHandle(), original = currentPtyHostBirth();
    expect(original).not.toBeNull();
    expect(await waitFor(first.data, () => first.handle.pid > 0)).toBe(true);
    disposePtyHost();
    expect(currentPtyHostBirth()).toBeNull();
    const second = makeHandle(), successor = currentPtyHostBirth();
    expect(successor).not.toBeNull();
    expect(successor!.pid).not.toBe(original!.pid);
    expect(await waitFor(second.data, () => second.handle.pid > 0)).toBe(true);
    expect(await waitFor(() => "", () => !fs.existsSync(`/proc/${original!.pid}/stat`))).toBe(true);
    expect(currentPtyHostBirth()).toBe(successor);
  });

  it("clears a lost host and captures a new original birth on respawn", async () => {
    const first = makeHandle(), original = currentPtyHostBirth();
    expect(original).not.toBeNull();
    expect(await waitFor(first.data, () => first.handle.pid > 0)).toBe(true);
    process.kill(original!.pid, "SIGTERM");
    expect((await first.exit).reason).toBe("host-lost");
    expect(currentPtyHostBirth()).toBeNull();
    const second = makeHandle(), successor = currentPtyHostBirth();
    expect(successor).not.toBeNull();
    expect(successor!.pid).not.toBe(original!.pid);
    expect(await waitFor(second.data, () => second.handle.pid > 0)).toBe(true);
  });

  it("keeps ordinary PTY operation available when the original birth read fails", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fs.openSync).mockImplementation((...args) => {
      if (/^\/proc\/\d+\/stat$/.test(String(args[0]))) throw Object.assign(new Error("unavailable"), { code: "EACCES" });
      return actual.openSync(...args);
    });
    const { handle, data } = makeHandle();
    expect(currentPtyHostBirth()).toBeNull();
    expect(await waitFor(data, () => handle.pid > 0)).toBe(true);
    handle.write("echo ZEROS_BIRTH_READ_FAILURE_OK\r");
    expect(await waitFor(data, bytes => bytes.includes("ZEROS_BIRTH_READ_FAILURE_OK"))).toBe(true);
    expect(currentPtyHostBirth()).toBeNull();
  });

  it.each(["symlink", "overflow", "directory", "truncated", "wrong-pid", "wrong-parent"])(
    "grants no exemption for %s birth evidence and keeps the terminal usable", async condition => {
      const directory = await mkdtemp(path.join(tmpdir(), "zeros-pty-birth-"));
      const artifact = path.join(directory, "stat"), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      try {
        await writeFile(artifact, condition === "overflow" ? "0".repeat(4097) : "truncated");
        if (condition === "symlink") await symlink(artifact, path.join(directory, "stat-link"));
        // Explicit fault injection at the original child's fixed proc-stat
        // open; the real child still runs with its normal env/argv and IPC.
        vi.mocked(fs.openSync).mockImplementation((...args) => {
          const match = /^\/proc\/([1-9][0-9]*)\/stat$/.exec(String(args[0]));
          if (!match) return actual.openSync(...args);
          if (condition === "wrong-pid" || condition === "wrong-parent") {
            const source = actual.readFileSync(args[0], "utf8"), end = source.lastIndexOf(")");
            const fields = source.slice(end + 1).trim().split(/\s+/);
            if (condition === "wrong-parent") fields[1] = String(process.pid + 1);
            actual.writeFileSync(artifact, (condition === "wrong-pid" ? source.slice(0, end + 1).replace(/^\d+/, "1") : source.slice(0, end + 1)) + " " + fields.join(" "));
          }
          const file = condition === "directory" ? directory : condition === "symlink" ? path.join(directory, "stat-link") : artifact;
          return actual.openSync(file, args[1], args[2]);
        });
        const { handle, data } = makeHandle();
        expect(currentPtyHostBirth()).toBeNull();
        expect(await waitFor(data, () => handle.pid > 0)).toBe(true);
        expect(currentPtyHostBirth()).toBeNull();
      } finally {
        disposePtyHost();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("does not capture a birth on a non-Linux host", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let terminal!: ReturnType<typeof makeHandle>;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
      terminal = makeHandle();
      expect(currentPtyHostBirth()).toBeNull();
      expect(vi.mocked(fs.openSync).mock.calls.some(([file]) => /^\/proc\/\d+\/stat$/.test(String(file)))).toBe(false);
    } finally { Object.defineProperty(process, "platform", platform); }
    expect(await waitFor(terminal.data, () => terminal.handle.pid > 0)).toBe(true);
    expect(currentPtyHostBirth()).toBeNull();
  });
});

describe("pty-host-client — out-of-process node-pty", () => {
  it("streams shell output and round-trips keystrokes", async () => {
    const { handle, data } = makeHandle();
    // Give the shell a moment to draw, then type a command. The PTY echoes the
    // keystrokes AND the shell prints the result, so the marker shows up.
    await new Promise((r) => setTimeout(r, 400));
    handle.write("echo ZEROS_PTY_OK_123\r");
    const ok = await waitFor(data, (s) => s.includes("ZEROS_PTY_OK_123"));
    expect(ok).toBe(true);
    // pid is reported asynchronously by the host's "spawned" message; by now
    // it must be a real, positive pid.
    expect(handle.pid).toBeGreaterThan(0);
  });

  it("propagates a clean shell exit to onExit", async () => {
    const { handle, exit } = makeHandle();
    await new Promise((r) => setTimeout(r, 400));
    handle.write("exit 0\r");
    const result = await Promise.race([
      exit,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    expect(result).not.toBeNull();
  });

  it.runIf(process.platform !== "win32")(
    "rebinds a host supervisor to the trusted PTY launcher",
    async () => {
      const dataRoot = await mkdtemp(
        path.join(tmpdir(), "zeros-pty-supervisor-parent-"),
      );
      const priorDataRoot = process.env.ZEROS_DATA_DIR;
      process.env.ZEROS_DATA_DIR = dataRoot;
      let prepared: Awaited<
        ReturnType<HostExecutionBoundary["prepare"]>
      > | null = null;
      try {
        prepared = await new HostExecutionBoundary().prepare({
          executionId: "pty-supervisor-parent",
          actor: "repo-code-task",
          cwd: process.cwd(),
          workspaceRoot: process.cwd(),
        });
        const launch = prepared.wrapSpawn({
          command: "/bin/sh",
          args: ["-c", "printf 'ZEROS_SUPERVISED_PTY_OK\\n'"],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          stdio: "inherit",
        });
        let output = "";
        let resolveExit!: (value: {
          code: number | null;
          reason?: PtyExitReason;
        }) => void;
        const exit = new Promise<{
          code: number | null;
          reason?: PtyExitReason;
        }>((resolve) => {
          resolveExit = resolve;
        });
        const handle = spawnPtyViaHost({
          shell: launch.command,
          args: [...launch.args],
          cwd: launch.cwd,
          cols: 80,
          rows: 24,
          env: { ...launch.env },
          immediateParentPidArgIndex: launch.immediateParentPidArgIndex,
        });
        handle.onSpawned((pid) => prepared!.trackProcessGroup(pid));
        handle.onData((chunk) => {
          output += chunk;
        });
        handle.onExit((code, _signal, reason) => resolveExit({ code, reason }));

        const result = await Promise.race([
          exit,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("supervised PTY did not exit")),
              4_000,
            ),
          ),
        ]);
        expect(result).toEqual({ code: 0, reason: undefined });
        expect(output).toContain("ZEROS_SUPERVISED_PTY_OK");
      } finally {
        disposePtyHost();
        await prepared?.stopAndProve().catch(() => undefined);
        if (priorDataRoot === undefined) delete process.env.ZEROS_DATA_DIR;
        else process.env.ZEROS_DATA_DIR = priorDataRoot;
        await rm(dataRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32" && JOB_CONTROL_SHELL !== undefined)(
    "reaps a background job when its live terminal is killed",
    async () => {
      // The desktop test environment can inherit a packaged host path. This
      // regression must exercise the source host changed by this checkout.
      const priorHostScript = process.env.ZEROS_PTY_HOST_SCRIPT;
      process.env.ZEROS_PTY_HOST_SCRIPT = SOURCE_HOST_SCRIPT;
      let output = "";
      let childPid: number | null = null;
      const handle = spawnPtyViaHost({
        shell: JOB_CONTROL_SHELL!.shell,
        args: JOB_CONTROL_SHELL!.args,
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        env: process.env as Record<string, string>,
      });
      const exit = new Promise<void>((resolve) =>
        handle.onExit(() => resolve()),
      );
      handle.onData((chunk) => {
        output += chunk;
        const match = /ZEROS_BG_PID:(\d+)/.exec(output);
        if (match) childPid = Number(match[1]);
      });
      try {
        const ready = await waitFor(
          () => output,
          () => handle.pid > 0,
          4_000,
        );
        expect(ready).toBe(true);
        if (JOB_CONTROL_SHELL!.prelude) {
          handle.write(`${JOB_CONTROL_SHELL!.prelude}\r`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // `set -m` is the portable spelling of zsh's `setopt monitor`: job
        // control puts the background job in its OWN process group, which is
        // exactly what a process-group-only kill misses. nohup + disown then
        // strip the last two ties to the shell.
        handle.write(
          "set -m; nohup sleep 30 </dev/null >/dev/null 2>&1 & child=$!; disown; echo ZEROS_BG_PID:$child\r",
        );
        const childStarted = await waitFor(
          () => output,
          () => childPid !== null,
          4_000,
        );
        expect(childStarted).toBe(true);
        const beforeKill = describeProcess(childPid);
        handle.kill();
        await Promise.race([
          exit,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("terminal shell did not exit")),
              4_000,
            ),
          ),
        ]);
        expect(childPid).toBeGreaterThan(0);
        const gone = await waitFor(
          () => "",
          () => {
            try {
              const state = execFileSync(
                "ps",
                ["-o", "stat=", "-p", String(childPid)],
                { encoding: "utf8" },
              ).trim();
              return state.length === 0 || state.startsWith("Z");
            } catch {
              return true;
            }
          },
          2_000,
        );
        const processRow = gone ? "" : describeProcess(childPid);
        expect(
          gone,
          `shell=${JOB_CONTROL_SHELL!.shell}; before=${beforeKill}; after=${processRow}`,
        ).toBe(true);
      } finally {
        if (priorHostScript === undefined)
          delete process.env.ZEROS_PTY_HOST_SCRIPT;
        else process.env.ZEROS_PTY_HOST_SCRIPT = priorHostScript;
        if (childPid) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already reaped */
          }
        }
      }
    },
  );

  it("survives resize and kill without throwing", async () => {
    const { handle, data, exit } = makeHandle();
    const ready = await waitFor(data, () => handle.pid > 0, 4000);
    expect(ready).toBe(true);
    expect(handle.pid).toBeGreaterThan(0);
    expect(() => handle.resize(120, 40)).not.toThrow();
    expect(() => handle.kill()).not.toThrow();
    const result = await Promise.race([
      exit,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    // kill should drive the shell to exit.
    expect(result).not.toBeNull();
  });

  it("synthesizes an exit when the host is disposed under a live session", async () => {
    const { handle, data, exit } = makeHandle();
    // Wait until the session is genuinely live (the host reported its pid)
    // before yanking the whole host — a cold respawn can take >300ms.
    await waitFor(data, () => handle.pid > 0, 4000);
    expect(handle.pid).toBeGreaterThan(0);
    // Killing the whole host (not just the session) must still flush a
    // synthetic exit to the renderer so the tab shows "[process exited]".
    disposePtyHost();
    const result = await Promise.race([
      exit,
      new Promise<null>((r) => setTimeout(() => r(null), 4000)),
    ]);
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("host-lost");
  });

  it("reports an unloadable node-pty host as unavailable", async () => {
    disposePtyHost();
    const previous = process.env.ZEROS_PTY_NODE_PTY;
    process.env.ZEROS_PTY_NODE_PTY = "/definitely/missing/node-pty.js";
    try {
      const { exit } = makeHandle();
      const result = await Promise.race([
        exit,
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      expect(result).not.toBeNull();
      expect(result?.reason).toBe("host-unavailable");
    } finally {
      if (previous === undefined) delete process.env.ZEROS_PTY_NODE_PTY;
      else process.env.ZEROS_PTY_NODE_PTY = previous;
    }
  });

  it("holds off respawning after a fatal node-pty load failure (no doomed child per open)", async () => {
    disposePtyHost();
    const previous = process.env.ZEROS_PTY_NODE_PTY;
    process.env.ZEROS_PTY_NODE_PTY = "/definitely/missing/node-pty.js";
    try {
      const first = makeHandle();
      const r1 = await Promise.race([
        first.exit,
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ]);
      expect(r1?.reason).toBe("host-unavailable");
      // The fatal-preceded boot death engages the hold-off IMMEDIATELY (a
      // respawn would fail identically), before the synthetic exits flush.
      expect(ptyHostRespawnHoldOffMsForTests()).toBeGreaterThan(0);

      // A terminal opened during the hold-off fails fast with the same
      // synthetic exit — ensure() refuses to boot another doomed child, and
      // the attempt must neither clear nor extend the hold-off.
      const second = makeHandle();
      const r2 = await Promise.race([
        second.exit,
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      expect(r2?.reason).toBe("host-unavailable");
      expect(ptyHostRespawnHoldOffMsForTests()).toBeGreaterThan(0);

      // Intentional teardown (engine stop / test cleanup) is not a crash:
      // it resets the hold-off so a fresh start isn't blocked.
      disposePtyHost();
      expect(ptyHostRespawnHoldOffMsForTests()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ZEROS_PTY_NODE_PTY;
      else process.env.ZEROS_PTY_NODE_PTY = previous;
    }
  });
});

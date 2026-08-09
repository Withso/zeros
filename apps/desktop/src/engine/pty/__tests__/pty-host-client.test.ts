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

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  spawnPtyViaHost,
  disposePtyHost,
  ptyHostRespawnHoldOffMsForTests,
} from "../pty-host-client";
import type { PtyHandle } from "../service";
import type { PtyExitReason } from "@zeros/protocol/messages";

const SHELL =
  process.env.SHELL && process.env.SHELL.length > 0
    ? process.env.SHELL
    : "/bin/sh";

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
    "reaps a background job when its live terminal is killed",
    async () => {
      // The desktop test environment can inherit a packaged host path. This
      // regression must exercise the source host changed by this checkout.
      const priorHostScript = process.env.ZEROS_PTY_HOST_SCRIPT;
      process.env.ZEROS_PTY_HOST_SCRIPT = `${process.cwd()}/apps/desktop/src/engine/pty/pty-host.cjs`;
      let output = "";
      let childPid: number | null = null;
      const handle = spawnPtyViaHost({
        shell: "/bin/zsh",
        args: ["-f", "-i"],
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
        handle.write(
          "setopt monitor; nohup sleep 30 </dev/null >/dev/null 2>&1 & child=$!; disown; echo ZEROS_BG_PID:$child\r",
        );
        const childStarted = await waitFor(
          () => output,
          () => childPid !== null,
          4_000,
        );
        expect(childStarted).toBe(true);
        const beforeKill = execFileSync(
          "ps",
          ["-o", "pid=,ppid=,pgid=,sess=,command=", "-p", String(childPid)],
          { encoding: "utf8" },
        ).trim();
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
        let processRow = "";
        if (!gone) {
          try {
            processRow = execFileSync(
              "ps",
              ["-o", "pid=,ppid=,pgid=,sess=,command=", "-p", String(childPid)],
              { encoding: "utf8" },
            ).trim();
          } catch {
            processRow = "process details unavailable";
          }
        }
        expect(gone, `before=${beforeKill}; after=${processRow}`).toBe(true);
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

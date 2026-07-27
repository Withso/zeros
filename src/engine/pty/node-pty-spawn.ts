// The PTY spawn boundary for engine-owned interactive terminals.
//
// The engine runs under bun, where node-pty's PTY I/O is broken (a spawned
// shell emits no bytes — see pty-host.cjs). So the real node-pty shells live in
// a Node subprocess (pty-host.cjs), driven by pty-host-client.ts. This module
// stays the single place that computes the Zeros shell setup (login shell,
// managed ZDOTDIR, scrubbed-or-full env) and hands it to the host.

import { buildLoginArgs, buildPtyEnv, pickShell } from "./shell-setup";
import { TerminalMirror } from "./mirror";
import { spawnPtyViaHost } from "./pty-host-client";
import type { PtyHandle, PtyMirrorFactory, PtySpawnRequest } from "./service";

export { disposePtyHost } from "./pty-host-client";

/** The real PtySpawnFn: forks a Zeros login shell via the Node PTY host,
 *  adapted to the transport-agnostic PtyHandle. The shell, login args, and
 *  fully-resolved env are computed here (engine-side) and forwarded to the
 *  host, which only drives node-pty. */
export function createNodePtyShell(req: PtySpawnRequest): PtyHandle {
  // One-shot setup mode: run a single command in a login shell that EXITS when
  // done, with a caller-supplied (scrubbed setup) env. Otherwise: an interactive
  // login shell with the computed terminal env.
  const oneShot = typeof req.command === "string" && req.command.length > 0;
  const args = oneShot
    ? process.platform === "win32"
      ? ["/c", req.command as string]
      : [...buildLoginArgs(), "-c", req.command as string]
    : buildLoginArgs();
  return spawnPtyViaHost({
    shell: pickShell(),
    args,
    cwd: req.cwd,
    cols: req.cols,
    rows: req.rows,
    // For one-shot setup the engine passes a fully-resolved env verbatim;
    // otherwise compute the interactive-terminal env (scoping PWD/OLDPWD/
    // ZEROS_WORKTREE_PATH to THIS worktree, scrubbing host secrets for remote).
    env: req.env ?? buildPtyEnv({ scrub: req.scrubEnv === true, cwd: req.cwd }),
    name: "xterm-256color",
  });
}

/** The real scrollback-mirror factory (headless xterm). Pure JS — runs fine in
 *  the bun engine, so the mirror stays in-process; only node-pty moved out. */
export const createTerminalMirror: PtyMirrorFactory = (cols, rows) =>
  new TerminalMirror(cols, rows);

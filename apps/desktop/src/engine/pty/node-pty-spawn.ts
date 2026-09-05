// The PTY spawn boundary for engine-owned interactive terminals.
//
// The engine runs under bun, where node-pty's PTY I/O is broken (a spawned
// shell emits no bytes — see pty-host.cjs). So the real node-pty shells live in
// a Node subprocess (pty-host.cjs), driven by pty-host-client.ts. This module
// stays the single place that computes the Zeros shell setup (login shell,
// managed ZDOTDIR, scrubbed-or-full env) and hands it to the host.

import path from "node:path";

import {
  buildLoginArgs,
  buildOneShotArgs,
  buildPtyEnv,
  pickShell,
} from "./shell-setup";
import { TerminalMirror } from "./mirror";
import { spawnPtyViaHost } from "./pty-host-client";
import type { PtyHandle, PtyMirrorFactory, PtySpawnRequest } from "./service";

export { disposePtyHost } from "./pty-host-client";

export function cloudHumanPtyLaunch(
  request: Pick<
    PtySpawnRequest,
    "cloudWorkerIdentity" | "cloudWorkerSetprivPath" | "wrapSpawn"
  >,
  launch: { command: string; args: readonly string[] },
): { command: string; args: string[] } {
  if (!request.cloudWorkerIdentity || request.wrapSpawn) {
    return { command: launch.command, args: [...launch.args] };
  }
  if (
    !request.cloudWorkerSetprivPath ||
    !path.isAbsolute(request.cloudWorkerSetprivPath)
  ) {
    throw new Error(
      "cloud terminal identity requires an absolute setpriv path",
    );
  }
  return {
    command: request.cloudWorkerSetprivPath,
    args: [
      `--reuid=${request.cloudWorkerIdentity.uid}`,
      `--regid=${request.cloudWorkerIdentity.gid}`,
      "--clear-groups",
      "--",
      launch.command,
      ...launch.args,
    ],
  };
}

/** The real PtySpawnFn: forks a Zeros login shell via the Node PTY host,
 *  adapted to the transport-agnostic PtyHandle. The shell, login args, and
 *  fully-resolved env are computed here (engine-side) and forwarded to the
 *  host, which only drives node-pty. */
export function createNodePtyShell(req: PtySpawnRequest): PtyHandle {
  // One-shot mode (Setup script / Run action): run a single command in a shell
  // that EXITS when done. buildOneShotArgs makes that shell read the same
  // startup files as the interactive terminal — the whole point being that a
  // Run action must find the same `node`/`pnpm` a user would (see its comment).
  // Otherwise: an interactive login shell with the computed terminal env.
  const shell = pickShell();
  const oneShot = typeof req.command === "string" && req.command.length > 0;
  const args = oneShot
    ? buildOneShotArgs(shell, req.command as string, req.interactive === true)
    : buildLoginArgs();
  const env =
    req.env ?? buildPtyEnv({ scrub: req.scrubEnv === true, cwd: req.cwd });
  const launch = req.wrapSpawn
    ? req.wrapSpawn({
        command: shell,
        args,
        cwd: req.cwd,
        env,
        stdio: "inherit",
      })
    : { command: shell, args, cwd: req.cwd, env, stdio: "inherit" as const };
  const hostLaunch = cloudHumanPtyLaunch(req, launch);
  return spawnPtyViaHost({
    shell: hostLaunch.command,
    args: hostLaunch.args,
    cwd: launch.cwd,
    cols: req.cols,
    rows: req.rows,
    // For one-shot the engine passes a fully-resolved env we use VERBATIM
    // (setup's scrubbed allowlist, the run env); otherwise compute the
    // interactive-terminal env (scoping PWD/OLDPWD/ZEROS_WORKTREE_PATH to THIS
    // worktree, scrubbing host secrets for remote). Nothing is added here — the
    // env a caller hands us has to be the exact set it can be reviewed against
    // (that is what makes setup-hooks.ts's allowlist auditable).
    env: { ...launch.env },
    name: "xterm-256color",
    ...(launch.immediateParentPidArgIndex === undefined
      ? {}
      : { immediateParentPidArgIndex: launch.immediateParentPidArgIndex }),
  });
}

/** The real scrollback-mirror factory (headless xterm). Pure JS — runs fine in
 *  the bun engine, so the mirror stays in-process; only node-pty moved out. */
export const createTerminalMirror: PtyMirrorFactory = (cols, rows) =>
  new TerminalMirror(cols, rows);

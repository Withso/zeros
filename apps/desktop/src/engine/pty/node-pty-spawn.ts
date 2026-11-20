// Bun can load node-pty but does not deliver PTY I/O; the Node subprocess owns the native driver.

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
  _request: Pick<
    PtySpawnRequest,
    "cloudWorkerIdentity" | "cloudWorkerSetprivPath" | "wrapSpawn"
  >,
  launch: { command: string; args: readonly string[] },
): { command: string; args: string[] } {
  // Preserve the engine identity and any supplied supervision wrapper; legacy Cloud worker metadata never selects a UID.
  return { command: launch.command, args: [...launch.args] };
}

export function createNodePtyShell(req: PtySpawnRequest): PtyHandle {
  // Interactive one-shots need the same startup environment as the terminal so Run can find the user's tools.
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
    // Do not merge in host variables: the launch environment must remain the set resolved by the caller or its wrapper.
    env: { ...launch.env },
    name: "xterm-256color",
    ...(launch.immediateParentPidArgIndex === undefined
      ? {}
      : { immediateParentPidArgIndex: launch.immediateParentPidArgIndex }),
  });
}

/** The pure-JS scrollback mirror stays in Bun; only the native driver runs in Node. */
export const createTerminalMirror: PtyMirrorFactory = (cols, rows) =>
  new TerminalMirror(cols, rows);

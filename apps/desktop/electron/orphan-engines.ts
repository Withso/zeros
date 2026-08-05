import path from "node:path";

export interface ProcessTableRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,command=` without assuming a fixed command width. */
export function parseProcessTable(output: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const ppid = Number.parseInt(match[2]!, 10);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) continue;
    rows.push({ pid, ppid, command: match[3]! });
  }
  return rows;
}

/** Small shell-word parser for the argv rendering emitted by macOS `ps`.
 * Engine paths are normally absolute and unquoted; quote/backslash handling
 * keeps exact matching safe when a source worktree contains spaces. */
export function splitProcessCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const flush = () => {
    if (current.length === 0) return;
    args.push(current);
    current = "";
  };

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  flush();
  return args;
}

/** `ps eww` appends environment assignments to the rendered command. Match an
 * exact token so similarly-prefixed instance slugs cannot cross-reap. */
export function processHasEnvironmentAssignment(
  processWithEnvironment: string,
  name: string,
  expected: string,
): boolean {
  return processWithEnvironment
    .split(/\s+/)
    .some((token) => token === `${name}=${expected}`);
}

/** Should a process found LISTENing inside this build's engine port range be
 * reaped?
 *
 * The range scan is deliberately command-shape-based (any engine flavor in OUR
 * channel's range is a candidate), but it must not kill a listener that another
 * LIVE owner is still managing. A standalone `zeros serve` CLI can sit there,
 * and older releases once assigned Beta and Stable the same range — killing
 * those out from under their owners caused cross-instance engine flaps. The
 * ppid tells the two cases apart:
 *
 *   - ppid 1  → orphan (its Electron/terminal parent is gone; macOS reparents
 *               to launchd, pid 1). Reap it — nothing else ever will, and it
 *               holds a port + watchers + memory forever.
 *   - other   → its parent still owns it (a live sibling app instance, a
 *               mid-graceful-shutdown quit, a user's CLI engine under a
 *               shell). Leave it alone; LocalTransport's bounded port walk
 *               routes around an occupied port and the Electron host verifies
 *               the selected listener externally.
 *   - null    → the process-table lookup failed. Fail closed and leave it
 *               alone: a transient `ps` failure is not proof of orphanhood,
 *               and the walk + host verification can route around the listener.
 *
 * Engine HOSTS (pty-host.cjs / cursor-host.cjs — the Node subprocesses the
 * engine forks) matter here too: they inherit the engine's LISTENING socket,
 * so when the engine is SIGKILLed they keep the port alive with nobody
 * accepting — the "bound but black-holed" port behind the beta.82 respawn
 * loop. A live engine's hosts have ppid = the engine, so the ppid-1 gate is
 * also what makes them safe to match at all. */
export function shouldReapRangeListener(opts: {
  command: string;
  ppid: number | null;
}): boolean {
  const { command, ppid } = opts;
  const looksLikeEngine =
    command.includes("zeros-engine") ||
    (command.includes("bun") && command.includes("apps/desktop/src/cli.ts"));
  if (looksLikeEngine) return ppid === 1;
  const looksLikeEngineHost =
    command.includes("pty-host.cjs") || command.includes("cursor-host.cjs");
  if (looksLikeEngineHost) return ppid === 1;
  return false;
}

/** Is this a parentless engine created by this exact linked-worktree dev app?
 *
 * The dynamic dev launcher chooses a new free port block on every launch, so a
 * range-only reaper cannot see an older orphan. Source CLI path identifies the
 * code worktree; `ZEROS_INSTANCE` identifies its isolated app/database. PPID 1
 * proves Electron no longer owns it. All predicates must hold before signaling
 * a process outside the current port range. */
export function isSameDevInstanceOrphan(
  row: ProcessTableRow,
  opts: {
    cliPath: string;
    instance: string;
    processWithEnvironment: string;
    skipPid?: number;
  },
): boolean {
  if (
    row.ppid !== 1 ||
    row.pid === process.pid ||
    row.pid === opts.skipPid ||
    opts.instance.length === 0
  ) {
    return false;
  }
  const args = splitProcessCommand(row.command);
  if (args.length < 6 || path.basename(args[0]!).toLowerCase() !== "bun") {
    return false;
  }
  if (path.normalize(args[1]!) !== path.normalize(path.resolve(opts.cliPath))) {
    return false;
  }
  if (args[2] !== "serve") return false;
  const rootIndex = args.indexOf("--root");
  const portIndex = args.indexOf("--port");
  if (
    rootIndex < 0 ||
    !args[rootIndex + 1] ||
    portIndex < 0 ||
    !/^\d+$/.test(args[portIndex + 1] ?? "")
  ) {
    return false;
  }
  return processHasEnvironmentAssignment(
    opts.processWithEnvironment,
    "ZEROS_INSTANCE",
    opts.instance,
  );
}

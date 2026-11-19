import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { appIdentity } from "../src/engine/db/paths";

// LaunchServices can fail Squirrel's post-install relaunch with -600
// (procNotFound) after launchd has already spawned the new app suspended. That
// process never runs, yet it remains the app's launchd job, so every later open
// fails with "The application is not open anymore" until it is killed. Only a
// process that outlives the quitting app can see it. Processes that existed
// before the restart are never candidates.
export const RELAUNCH_GUARD_SCRIPT = `
old_pid=$1 exe=$2 app=$3 log=$4 interval=$5
exit_ticks=$6 watch_ticks=$7 stuck_ticks=$8 ps_bin=$9 open_bin=\${10}

note() {
  [ -n "$log" ] || return 0
  printf '[%s] [updater] relaunch guard: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$log" 2>/dev/null
}

instances() {
  "$ps_bin" -axww -o pid= -o stat= -o comm= 2>/dev/null |
    while read -r pid stat comm; do
      if [ "$comm" = "$exe" ]; then printf '%s %s\\n' "$pid" "$stat"; fi
    done
}

known=" $(instances | while read -r pid stat; do printf '%s ' "$pid"; done)"

tick=0
while kill -0 "$old_pid" 2>/dev/null; do
  [ "$tick" -lt "$exit_ticks" ] || exit 0
  sleep "$interval"
  tick=$((tick + 1))
done

tick=0 stuck= seen=0 reopened=0
while [ "$tick" -lt "$watch_ticks" ]; do
  sleep "$interval"
  tick=$((tick + 1))
  running= stopped=
  list=$(instances)
  while read -r pid stat; do
    [ -n "$pid" ] || continue
    case "$known" in *" $pid "*) continue ;; esac
    case "$stat" in
      T*) [ -n "$stopped" ] || stopped=$pid ;;
      Z*) ;;
      *) running=$pid ;;
    esac
  done <<EOF
$list
EOF
  [ -z "$running" ] || exit 0
  if [ -z "$stopped" ]; then
    stuck= seen=0
    continue
  fi
  if [ "$stopped" != "$stuck" ]; then
    stuck=$stopped seen=0
  fi
  seen=$((seen + 1))
  [ "$seen" -ge "$stuck_ticks" ] || continue
  kill -KILL "$stopped" 2>/dev/null
  known="$known$stopped "
  note "pid $stopped stayed suspended after the update relaunch; reopening"
  "$open_bin" "$app" >/dev/null 2>&1 || note "reopening the app failed"
  reopened=$((reopened + 1))
  stuck= seen=0
  [ "$reopened" -lt 2 ] || exit 0
done
`;

export interface RelaunchGuardTiming {
  intervalSeconds: number;
  exitWaitTicks: number;
  watchTicks: number;
  stuckTicks: number;
}

// ShipIt relaunches about 15 seconds after the app exits; a healthy launch
// leaves the stopped state within milliseconds.
const DEFAULT_TIMING: RelaunchGuardTiming = {
  intervalSeconds: 1,
  exitWaitTicks: 120,
  watchTicks: 180,
  stuckTicks: 10,
};

export function appBundleForExecutable(executable: string): string | null {
  return /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1] ?? null;
}

export function startUpdateRelaunchGuard(
  options: {
    platform?: NodeJS.Platform;
    executable?: string;
    pid?: number;
    logPath?: string;
    timing?: Partial<RelaunchGuardTiming>;
    psPath?: string;
    openPath?: string;
  } = {},
): ChildProcess | null {
  if ((options.platform ?? process.platform) !== "darwin") return null;
  const executable = options.executable ?? process.execPath;
  const bundle = appBundleForExecutable(executable);
  if (!bundle) return null;
  const timing = { ...DEFAULT_TIMING, ...options.timing };
  const logPath =
    options.logPath ??
    path.join(os.homedir(), "Library", "Logs", appIdentity(), "main.log");
  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        RELAUNCH_GUARD_SCRIPT,
        "zeros-relaunch-guard",
        String(options.pid ?? process.pid),
        executable,
        bundle,
        logPath,
        String(timing.intervalSeconds),
        String(timing.exitWaitTicks),
        String(timing.watchTicks),
        String(timing.stuckTicks),
        options.psPath ?? "/bin/ps",
        options.openPath ?? "/usr/bin/open",
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir() },
      },
    );
    child.on("error", () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

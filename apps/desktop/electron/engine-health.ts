export interface OwnedEngineManifest {
  port: number;
  instance: string;
}

/** A manifest selects a port from the range assigned to this child. Return the
 * configured candidate so file contents never become HTTP request options. */
export function selectEnginePort(
  manifestPort: number,
  firstPort: number,
  portSpan: number,
): number | null {
  if (
    !Number.isInteger(firstPort) ||
    firstPort < 1 ||
    !Number.isInteger(portSpan) ||
    portSpan < 1 ||
    firstPort + portSpan > 65_536
  )
    return null;
  for (let port = firstPort; port < firstPort + portSpan; port++) {
    if (port === manifestPort) return port;
  }
  return null;
}

/** The engine deliberately retires stale kernel process domains before it
 * publishes any renderer authority. Recovery may outlive an ordinary health
 * probe when several abandoned generations are drained in sequence. Preserve
 * a bounded startup budget large enough for recovery to finish without turning
 * a recoverable upgrade into a premature sidecar kill. */
export const ENGINE_STARTUP_TIMEOUT_MS = 10 * 60_000;

export function engineStartupWaitDecision(input: {
  readonly elapsedMs: number;
  readonly childExited: boolean;
  readonly timeoutMs?: number;
}): "wait" | "child-exited" | "timed-out" {
  if (input.childExited) return "child-exited";
  const timeoutMs = input.timeoutMs ?? ENGINE_STARTUP_TIMEOUT_MS;
  return input.elapsedMs >= timeoutMs ? "timed-out" : "wait";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accept only the manifest written by the exact child this host spawned.
 *
 * PID prevents a sibling app sharing the same repo/runtime path from being
 * adopted. The per-boot instance nonce then binds every later /health probe to
 * that same engine instead of accepting whichever process happens to answer on
 * the recorded port. */
export function parseOwnedEngineManifest(
  value: unknown,
  expectedPid: number | undefined,
): OwnedEngineManifest | null {
  if (
    !isRecord(value) ||
    typeof expectedPid !== "number" ||
    !Number.isInteger(expectedPid) ||
    expectedPid <= 0
  ) {
    return null;
  }
  if (value.pid !== expectedPid) return null;
  if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port <= 0 ||
    value.port > 65535
  ) {
    return null;
  }
  if (typeof value.instance !== "string" || value.instance.length === 0) {
    return null;
  }
  return { port: value.port, instance: value.instance };
}

/** Prove that /health belongs to the engine generation in its owned manifest. */
export function isExpectedEngineHealth(
  value: unknown,
  expectedInstance: string,
): boolean {
  return (
    expectedInstance.length > 0 &&
    isRecord(value) &&
    value.status === "ok" &&
    value.instance === expectedInstance
  );
}

export const ENGINE_HEALTH_PROBE_TIMEOUT_MS = 1500;
export const ENGINE_WATCHDOG_INTERVAL_MS = 3000;
export const ENGINE_WATCHDOG_FAILURE_THRESHOLD = 5;
/** Confirm an idle listener for a full missed-probe window. Output is weaker
 * evidence than a private heartbeat, but can indicate queued Git work; allow
 * that confirmation the same minute as bounded Git read requests. Neither
 * deadline is extended by subsequent log output. */
export const ENGINE_HEALTH_CONFIRMATION_TIMEOUT_MS =
  ENGINE_WATCHDOG_INTERVAL_MS * ENGINE_WATCHDOG_FAILURE_THRESHOLD;
export const ENGINE_OUTPUT_CONFIRMATION_TIMEOUT_MS = 60_000;
/** Protect outstanding work through temporary event-loop starvation. Only a
 * newer exact-child heartbeat renews this lease. A dead child bypasses it, and
 * an abandoned lease expires so a wedged event loop remains recoverable. */
export const ENGINE_ACTIVE_WORK_STALL_TIMEOUT_MS = 5 * 60_000;

export interface EngineHealthActivity {
  readonly lastOutputAt: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly activeWork: boolean;
}

/** One tracker per spawned child. Raw output may come from an inherited pipe,
 * so keep it separate from the engine's private event-loop/work heartbeat.
 * Store receive times and counters only; never retain any log/control text. */
export function createEngineHealthActivityTracker(
  now: () => number = () => performance.now(),
): {
  recordOutput(): void;
  recordHeartbeat(value: unknown, expectedInstance: string): boolean;
  snapshot(): EngineHealthActivity;
} {
  let lastOutputAt: number | null = null;
  let lastHeartbeatAt: number | null = null;
  let activeWork = false;
  let lastSequence = -1;
  const counter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return {
    recordOutput() {
      lastOutputAt = now();
    },
    recordHeartbeat(value, expectedInstance) {
      if (
        !isRecord(value) ||
        value.type !== "engine.heartbeat" ||
        expectedInstance.length === 0 ||
        value.instance !== expectedInstance ||
        !counter(value.sequence) ||
        value.sequence <= lastSequence ||
        !counter(value.activeRequests) ||
        !counter(value.activeTurns)
      ) {
        return false;
      }
      lastSequence = value.sequence;
      lastHeartbeatAt = now();
      activeWork = value.activeRequests > 0 || value.activeTurns > 0;
      return true;
    },
    snapshot() {
      return { lastOutputAt, lastHeartbeatAt, activeWork };
    },
  };
}

/** Hold-off before the watchdog's NEXT kill/respawn after a run of respawns
 *  that never produced a single successful probe.
 *
 *  A zero-contact respawn means relaunching did not restore contact — the
 *  fault is environmental (black-holed port, sandbox denial, broken binary),
 *  and immediately respawning again just burns a SIGKILL + full engine boot +
 *  an lsof/ps sweep + a log burst every ~21s, forever (observed for 13+ hours
 *  in a 0.0.13 field log). Double the wait per zero-contact cycle from the
 *  probe window (~15s), capped at 5 minutes; the first respawn (count 0 or 1)
 *  stays immediate so recovery from an ordinary crash is as fast as ever. */
export function zeroContactRespawnBackoffMs(
  respawnsWithoutContact: number,
  opts: { probeWindowMs?: number; capMs?: number } = {},
): number {
  const probeWindowMs = opts.probeWindowMs ?? 15_000;
  const capMs = opts.capMs ?? 5 * 60_000;
  if (respawnsWithoutContact <= 1) return 0;
  return Math.min(probeWindowMs * 2 ** (respawnsWithoutContact - 1), capMs);
}

import {
  ENGINE_ACTIVE_WORK_STALL_TIMEOUT_MS,
  ENGINE_HEALTH_CONFIRMATION_TIMEOUT_MS,
  ENGINE_HEALTH_PROBE_TIMEOUT_MS,
  ENGINE_OUTPUT_CONFIRMATION_TIMEOUT_MS,
  ENGINE_WATCHDOG_FAILURE_THRESHOLD,
  ENGINE_WATCHDOG_INTERVAL_MS,
  zeroContactRespawnBackoffMs,
  type EngineHealthActivity,
} from "./engine-health";

export interface EngineWatchdogTarget {
  root: string;
  port: number;
  instance: string;
  /** Host-owned child generation, independent of the port and manifest. */
  generation: number;
}

export function sameEngineTarget(
  a: EngineWatchdogTarget | null,
  b: EngineWatchdogTarget | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.root === b.root &&
    a.port === b.port &&
    a.instance === b.instance &&
    a.generation === b.generation
  );
}

export interface EngineWatchdogObservation extends EngineHealthActivity {
  readonly childExited: boolean;
}

interface WatchdogDependencies {
  current(): EngineWatchdogTarget | null;
  /** Null when the target no longer belongs to the host's current child. */
  observe(target: EngineWatchdogTarget): EngineWatchdogObservation | null;
  probe(port: number, instance: string, timeoutMs: number): Promise<boolean>;
  /** Return the generation this restart created, or null if superseded. */
  restart(
    target: EngineWatchdogTarget,
    shouldRestart: () => boolean,
  ): Promise<EngineWatchdogTarget | null>;
  describeListeners(): Promise<string>;
  log(message: string): void;
  now?(): number;
}

/** One poll of the host's crash recovery monitor. Startup and shutdown have no
 * target. Keep zero-contact backoff across our own unsuccessful replacements. */
export function createEngineWatchdogTick(
  deps: WatchdogDependencies,
): () => Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const threshold = ENGINE_WATCHDOG_FAILURE_THRESHOLD;
  let fails = 0;
  let respawnsWithoutContact = 0;
  let nextRespawnAllowedAt = 0;
  let polling = false;
  let observed: EngineWatchdogTarget | null = null;
  let busyDeferralLogged = false;
  const observationFor = (target: EngineWatchdogTarget) =>
    sameEngineTarget(target, deps.current()) ? deps.observe(target) : null;
  const hasActiveWork = (observation: EngineWatchdogObservation): boolean => {
    if (!observation.activeWork || observation.lastHeartbeatAt === null)
      return false;
    const age = now() - observation.lastHeartbeatAt;
    return age >= 0 && age < ENGINE_ACTIVE_WORK_STALL_TIMEOUT_MS;
  };
  const contacted = () => {
    fails = 0;
    respawnsWithoutContact = 0;
    nextRespawnAllowedAt = 0;
    busyDeferralLogged = false;
  };
  const recover = async (
    target: EngineWatchdogTarget,
    childExited: boolean,
  ) => {
    if (now() < nextRespawnAllowedAt) return;
    const confirmedAt = now();
    // This predicate also runs at the front of the host's shared spawn queue.
    // A generation change, newly active work, or an old confirmation cancels
    // replacement. An actual child exit remains authoritative and immediate.
    const shouldRestart = () => {
      const latest = observationFor(target);
      if (!latest) return false;
      if (latest.childExited) return true;
      return (
        !childExited &&
        !hasActiveWork(latest) &&
        now() - confirmedAt <= ENGINE_WATCHDOG_INTERVAL_MS
      );
    };
    if (!shouldRestart()) return;
    const nextRespawnsWithoutContact = respawnsWithoutContact + 1;
    const backoffMs = zeroContactRespawnBackoffMs(nextRespawnsWithoutContact);
    const listeners =
      nextRespawnsWithoutContact >= 2 && nextRespawnsWithoutContact <= 3
        ? await deps.describeListeners()
        : null;
    if (!shouldRestart()) return;
    deps.log(
      childExited
        ? `engine child exited on port ${target.port}; respawning`
        : `engine unreachable on port ${target.port} after ${threshold} probes and confirmation; respawning`,
    );
    const recordAttempt = () => {
      respawnsWithoutContact = nextRespawnsWithoutContact;
      nextRespawnAllowedAt = now() + backoffMs;
    };
    let replacement: EngineWatchdogTarget | null;
    try {
      replacement = await deps.restart(target, shouldRestart);
    } catch (error) {
      // A failed boot consumed an actual recovery attempt. A queued decision
      // returning null did not, and must not penalize a later genuine recovery.
      recordAttempt();
      throw error;
    }
    if (!replacement) return;
    fails = 0;
    recordAttempt();
    // Preserve zero-contact backoff across our own replacement. An external
    // root/generation change starts its own failure budget on the next poll.
    observed = replacement;
    if (respawnsWithoutContact >= 2) {
      if (listeners !== null) {
        deps.log(
          `${respawnsWithoutContact} watchdog respawns in a row with zero successful probes — ` +
            `respawning is not recovering this; a stale process may be black-holing the port. ` +
            `Next attempt in ${Math.round(backoffMs / 1000)}s. Listeners:\n` +
            listeners,
        );
      } else {
        deps.log(
          `watchdog zero-contact respawn #${respawnsWithoutContact}; ` +
            `backing off ${Math.round(backoffMs / 1000)}s before the next attempt`,
        );
      }
    }
  };
  return async () => {
    if (polling) return;
    polling = true;
    try {
      const target = deps.current();
      if (!target) {
        fails = 0;
        return;
      }
      if (!sameEngineTarget(target, observed)) {
        contacted();
        observed = target;
      }
      let observation = observationFor(target);
      if (!observation) return;
      if (observation.childExited) {
        await recover(target, true);
        return;
      }
      const probeStartedAt = now();
      const healthy = await deps.probe(
        target.port,
        target.instance,
        ENGINE_HEALTH_PROBE_TIMEOUT_MS,
      );
      // A root switch, replacement or shutdown can happen while HTTP is pending.
      // Its result belongs only to the engine we actually probed.
      observation = observationFor(target);
      if (!observation) return;
      if (observation.childExited) {
        await recover(target, true);
        return;
      }
      if (healthy) {
        contacted();
        return;
      }
      // A deadline delivered late because Electron slept or its own event loop
      // was starved is not an independent vote that the engine is wedged.
      if (
        now() - probeStartedAt >
        ENGINE_HEALTH_PROBE_TIMEOUT_MS + ENGINE_WATCHDOG_INTERVAL_MS
      ) {
        fails = 0;
        return;
      }
      fails = Math.min(fails + 1, threshold);
      if (fails < threshold) return;
      if (hasActiveWork(observation)) {
        if (!busyDeferralLogged) {
          deps.log(
            `engine health delayed on port ${target.port}; deferring recovery while owned child work is active`,
          );
          busyDeferralLogged = true;
        }
        return;
      }
      if (now() < nextRespawnAllowedAt) return;
      const outputAge =
        observation.lastOutputAt === null
          ? Infinity
          : now() - observation.lastOutputAt;
      const confirmationMs =
        outputAge >= 0 && outputAge < ENGINE_HEALTH_CONFIRMATION_TIMEOUT_MS
          ? ENGINE_OUTPUT_CONFIRMATION_TIMEOUT_MS
          : ENGINE_HEALTH_CONFIRMATION_TIMEOUT_MS;
      const confirmationStartedAt = now();
      const confirmed = await deps.probe(
        target.port,
        target.instance,
        confirmationMs,
      );
      observation = observationFor(target);
      if (!observation) return;
      if (observation.childExited) {
        await recover(target, true);
        return;
      }
      if (confirmed) {
        contacted();
        return;
      }
      if (
        now() - confirmationStartedAt >
        confirmationMs + ENGINE_WATCHDOG_INTERVAL_MS
      ) {
        fails = 0;
        return;
      }
      if (hasActiveWork(observation)) return;
      await recover(target, false);
    } finally {
      polling = false;
    }
  };
}

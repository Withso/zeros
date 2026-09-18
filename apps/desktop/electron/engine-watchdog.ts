import { zeroContactRespawnBackoffMs } from "./engine-health";

export interface EngineWatchdogTarget {
  root: string;
  port: number;
  instance: string;
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
    a.instance === b.instance
  );
}

interface WatchdogDependencies {
  current(): EngineWatchdogTarget | null;
  probe(port: number, instance: string): Promise<boolean>;
  /** Return the generation this restart created, or null if superseded. */
  restart(target: EngineWatchdogTarget): Promise<EngineWatchdogTarget | null>;
  describeListeners(): Promise<string>;
  log(message: string): void;
  now?(): number;
}

/** One poll of the host's crash recovery monitor. Startup and shutdown have no
 * target. Keep zero-contact backoff across our own unsuccessful replacements. */
export function createEngineWatchdogTick(
  deps: WatchdogDependencies,
): () => Promise<void> {
  const now = deps.now ?? Date.now;
  const threshold = 5;
  let fails = 0;
  let respawnsWithoutContact = 0;
  let nextRespawnAllowedAt = 0;
  let polling = false;
  let observed: EngineWatchdogTarget | null = null;
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
        fails = 0;
        respawnsWithoutContact = 0;
        nextRespawnAllowedAt = 0;
        observed = target;
      }
      const healthy = await deps.probe(target.port, target.instance);
      // A root switch, replacement or shutdown can happen while HTTP is pending.
      // Its result belongs only to the engine we actually probed.
      if (!sameEngineTarget(target, deps.current())) return;
      if (healthy) {
        fails = 0;
        respawnsWithoutContact = 0;
        nextRespawnAllowedAt = 0;
        return;
      }
      fails += 1;
      if (fails < threshold) return;
      if (now() < nextRespawnAllowedAt) {
        fails = threshold;
        return;
      }
      deps.log(
        `engine unreachable on port ${target.port} after ${threshold} probes; respawning`,
      );
      fails = 0;
      respawnsWithoutContact += 1;
      if (respawnsWithoutContact >= 2) {
        const backoffMs = zeroContactRespawnBackoffMs(respawnsWithoutContact);
        nextRespawnAllowedAt = now() + backoffMs;
        if (respawnsWithoutContact <= 3) {
          deps.log(
            `${respawnsWithoutContact} watchdog respawns in a row with zero successful probes — ` +
              `respawning is not recovering this; a stale process may be black-holing the port. ` +
              `Next attempt in ${Math.round(backoffMs / 1000)}s. Listeners:\n` +
              (await deps.describeListeners()),
          );
        } else {
          deps.log(
            `watchdog zero-contact respawn #${respawnsWithoutContact}; ` +
              `backing off ${Math.round(backoffMs / 1000)}s before the next attempt`,
          );
        }
      }
      if (!sameEngineTarget(target, deps.current())) return;
      const replacement = await deps.restart(target);
      // Preserve zero-contact backoff across our own replacement. An external
      // root/generation change starts its own failure budget on the next poll.
      if (replacement) observed = replacement;
    } finally {
      polling = false;
    }
  };
}

// ──────────────────────────────────────────────────────────
// Boot phase timer — attribute a slow engine start to its phase
// ──────────────────────────────────────────────────────────
//
// The renderer cannot read Local chats, Git or settings until the engine
// reports ready, so every second here is a second of "Loading…" at launch.
// The startup sequence awaits many independent recovery and maintenance
// steps; this records how long each took, in closed labels only (no paths,
// ids or counts), and the ready line names the slow ones.
// ──────────────────────────────────────────────────────────

export type BootPhase =
  | "process-recovery"
  | "terminals"
  | "settings"
  | "legacy-state"
  | "lifecycle-recovery"
  | "trash"
  | "worktree-relocation"
  | "seed"
  | "design-reconcile"
  | "turn-recovery"
  | "seed-migration"
  | "archive-refs"
  | "repo-prune"
  | "legacy-history"
  | "backfill"
  | "transport"
  | "gateway"
  | "watchers"
  | "registration";

export class BootPhaseTimer {
  private last: number;
  private readonly phases: Array<readonly [BootPhase, number]> = [];

  constructor(private readonly now: () => number = () => performance.now()) {
    this.last = now();
  }

  /** Close the phase that ran since the previous mark. */
  mark(phase: BootPhase): void {
    const at = this.now();
    this.phases.push([phase, at - this.last]);
    this.last = at;
  }

  /** Phases at or above `minMs`, slowest first: `seed=1200ms trash=300ms`. */
  slowPhases(minMs = 250): string | null {
    const slow = this.phases
      .filter(([, ms]) => ms >= minMs)
      .sort((a, b) => b[1] - a[1]);
    return slow.length > 0
      ? slow.map(([phase, ms]) => `${phase}=${Math.round(ms)}ms`).join(" ")
      : null;
  }
}

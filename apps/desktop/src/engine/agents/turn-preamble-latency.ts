// ──────────────────────────────────────────────────────────
// Turn-preamble measurement — the half FirstTokenLatency excludes
// ──────────────────────────────────────────────────────────
//
// adapters/shared/first-token-latency.ts splits a slow turn into three
// segments and then measures only the middle one, deliberately: its clock
// starts when the prompt is handed to the provider, "so this measures the
// provider, not our queueing". That leaves the FIRST segment — dispatch →
// provider call, Zeros' own work — with no measurement at all.
//
// It is not small. Between the `[agents] dispatch AGENT_PROMPT` line and the
// adapter's `turn:` line the engine persists the user message, takes a
// pre-turn working-tree snapshot for checkpoint/undo, and clears the workspace
// lifecycle barrier. The snapshot is `git add -A` over the whole worktree, so
// it scales with the repo rather than with the prompt: on a worktree with
// ~22k untracked-but-not-ignored files it measured 3.8s cold and 0.4s warm.
// Both numbers are plausible readings of the same 3-5s gap in a log, and
// without phases there is no way to tell which one you are looking at — the
// mistake this module exists to stop repeating.
//
// Same shape as its sibling on purpose: one line, same stderr channel, quiet
// under the threshold so an ordinary turn adds nothing. Raise the bar with
// ZEROS_TURN_PREAMBLE_SLOW_MS.
// ──────────────────────────────────────────────────────────

/** A preamble slower than this earns one line. Lower than the provider-side
 *  threshold because this segment is entirely our own work: a second spent
 *  before the model is even called is already worth explaining. */
export const DEFAULT_PREAMBLE_SLOW_MS = 1_000;

export function turnPreambleSlowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.ZEROS_TURN_PREAMBLE_SLOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREAMBLE_SLOW_MS;
}

/** Measures ONE turn's preamble. Create per prompt, `mark()` at each phase
 *  boundary in order, and `report()` at the handoff to the adapter. */
export class TurnPreambleLatency {
  private readonly startedAt: number;
  private lastMarkAt: number;
  private readonly phases: Array<{ name: string; ms: number }> = [];

  constructor(
    private readonly agentId: string,
    private readonly slowMs: number = turnPreambleSlowMs(),
    now: number = Date.now(),
  ) {
    this.startedAt = now;
    this.lastMarkAt = now;
  }

  /** Close the phase that ends here. Phases are recorded even on a fast turn —
   *  they cost two numbers, and deciding to keep them at `report()` is what
   *  keeps the ordinary case silent. */
  mark(name: string, now: number = Date.now()): void {
    this.phases.push({ name, ms: now - this.lastMarkAt });
    this.lastMarkAt = now;
  }

  /** The line to log when the preamble was slow, else null.
   *
   *  Names the dominant phase up front. "4.2s" alone sends someone reading a
   *  worktree snapshot when the time actually went to persistence, which is
   *  the whole failure mode here. */
  report(now: number = Date.now()): string | null {
    const total = now - this.startedAt;
    if (total < this.slowMs) return null;
    const slowest = this.phases.reduce<{ name: string; ms: number } | null>(
      (worst, phase) => (!worst || phase.ms > worst.ms ? phase : worst),
      null,
    );
    const breakdown = this.phases
      .map((phase) => `${phase.name}=${phase.ms}ms`)
      .join(" ");
    return (
      `[${this.agentId}] turn preamble ${total}ms before the provider was called` +
      (slowest ? ` (mostly ${slowest.name})` : "") +
      (breakdown ? `: ${breakdown}` : "")
    );
  }
}

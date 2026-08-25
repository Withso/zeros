// ──────────────────────────────────────────────────────────
// Time-to-first-token measurement (shared)
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// "Sending a message is slow" is one complaint with three unrelated causes,
// and only one of them is the model:
//
//   dispatch → provider call   Zeros' own work (option build, binary resolve)
//   provider call → 1st token  session warm-up, backend connect, prompt
//                              processing — the part that is slow and invisible
//   1st token → done           generation, which is bounded by output length
//
// The Cursor host has measured the middle segment since the contained-turn
// work (`run N first model output after Xms` in cursor-host.cjs), which is the
// only reason a 9s Cursor turn could be attributed at all — 3.5s blocked on a
// workspace prewarm, ~2s per fresh connection to the backend, the rest model
// time. Claude and Codex had NO equivalent, so a 12s Claude turn and a 4s
// Codex turn were indistinguishable from each other in the log: both are just
// a `turn:` line and, eleven seconds later, a `cache-read ratio` line.
//
// This gives all three providers the same measurement, on the same stderr
// channel, in the same shape, so a slow turn can be split into "we were slow",
// "the provider took a long time to start talking", or "the model wrote a lot"
// without a debug build.
//
// Deliberately quiet: nothing is logged for a turn that starts talking inside
// the threshold, so the ordinary case adds no lines. Raise the bar per-agent
// with ZEROS_FIRST_TOKEN_SLOW_MS.
// ──────────────────────────────────────────────────────────

/** A turn slower than this to its first token gets one line. Below it the wait
 *  is ordinary latency, not something to investigate. Matches the Cursor
 *  host's SLOW_FIRST_ITEM_MS so the three providers agree on "slow". */
export const DEFAULT_FIRST_TOKEN_SLOW_MS = 5_000;

export function firstTokenSlowMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = Number(env.ZEROS_FIRST_TOKEN_SLOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FIRST_TOKEN_SLOW_MS;
}

/** Extra context worth carrying on the line, because the same number means
 *  different things in different states. */
export interface FirstTokenContext {
  /** First turn of this provider session — it pays every once-per-session
   *  cost (process spawn, auth, prompt cache write) that later turns don't. */
  cold?: boolean;
  /** Effective model, so a slow turn can be blamed on the right one. */
  model?: string | undefined;
  /** Anything provider-specific: `cacheRead=0%`, `promptTokens=28580`. */
  detail?: string | undefined;
}

/** Measures one provider session's turns. Create per session; call
 *  `beginTurn()` when the prompt is handed to the provider and `firstOutput()`
 *  on every candidate output event — it returns a line for the FIRST
 *  content-bearing one of each turn and null for everything after it. */
export class FirstTokenLatency {
  private sentAt: number | null = null;
  private turnIndex = 0;
  private readonly slowMs: number;

  constructor(
    private readonly agentId: string,
    slowMs: number = firstTokenSlowMs(),
  ) {
    this.slowMs = slowMs;
  }

  /** The prompt has been handed to the provider; the clock starts here rather
   *  than at dispatch so this measures the provider, not our queueing. */
  beginTurn(now: number = Date.now()): void {
    this.sentAt = now;
    this.turnIndex += 1;
  }

  /** A turn that never produced output (error, cancel) must not attribute its
   *  first token to the NEXT turn. */
  endTurn(): void {
    this.sentAt = null;
  }

  /** Call on the first output-bearing event. Returns the log line when the
   *  wait crossed the threshold, and null otherwise (including on every
   *  subsequent call within the same turn). */
  firstOutput(
    context: FirstTokenContext = {},
    now: number = Date.now(),
  ): string | null {
    const sentAt = this.sentAt;
    if (sentAt === null) return null;
    // One report per turn: clearing here is what makes this safe to call from
    // inside a hot stream loop.
    this.sentAt = null;
    const waited = now - sentAt;
    if (waited < this.slowMs) return null;
    const bits = [
      context.cold
        ? "cold session — first turn"
        : `turn #${this.turnIndex} in this session`,
    ];
    if (context.model) bits.push(`model=${context.model}`);
    if (context.detail) bits.push(context.detail);
    return `[${this.agentId}] first model output after ${waited}ms (${bits.join("; ")})`;
  }

  /** True while a turn is waiting for its first token — lets a caller skip
   *  building context strings it would only throw away. */
  get awaitingFirstOutput(): boolean {
    return this.sentAt !== null;
  }
}

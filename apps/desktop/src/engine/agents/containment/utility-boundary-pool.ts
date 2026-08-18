// ──────────────────────────────────────────────────────────
// utility-boundary-pool.ts — one warm background boundary per identical request
// ──────────────────────────────────────────────────────────
//
// Engine-owned one-shots — chat-title generation, provider auth/version probes,
// save-time key validation, `listSessions` — are real provider code and so must
// run inside a real ZSR boundary. Each one used to prepare its OWN boundary and
// then prove it torn down: a fresh provider HOME projection (four tree
// traversals plus a per-file copy), a fresh private shadow Git (~45 `git`
// spawns), a fresh live canary (two cold Node starts), and a proven teardown —
// ~2.5 s of engine work, per call, for work nobody is watching. In the
// 2026-08-17 boot log roughly a third of all admissions were exactly this, and
// their concurrent promotions were the source of the recurring
// "preserved N concurrent provider HOME conflict(s)" churn.
//
// This pool keeps ONE such boundary alive per identical request and hands it to
// each one-shot in turn.
//
// The safety argument, stated plainly:
//
//  1. REUSE IS POLICY-IDENTICAL BY CONSTRUCTION. The pool key is a digest of the
//     complete BoundaryRequest with only `executionId` removed. Two operations
//     share a boundary only when every other input — territory, roots, policy
//     inputs, provider, actor, capabilities, priority — is byte-identical. A
//     boundary is never "close enough".
//  2. IT IS NOT A NEW TRUST LEVEL. One prepared boundary already hosts many
//     provider child processes for a live agent session; that is its whole job.
//     Serving N background one-shots from one boundary is the same shape, with
//     the same generation, the same canary-proved fence, and the same proven
//     teardown at the end.
//  3. ONE OPERATION AT A TIME. Leases are strictly serialized per key. Nothing
//     in here has to reason about two provider one-shots sharing a private HOME
//     or a private state directory concurrently, because that never happens.
//  4. IT NEVER SERVES A SESSION. Only background, engine-initiated one-shots
//     take leases; user session admissions keep their own dedicated boundaries.
//  5. TEARDOWN IS STILL PROVEN. Idle expiry, `disposeAll`, and an unhealthy
//     retirement latch all route through the same proven-teardown callback the
//     per-call path used. A teardown that cannot be proven propagates exactly as
//     before — the pool adds no new way to skip a proof.
//  6. A BOUNDARY IS NEVER REUSED AFTER TROUBLE. Any operation error, any
//     teardown failure, and any territory-generation change retires (or drops)
//     the entry instead of handing it to the next caller.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

import type { BoundaryRequest, PreparedBoundary } from "./types";

/** How long an idle pooled boundary is kept before it is proven torn down.
 * Long enough to serve the burst that follows a boot or a settings save (probes
 * for several providers, a title, a key validation), short enough that a warm
 * private HOME is not held open across a normal pause in activity. */
export const UTILITY_BOUNDARY_IDLE_MS = 60_000;

export interface UtilityBoundaryLease {
  readonly boundary: PreparedBoundary;
  readonly executionId: string;
  /** True when this lease was served by an already-warm boundary. Logged by the
   * caller so the saving is observable rather than assumed. */
  readonly reused: boolean;
  /** Release the lease. `outcome: "failed"` retires the boundary instead of
   * returning it to the pool. Rejects only if a retirement could not be proven,
   * matching the per-call path's contract. */
  release(outcome: "ok" | "failed"): Promise<void>;
}

interface PoolEntry {
  readonly key: string;
  readonly executionId: string;
  readonly boundary: PreparedBoundary;
  readonly generation: string;
  /** Serializes leases for this key. Resolves when the current holder releases. */
  tail: Promise<void>;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  retiring?: Promise<void>;
}

export interface UtilityBoundaryPoolOptions {
  /** Admit a boundary for this exact request. */
  readonly prepare: (request: BoundaryRequest) => Promise<PreparedBoundary>;
  /** Prove the boundary stopped and clean up its session directory — the same
   * callback the per-call path used, so teardown semantics are unchanged. */
  readonly retire: (
    executionId: string,
    boundary: PreparedBoundary,
  ) => Promise<void>;
  /** Refuse to admit while boundary retirement is unhealthy (fail-closed latch).
   * Throws exactly as the per-call path does. */
  readonly assertHealthy?: () => void;
  readonly idleMs?: number;
}

/** Stable digest of everything about a request except which execution asked for
 * it. `executionId` only forms paths and labels — the security identity is the
 * boundary's `generation`, minted fresh at prepare — so removing it is what
 * makes two otherwise-identical requests legitimately interchangeable. */
export function utilityBoundaryKey(request: BoundaryRequest): string {
  const { executionId: _executionId, ...rest } = request;
  return createHash("sha256")
    .update(stableStringify(rest))
    .digest("hex")
    .slice(0, 32);
}

/** JSON with object keys sorted at every depth, so two structurally equal
 * requests always digest identically regardless of construction order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export class UtilityBoundaryPool {
  private readonly entries = new Map<string, PoolEntry>();
  private readonly idleMs: number;
  private disposed = false;

  constructor(private readonly options: UtilityBoundaryPoolOptions) {
    this.idleMs = options.idleMs ?? UTILITY_BOUNDARY_IDLE_MS;
  }

  /** Take the (single) lease for this request, admitting a boundary only if no
   * warm one exists for the identical request. Callers must release. */
  async acquire(request: BoundaryRequest): Promise<UtilityBoundaryLease> {
    const key = utilityBoundaryKey(request);
    // Queue behind whatever holds this key, so at most one one-shot at a time
    // uses a pooled boundary. Waiting is correct rather than merely convenient:
    // these are background operations, and serializing them also stops them
    // from starving the machine the way the old per-call herd did.
    for (;;) {
      const waiting = this.entries.get(key);
      if (!waiting) break;
      if (waiting.retiring) {
        await waiting.retiring.catch(() => undefined);
        continue;
      }
      if (!waiting.busy) break;
      await waiting.tail.catch(() => undefined);
    }
    if (this.disposed) {
      throw new Error("utility boundary pool is disposed");
    }
    let entry = this.entries.get(key);
    if (entry && !entry.busy && !entry.retiring) {
      this.clearIdle(entry);
      return this.lease(entry, true);
    }
    this.options.assertHealthy?.();
    // The FIRST caller's executionId becomes the pooled boundary's id. It only
    // forms paths and log labels (the security identity is `generation`), so
    // reusing it is safe — and it keeps `[zsr] admitted …` lines and session
    // directories named after the work that actually created the boundary
    // (`probe-codex-…`, `title-…`) instead of an opaque pool handle.
    const executionId = request.executionId;
    const boundary = await this.options.prepare(request);
    entry = {
      key,
      executionId,
      boundary,
      generation: String(boundary.generation),
      tail: Promise.resolve(),
      busy: false,
    };
    this.entries.set(key, entry);
    return this.lease(entry, false);
  }

  private lease(entry: PoolEntry, reused: boolean): UtilityBoundaryLease {
    entry.busy = true;
    let settle!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let released = false;
    return {
      boundary: entry.boundary,
      executionId: entry.executionId,
      reused,
      release: async (outcome) => {
        if (released) return;
        released = true;
        entry.busy = false;
        try {
          // A failed operation may have left provider state this pool cannot
          // reason about (a half-written private HOME, a wedged child). Retire
          // rather than hand it to the next caller: a fresh admission is cheap
          // next to a wrong reuse.
          if (outcome === "failed" || this.disposed) {
            await this.retire(entry);
            return;
          }
          this.armIdle(entry);
        } finally {
          settle();
        }
      },
    };
  }

  private armIdle(entry: PoolEntry): void {
    this.clearIdle(entry);
    const timer = setTimeout(() => {
      if (entry.busy) return;
      void this.retire(entry).catch(() => {
        // A pooled boundary that cannot prove teardown is exactly the state the
        // gateway's retirement latch exists for; the retire callback has already
        // recorded it. Nothing here may swallow that — it just must not become
        // an unhandled rejection on a timer.
      });
    }, this.idleMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  private clearIdle(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private async retire(entry: PoolEntry): Promise<void> {
    if (entry.retiring) return entry.retiring;
    this.clearIdle(entry);
    const flight = (async () => {
      try {
        await this.options.retire(entry.executionId, entry.boundary);
      } finally {
        // Drop the entry either way. On success it is gone; on failure the
        // gateway now owns the un-proven boundary through its own latch, and
        // reusing it here would be the one genuinely unsafe move available.
        if (this.entries.get(entry.key) === entry) {
          this.entries.delete(entry.key);
        }
      }
    })();
    entry.retiring = flight;
    return flight;
  }

  /** Retire every idle pooled boundary now (territory transition, engine stop).
   * Busy entries are retired by their holder's release. Rejects if any teardown
   * could not be proven. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    const errors: unknown[] = [];
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.busy) return;
        try {
          await this.retire(entry);
        } catch (error) {
          errors.push(error);
        }
      }),
    );
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            "pooled utility boundaries could not all be proven stopped",
          );
    }
  }

  /** Re-open the pool after a disposeAll (a territory transition ends, the
   * engine continues). Entries are already gone; only the latch resets. */
  reopen(): void {
    this.disposed = false;
  }

  /** Live entry count — diagnostics and tests only. */
  size(): number {
    return this.entries.size;
  }
}

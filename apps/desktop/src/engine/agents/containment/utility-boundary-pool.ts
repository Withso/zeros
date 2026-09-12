// ──────────────────────────────────────────────────────────
// utility-boundary-pool.ts — one warm background boundary per identical request
// ──────────────────────────────────────────────────────────
//
// Engine-owned one-shots — chat-title generation, provider auth/version probes,
// save-time key validation, `listSessions` — are real provider code and inherit
// the same routed execution contract as sessions. Each one used to prepare its
// OWN boundary and then prove it torn down: cheap for native execution, but a
// full policy/canary/teardown cycle for a sandboxed actor or cloud worker. In
// the 2026-08-17 boot log roughly a third of all admissions were exactly this.
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
//     in here has to reason about concurrent one-shots in the same process
//     domain, because that never happens.
//  4. IT NEVER SERVES A SESSION. Only background, engine-initiated one-shots
//     take leases; user session admissions keep their own dedicated boundaries.
//  5. TEARDOWN IS STILL PROVEN. Idle expiry and `disposeAll` route through the
//     same proven-teardown callback the per-call path used. A teardown that
//     cannot be proven remains owned and retried by that exact boundary.
//  6. A BOUNDARY IS NEVER REUSED AFTER TROUBLE. Any operation error, any
//     teardown failure, and any territory-generation change retires (or drops)
//     the entry instead of handing it to the next caller.
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import path from "node:path";

import type {
  BoundaryRequest,
  BoundaryTerritoryContributionSnapshot,
  PreparedBoundary,
} from "./types";

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
  readonly territoryContributions:
    | readonly BoundaryTerritoryContributionSnapshot[]
    | undefined;
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
  readonly idleMs?: number;
}

/** Keep immutable owner metadata on a prepared object before any transition
 * can retire it. The gateway's exact failed-proof ledger outlives pool entries
 * and needs this snapshot to decide which later territory mutation must wait. */
export function attachBoundaryTerritoryContributions(
  boundary: PreparedBoundary,
  contributions: readonly BoundaryTerritoryContributionSnapshot[] | undefined,
): void {
  if (!contributions) return;
  const existing = boundary.territoryContributions;
  if (existing === undefined) {
    Object.defineProperty(boundary, "territoryContributions", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: contributions,
    });
    return;
  }
  if (JSON.stringify(existing) !== JSON.stringify(contributions)) {
    throw new Error("prepared boundary territory authority is stale");
  }
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

/** Complete pool key: request identity (minus executionId) plus the exact
 * per-owner contribution snapshot. Shared with the warm session-boundary pool
 * so "byte-identical request" means the same thing on both sides. */
export function pooledBoundaryRequestKey(
  request: BoundaryRequest,
  territoryContributions:
    | readonly BoundaryTerritoryContributionSnapshot[]
    | undefined,
): string {
  const contributionKey = createHash("sha256")
    .update(
      territoryContributions === undefined
        ? "legacy-unknown"
        : stableStringify(territoryContributions),
    )
    .digest("hex")
    .slice(0, 16);
  return `${utilityBoundaryKey(request)}:${contributionKey}`;
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
  /** Per-key admission reservation. Lease serialization used to begin only
   * after prepare() published an entry, so two cold callers could prepare two
   * identical boundaries and the later map write orphaned the first. */
  private readonly pendingAdmissions = new Map<string, Promise<void>>();
  private readonly idleMs: number;
  private disposed = false;
  /** Monotonic transition generation. `reopen()` deliberately does not roll it
   * back: an admission that began before disposeAll must never publish into the
   * reopened pool after the old territory was retired. */
  private lifecycleEpoch = 0;
  /** Managed-workspace transitions are narrower than disposeAll: they close
   * admission only for utility requests whose authority includes that exact
   * workspace. Counts allow overlapping serialized transitions to share the
   * same root without one reopening it underneath the other. */
  private readonly suspendedWorkspaceTerritories = new Map<string, number>();
  private readonly workspaceTerritoryEpochs = new Map<string, number>();
  private workspaceTerritoryEpoch = 0;

  constructor(private readonly options: UtilityBoundaryPoolOptions) {
    this.idleMs = options.idleMs ?? UTILITY_BOUNDARY_IDLE_MS;
  }

  /** Take the (single) lease for this request, admitting a boundary only if no
   * warm one exists for the identical request. Callers must release. */
  async acquire(
    request: BoundaryRequest,
    territoryContributions?: readonly BoundaryTerritoryContributionSnapshot[],
  ): Promise<UtilityBoundaryLease> {
    // Capture transition generations before the first possible queue await.
    // A request already waiting behind an identical busy/cold admission still
    // carries its pre-transition authority; sampling only after it wakes would
    // let that stale request look newly admitted once the gate reopened.
    const requestedLifecycleEpoch = this.lifecycleEpoch;
    const requestedWorkspaceEpoch = this.workspaceTerritoryEpoch;
    const requestedTerritoryEpochs = territoryContributions?.map(
      (contribution) => {
        const root = path.resolve(contribution.workspaceRoot);
        return [root, this.workspaceTerritoryEpochs.get(root) ?? 0] as const;
      },
    );
    const transitionCrossed = (): boolean =>
      requestedLifecycleEpoch !== this.lifecycleEpoch ||
      (territoryContributions === undefined
        ? requestedWorkspaceEpoch !== this.workspaceTerritoryEpoch
        : (requestedTerritoryEpochs ?? []).some(
            ([root, epoch]) =>
              (this.workspaceTerritoryEpochs.get(root) ?? 0) !== epoch,
          ));
    const key = pooledBoundaryRequestKey(request, territoryContributions);
    // Queue behind whatever holds this key, so at most one one-shot at a time
    // uses a pooled boundary. Waiting is correct rather than merely convenient:
    // these are background operations, and serializing them also stops them
    // from starving the machine the way the old per-call herd did.
    for (;;) {
      const pendingAdmission = this.pendingAdmissions.get(key);
      if (pendingAdmission) {
        await pendingAdmission.catch(() => undefined);
        continue;
      }
      const waiting = this.entries.get(key);
      if (!waiting) break;
      if (waiting.retiring) {
        await waiting.retiring.catch(() => undefined);
        continue;
      }
      if (!waiting.busy) break;
      await waiting.tail.catch(() => undefined);
    }
    if (transitionCrossed()) {
      throw new Error(
        "utility boundary admission was invalidated by a territory transition",
      );
    }
    if (this.disposed) {
      throw new Error("utility boundary pool is disposed");
    }
    if (this.workspaceTerritorySuspended(territoryContributions)) {
      throw new Error(
        "utility boundary admission is blocked by a workspace territory transition",
      );
    }
    let entry = this.entries.get(key);
    if (entry && !entry.busy && !entry.retiring) {
      this.clearIdle(entry);
      return this.lease(entry, true);
    }
    let resolveAdmission!: () => void;
    let rejectAdmission!: (error: unknown) => void;
    const pendingAdmission = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    // The owning acquire rethrows the same failure. Attach a sink as well so a
    // cold admission with no concurrent waiter never creates an unhandled
    // rejection solely through this coordination promise.
    void pendingAdmission.catch(() => undefined);
    this.pendingAdmissions.set(key, pendingAdmission);
    // The FIRST caller's executionId becomes the pooled boundary's id. It only
    // forms paths and log labels (the security identity is `generation`), so
    // reusing it is safe — and it keeps `[zsr] admitted …` lines and session
    // directories named after the work that actually created the boundary
    // (`probe-codex-…`, `title-…`) instead of an opaque pool handle.
    const executionId = request.executionId;
    let admissionFailed = false;
    let unownedBoundary: PreparedBoundary | null = null;
    try {
      const boundary = await this.options.prepare(request);
      unownedBoundary = boundary;
      attachBoundaryTerritoryContributions(boundary, territoryContributions);
      if (
        this.disposed ||
        transitionCrossed() ||
        this.workspaceTerritorySuspended(territoryContributions)
      ) {
        // disposeAll may have completed and reopen() may already have cleared the
        // boolean while prepare() was still building this boundary. The epoch is
        // the durable proof that it crossed a territory transition. Retire it
        // before any provider operation can receive the capability.
        unownedBoundary = null;
        await this.options.retire(executionId, boundary);
        throw new Error(
          "utility boundary admission was invalidated by a territory transition",
        );
      }
      entry = {
        key,
        executionId,
        boundary,
        territoryContributions,
        generation: String(boundary.generation),
        tail: Promise.resolve(),
        busy: false,
      };
      this.entries.set(key, entry);
      unownedBoundary = null;
      // lease() marks the entry busy before the admission reservation wakes a
      // waiter in finally, so the waiter queues behind this exact first lease.
      return this.lease(entry, false);
    } catch (error) {
      let failure = error;
      if (unownedBoundary) {
        const rejectedBoundary = unownedBoundary;
        unownedBoundary = null;
        try {
          await this.options.retire(executionId, rejectedBoundary);
        } catch (teardownError) {
          failure = new AggregateError(
            [error, teardownError],
            "utility boundary admission failed and teardown could not be proven",
          );
        }
      }
      admissionFailed = true;
      rejectAdmission(failure);
      throw failure;
    } finally {
      if (!admissionFailed) resolveAdmission();
      if (this.pendingAdmissions.get(key) === pendingAdmission) {
        this.pendingAdmissions.delete(key);
      }
    }
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
          if (
            outcome === "failed" ||
            this.disposed ||
            entry.retiring ||
            this.entries.get(entry.key) !== entry ||
            this.workspaceTerritorySuspended(entry.territoryContributions)
          ) {
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
        // retire callback has already recorded this exact boundary for retry.
        // Nothing here may reuse it or create an unhandled timer rejection.
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
        // gateway now owns the un-proven exact boundary through its retry map, and
        // reusing it here would be the one genuinely unsafe move available.
        if (this.entries.get(entry.key) === entry) {
          this.entries.delete(entry.key);
        }
      }
    })();
    entry.retiring = flight;
    return flight;
  }

  /** Retire every pooled boundary now (territory transition, engine stop).
   * Busy entries are revoked/stopped too: returning while provider bytes still
   * run under the old immutable map would let a registry mutation outrun its
   * own authority drain. The holder's later release shares the same retirement
   * promise. Rejects if any teardown could not be proven. */
  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.lifecycleEpoch += 1;
    const errors: unknown[] = [];
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
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

  /** Close admission for one exact managed owner before its pointer or
   * recognized Design roots change. This is synchronous so no matching cold
   * admission can cross the caller's first await. */
  suspendWorkspaceTerritory(workspaceRoot: string): void {
    const root = path.resolve(workspaceRoot);
    this.suspendedWorkspaceTerritories.set(
      root,
      (this.suspendedWorkspaceTerritories.get(root) ?? 0) + 1,
    );
    this.workspaceTerritoryEpoch += 1;
    this.workspaceTerritoryEpochs.set(
      root,
      (this.workspaceTerritoryEpochs.get(root) ?? 0) + 1,
    );
  }

  /** Prove every pooled boundary that depends on one managed workspace has
   * stopped. Unrelated provider probes/titles remain warm and usable. */
  async disposeWorkspaceTerritory(workspaceRoot: string): Promise<void> {
    const root = path.resolve(workspaceRoot);
    const errors: unknown[] = [];
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) =>
          this.territoryContributionsInclude(
            entry.territoryContributions,
            root,
          ),
        )
        .map(async (entry) => {
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
            "pooled utility boundaries for this workspace could not all be proven stopped",
          );
    }
  }

  resumeWorkspaceTerritory(workspaceRoot: string): void {
    const root = path.resolve(workspaceRoot);
    const count = this.suspendedWorkspaceTerritories.get(root) ?? 0;
    if (count <= 1) {
      this.suspendedWorkspaceTerritories.delete(root);
    } else {
      this.suspendedWorkspaceTerritories.set(root, count - 1);
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

  territoryContributionSnapshots(): readonly (
    | readonly BoundaryTerritoryContributionSnapshot[]
    | undefined
  )[] {
    return [...this.entries.values()].map(
      (entry) => entry.territoryContributions,
    );
  }

  private territoryContributionsInclude(
    contributions: readonly BoundaryTerritoryContributionSnapshot[] | undefined,
    workspaceRoot: string,
  ): boolean {
    // A compatibility-era unlabelled utility cannot prove independence, so it
    // follows the restrictive path. Production gateway admissions always pass
    // the explicit contribution snapshot.
    if (contributions === undefined) return true;
    return contributions.some(
      (contribution) =>
        path.resolve(contribution.workspaceRoot) === workspaceRoot,
    );
  }

  private workspaceTerritorySuspended(
    contributions: readonly BoundaryTerritoryContributionSnapshot[] | undefined,
  ): boolean {
    if (this.suspendedWorkspaceTerritories.size === 0) return false;
    if (contributions === undefined) return true;
    return contributions.some((contribution) =>
      this.suspendedWorkspaceTerritories.has(
        path.resolve(contribution.workspaceRoot),
      ),
    );
  }

  /** Whether any prepared utility boundary was admitted under a different
   * app-wide registered Design subtraction. `undefined` is conservative: an
   * unlabelled/legacy boundary cannot prove that it is current. */
  registeredDesignAuthorityChanged(identity: string | null): boolean {
    for (const entry of this.entries.values()) {
      if (entry.boundary.registeredDesignAuthorityIdentity !== identity) {
        return true;
      }
    }
    return false;
  }
}

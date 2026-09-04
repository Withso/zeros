// ──────────────────────────────────────────────────────────
// warm-session-boundary-pool.ts — optional pre-admitted session boundaries
// ──────────────────────────────────────────────────────────
//
// A spare can make the next byte-identical admission instant, but preparing it
// is not free: it creates another process domain, broker, session directory,
// and behavioral canary. Live traces showed that speculative work competing
// with the first real provider turn cost seconds while saving only tens to a
// few hundred milliseconds on the next boundary. It is therefore OFF by
// default and retained as an explicit diagnostics/benchmark switch only.
//
// The safety argument, stated plainly:
//
//  1. ADOPTION IS POLICY-IDENTICAL AND FRESHNESS-PROVEN BY CONSTRUCTION. The
//     caller builds its BoundaryRequest from scratch at adoption time — fresh
//     territory resolution, fresh symlink/hard-link validation, fresh managed
//     collections — and only a warm boundary whose complete request (minus
//     executionId) and per-owner contribution snapshot hash to the SAME key
//     may be adopted. Anything that would have changed the policy changes the
//     key and misses.
//  2. THE BOUNDARY WAS NEVER USED. Unlike the utility pool (which reuses a
//     boundary between one-shots), a warm entry has hosted nothing but its own
//     admission canary. Adoption hands a session exactly what a cold admission
//     would have handed it, minted earlier.
//  3. TRANSITIONS RETIRE IT. Design-territory suspensions and disposals route
//     through the same gateway methods that close the utility pool, and the
//     entry's contribution snapshot participates in the engine's
//     live-authority checks, so a warm boundary can never carry a superseded
//     Design map across a transition.
//  4. TEARDOWN IS STILL PROVEN. Idle expiry, eviction, disposal, and adoption
//     failure all route through the same proven-teardown callback sessions
//     use; an unprovable teardown remains scoped to that exact spare.
// ──────────────────────────────────────────────────────────

import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  attachBoundaryTerritoryContributions,
  pooledBoundaryRequestKey,
} from "./utility-boundary-pool";
import type {
  BoundaryRequest,
  BoundaryTerritoryContributionSnapshot,
  PreparedBoundary,
} from "./types";

/** How long a warm boundary is kept before it is proven torn down. Long
 * enough to cover "close a chat, open the next one", short enough that a
 * forgotten workspace does not hold a process domain and Git broker open. */
export const WARM_SESSION_BOUNDARY_IDLE_MS_DEFAULT = 300_000;

/** At most this many distinct warm shapes at once (LRU-evicted). Each entry
 * holds a live process domain, broker socket, and session directory. */
const MAX_WARM_SESSION_BOUNDARIES = 3;

/** Cooldown after a failed background admission, so a persistently failing
 * provider (stale auth, broken backend) cannot turn every session start into
 * a background retry storm. */
const REPLENISH_FAILURE_COOLDOWN_MS = 60_000;

function warmSessionBoundaryIdleMs(): number {
  const configured = Number.parseInt(
    process.env.ZEROS_ZSR_WARM_SESSION_IDLE_MS ?? "",
    10,
  );
  return Number.isInteger(configured) && configured >= 0
    ? configured
    : WARM_SESSION_BOUNDARY_IDLE_MS_DEFAULT;
}

export function warmSessionBoundariesEnabled(): boolean {
  return (
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES === "1" &&
    warmSessionBoundaryIdleMs() > 0
  );
}

interface WarmEntry {
  readonly key: string;
  readonly executionId: string;
  readonly boundary: PreparedBoundary;
  readonly territoryContributions:
    | readonly BoundaryTerritoryContributionSnapshot[]
    | undefined;
  readonly registeredDesignAuthorityIdentity: string | null;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface WarmSessionBoundaryPoolOptions {
  /** Admit a boundary for this exact request (the same admission path a cold
   * session uses, canary included). */
  readonly prepare: (request: BoundaryRequest) => Promise<PreparedBoundary>;
  /** Prove the boundary stopped and clean up its session directory. Failures
   * must latch exactly as a session teardown failure would. */
  readonly retire: (
    executionId: string,
    boundary: PreparedBoundary,
  ) => Promise<void>;
  readonly idleMs?: number;
}

export class WarmSessionBoundaryPool {
  private readonly entries = new Map<string, WarmEntry>();
  private readonly pendingKeys = new Set<string>();
  private readonly failureCooldowns = new Map<string, number>();
  private readonly suspendedWorkspaceTerritories = new Map<string, number>();
  private globalSuspensions = 0;
  private lifecycleEpoch = 0;
  private disposed = false;

  constructor(private readonly options: WarmSessionBoundaryPoolOptions) {}

  /** Hand over a warm boundary for a freshly built request, or null. The
   * entry leaves the pool permanently; the caller owns proven teardown. */
  adopt(
    request: BoundaryRequest,
    territoryContributions:
      | readonly BoundaryTerritoryContributionSnapshot[]
      | undefined,
  ): { boundary: PreparedBoundary; warmExecutionId: string } | null {
    if (this.disposed || this.globalSuspensions > 0) return null;
    if (this.workspaceTerritorySuspended(territoryContributions)) return null;
    const key = pooledBoundaryRequestKey(request, territoryContributions);
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    return { boundary: entry.boundary, warmExecutionId: entry.executionId };
  }

  /** Pre-admit one spare boundary for this shape in the background. Failures
   * are contained (logged by the caller-provided prepare/retire); the next
   * session simply admits cold. */
  async replenish(
    request: BoundaryRequest,
    territoryContributions:
      | readonly BoundaryTerritoryContributionSnapshot[]
      | undefined,
    registeredDesignAuthorityIdentity: string | null,
  ): Promise<void> {
    if (this.disposed || this.globalSuspensions > 0) return;
    if (!warmSessionBoundariesEnabled()) return;
    if (this.workspaceTerritorySuspended(territoryContributions)) return;
    const key = pooledBoundaryRequestKey(request, territoryContributions);
    if (this.entries.has(key) || this.pendingKeys.has(key)) return;
    const cooldownUntil = this.failureCooldowns.get(key) ?? 0;
    if (Date.now() < cooldownUntil) return;
    const requestedEpoch = this.lifecycleEpoch;
    // The warm boundary's on-disk artifacts (policy tree, session dir) are
    // named by THIS id. After adoption the gateway tracks the boundary under
    // the session's own id, but teardown still removes the `warm-…` dir because
    // ZSR stopAndProve cleans its own request.executionId. That coupling is
    // load-bearing: a teardown that cleaned the gateway-passed id instead would
    // orphan every adopted boundary's `warm-…` directory.
    const executionId = `warm-${randomUUID()}`;
    this.pendingKeys.add(key);
    let unownedBoundary: PreparedBoundary | null = null;
    try {
      const boundary = await this.options.prepare({ ...request, executionId });
      unownedBoundary = boundary;
      attachBoundaryTerritoryContributions(boundary, territoryContributions);
      if (boundary.registeredDesignAuthorityIdentity === undefined) {
        Object.defineProperty(boundary, "registeredDesignAuthorityIdentity", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: registeredDesignAuthorityIdentity,
        });
      } else if (
        boundary.registeredDesignAuthorityIdentity !==
        registeredDesignAuthorityIdentity
      ) {
        throw new Error("prepared boundary registered authority is stale");
      }
      if (
        this.disposed ||
        requestedEpoch !== this.lifecycleEpoch ||
        this.workspaceTerritorySuspended(territoryContributions)
      ) {
        unownedBoundary = null;
        await this.options.retire(executionId, boundary);
        return;
      }
      const entry: WarmEntry = {
        key,
        executionId,
        boundary,
        territoryContributions,
        registeredDesignAuthorityIdentity,
      };
      this.entries.set(key, entry);
      unownedBoundary = null;
      this.armIdle(entry);
      this.failureCooldowns.delete(key);
      while (this.entries.size > MAX_WARM_SESSION_BOUNDARIES) {
        const oldestKey = this.entries.keys().next();
        if (oldestKey.done) break;
        const oldest = this.entries.get(oldestKey.value);
        this.entries.delete(oldestKey.value);
        if (oldest) await this.retireEntry(oldest);
      }
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
            "warm session boundary admission failed and teardown could not be proven",
          );
        }
      }
      this.failureCooldowns.set(
        key,
        Date.now() + REPLENISH_FAILURE_COOLDOWN_MS,
      );
      console.warn(
        `[agents] warm session boundary admission failed (next session admits cold): ` +
          (failure instanceof Error ? failure.message : String(failure)),
      );
    } finally {
      this.pendingKeys.delete(key);
    }
  }

  private armIdle(entry: WarmEntry): void {
    const timer = setTimeout(() => {
      if (this.entries.get(entry.key) !== entry) return;
      this.entries.delete(entry.key);
      void this.retireEntry(entry).catch(() => undefined);
    }, this.options.idleMs ?? warmSessionBoundaryIdleMs());
    timer.unref?.();
    entry.idleTimer = timer;
  }

  private async retireEntry(entry: WarmEntry): Promise<void> {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await this.options.retire(entry.executionId, entry.boundary);
    } catch {
      // Swallow rather than rethrow, deliberately: disposeAll runs BEFORE the
      // utility pool's disposal in the gateway, and one warm teardown failure
      // must not skip that. Fail-closed is preserved by the retire callback,
      // which records the exact entry in the gateway's
      // failedBoundaryRetirements while its recovery loop retries the proof.
      // A warm boundary hosts no provider process (only its exited
      // admission canary), so a failed proof here is an fs-cleanup failure, not
      // a live escape.
    }
  }

  /** Retire every warm boundary now. Rejections from proofs are owned by the
   * retire callback's latch; this drains the pool regardless. */
  async disposeAll(): Promise<void> {
    this.lifecycleEpoch += 1;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.retireEntry(entry)));
  }

  /** Permanently stop pre-admitting (engine dispose). */
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.disposeAll();
  }

  /** Close/reopen adoption AND pre-admission app-wide across a global
   * registered-owner transaction. Counted so queued transactions compose. */
  suspendGlobal(): void {
    this.globalSuspensions += 1;
    this.lifecycleEpoch += 1;
  }

  resumeGlobal(): void {
    if (this.globalSuspensions > 0) this.globalSuspensions -= 1;
  }

  suspendWorkspaceTerritory(workspaceRoot: string): void {
    const root = path.resolve(workspaceRoot);
    this.suspendedWorkspaceTerritories.set(
      root,
      (this.suspendedWorkspaceTerritories.get(root) ?? 0) + 1,
    );
    this.lifecycleEpoch += 1;
  }

  async disposeWorkspaceTerritory(workspaceRoot: string): Promise<void> {
    const root = path.resolve(workspaceRoot);
    const matching = [...this.entries.values()].filter((entry) =>
      this.territoryContributionsInclude(entry.territoryContributions, root),
    );
    for (const entry of matching) this.entries.delete(entry.key);
    await Promise.all(matching.map((entry) => this.retireEntry(entry)));
  }

  resumeWorkspaceTerritory(workspaceRoot: string): void {
    const root = path.resolve(workspaceRoot);
    const count = this.suspendedWorkspaceTerritories.get(root) ?? 0;
    if (count <= 1) this.suspendedWorkspaceTerritories.delete(root);
    else this.suspendedWorkspaceTerritories.set(root, count - 1);
  }

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

  registeredDesignAuthorityChanged(identity: string | null): boolean {
    for (const entry of this.entries.values()) {
      if (entry.registeredDesignAuthorityIdentity !== identity) return true;
    }
    return false;
  }

  private territoryContributionsInclude(
    contributions: readonly BoundaryTerritoryContributionSnapshot[] | undefined,
    workspaceRoot: string,
  ): boolean {
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
}

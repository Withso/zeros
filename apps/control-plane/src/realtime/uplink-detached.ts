import { UplinkAuthHealthRequestSchema, type UplinkAuthHealthRequest } from "./uplink-protocol.js";
import type { UplinkExtension, UplinkSession } from "./uplink-server.js";

export const DETACHED_HEALTH_CADENCE_MS = 5_000;
export const DETACHED_HEALTH_WINDOW_MS = 10_000;
/** Process-wide cadence: at most one shared observation per five seconds under
 * fan-in, and no additional reads at all without active detached work. */
export const DETACHED_HEALTH_BATCH_MS = 5_000;
const OBSERVATION_BOUND_MS = 5_000;

type Entry = { session: UplinkSession; pending: boolean; live: boolean; syncId: string | null };
type Request = { entry: Entry; frame: UplinkAuthHealthRequest; revision: number };

/** A D4 response is evidence from the authority sources, not socket liveness.
 * Callers arriving during an observation join the NEXT batch: a positive
 * response always observes sources after its own challenge was received. */
export class UplinkDetachedHealth implements UplinkExtension {
  readonly feature = "detached.v1";
  readonly flag = "detached_turns";
  private readonly entries = new Map<string, Entry>();
  private waiting = new Map<string, Request>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastObservationAt = -Infinity;
  private stopped = false;
  private lossRevision = 0;
  private readonly now: () => number;
  constructor(private readonly options: { observe(): Promise<boolean>; current(): boolean; now?: () => number }) {
    this.now = options.now ?? (() => performance.now());
  }

  onOpen(session: UplinkSession): void {
    this.entries.set(session.connectionId, { session, pending: false, live: true, syncId: session.authState?.()?.syncId ?? null });
  }
  onClose(session: UplinkSession): void {
    const entry = this.entries.get(session.connectionId);
    if (entry) entry.live = false;
    this.entries.delete(session.connectionId); this.waiting.delete(session.connectionId);
    if (!this.waiting.size && this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
  onFrame(session: UplinkSession, t: string, d: Record<string, unknown>): boolean | "invalid" {
    if (t !== "auth.health_request") return false;
    const parsed = UplinkAuthHealthRequestSchema.safeParse(d);
    if (!parsed.success || parsed.data.connectionId !== session.connectionId) return "invalid";
    const entry = this.entries.get(session.connectionId), state = session.authState?.();
    if (!entry || this.stopped) return true;
    const frame = parsed.data;
    if (!state || state.syncId !== frame.syncId || state.authCursor !== frame.authCursor || entry.pending) {
      session.sendControl?.("auth.health", { ...frame, healthy: false }); return true;
    }
    // One pending challenge plus the global five-second cadence also bounds
    // early arrivals. Small network jitter must not revoke healthy work.
    entry.pending = true; entry.syncId = state.syncId;
    this.waiting.set(session.connectionId, { entry, frame, revision: state.revision });
    this.schedule();
    return true;
  }
  /** Known loss cuts eligibility immediately, including while a source read
   * is stalled. The engine independently bounds undetected loss to 10 s. */
  invalidate(): void {
    this.lossRevision += 1;
    for (const { session, syncId } of this.entries.values()) {
      if (syncId) session.sendControl?.("auth.health_lost", { connectionId: session.connectionId, syncId });
    }
  }
  stop(): void {
    this.stopped = true; this.invalidate();
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.entries.values()) entry.live = false;
    this.entries.clear(); this.waiting.clear();
  }
  private schedule(): void {
    if (this.stopped || this.running || this.timer || !this.waiting.size) return;
    // The first batch is immediate; later arrivals wait for the next shared
    // slot. A fixed five-second delay on every reply would leave no margin
    // before the engine's ten-second request-start deadline.
    this.timer = setTimeout(() => { this.timer = null; void this.observe(); },
      Math.max(0, this.lastObservationAt + DETACHED_HEALTH_BATCH_MS - this.now()));
    this.timer.unref?.();
  }
  private async observe(): Promise<void> {
    if (this.stopped || !this.waiting.size) return;
    const batch = this.waiting; this.waiting = new Map(); this.running = true;
    this.lastObservationAt = this.now();
    const revision = this.lossRevision;
    let expired = false;
    const timeout = setTimeout(() => { expired = true; this.invalidate(); }, OBSERVATION_BOUND_MS);
    timeout.unref?.();
    let healthy = false;
    try { healthy = await this.options.observe(); } catch { this.invalidate(); }
    finally { clearTimeout(timeout); }
    // Keep the flight occupied until it actually settles, even on timeout.
    // A hung DB pool cannot multiply retained callbacks or queued queries.
    healthy = healthy && !expired && !this.stopped && revision === this.lossRevision && this.options.current();
    for (const { entry, frame, revision: authRevision } of batch.values()) {
      entry.pending = false;
      if (!entry.live) continue;
      const state = entry.session.authState?.();
      entry.session.sendControl?.("auth.health", { ...frame, healthy: healthy && state?.revision === authRevision &&
        state.syncId === frame.syncId && state.authCursor === frame.authCursor });
    }
    this.running = false; this.schedule();
  }
}

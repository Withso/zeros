import { randomUUID } from "node:crypto";
import type { AcceptedWorkPushHealth } from "./agents/cloud-accepted-work-authority";

/** S2 1.4 detached.v1. These are independent of socket pongs, API
 * heartbeat, cached auth readiness and S1's ordinary outage grace. */
export const DETACHED_HEALTH_CADENCE_MS = 5_000;
export const DETACHED_HEALTH_WINDOW_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type DetachedPushConnection = { connectionId: string; syncId: string; authCursor: string; revision: number;
  send(t: string, d: Record<string, unknown>): boolean };
type Challenge = { id: string; start: number; revision: number; cursor: string };

/** One per cloud execution owner. Only durably accepted work retains it;
 * no work means no timer, health requests or additional authority reads. */
export class CloudDetachedPushHealth implements AcceptedWorkPushHealth {
  private connection: DetachedPushConnection | null = null;
  private challenge: Challenge | null = null;
  private until: number | null = null;
  private lastRequestAt = -Infinity;
  private users = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly now: () => number = () => performance.now()) {}

  retain(): () => void {
    if (this.users >= 256) throw new Error("accepted_work_limit");
    this.users += 1; this.tick();
    let live = true;
    return () => {
      if (!live) return;
      live = false; this.users -= 1;
      if (!this.users) { this.cancelTimer(); this.challenge = null; this.until = null; }
    };
  }
  deadline(): number | null { return this.until !== null && this.now() < this.until ? this.until : null; }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  connect(connection: DetachedPushConnection | null): void {
    if (this.connection?.connectionId === connection?.connectionId && this.connection?.syncId === connection?.syncId) {
      this.connection = connection; return;
    }
    this.connection = connection; this.challenge = null;
    this.lose(); this.tick();
  }
  /** Called on the same serialized auth chain after all earlier writes
   * have landed. A late frame from a retired connection never reaches it. */
  receive(t: string, d: Record<string, unknown>): boolean {
    if (t !== "auth.health" && t !== "auth.health_lost") return false;
    const connection = this.connection;
    if (!connection || d.connectionId !== connection.connectionId || d.syncId !== connection.syncId) return true;
    if (t === "auth.health_lost") { this.challenge = null; this.lose(); this.tick(); return true; }
    if (typeof d.challengeId !== "string" || !UUID.test(d.challengeId) || typeof d.healthy !== "boolean" ||
      typeof d.authCursor !== "string" || d.authCursor.length < 1 || d.authCursor.length > 256) {
      this.challenge = null; this.lose(); this.tick(); return true;
    }
    const challenge = this.challenge;
    if (!challenge || d.challengeId !== challenge.id) return true;
    this.challenge = null;
    if (!d.healthy || challenge.revision !== connection.revision || challenge.cursor !== connection.authCursor ||
        d.authCursor !== challenge.cursor || this.now() >= challenge.start + DETACHED_HEALTH_WINDOW_MS) this.lose();
    else { this.until = challenge.start + DETACHED_HEALTH_WINDOW_MS; this.emit(); }
    this.tick(); return true;
  }
  private lose(): void { this.until = null; this.emit(); }
  private emit(): void { for (const listener of [...this.listeners]) listener(); }
  private cancelTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private tick(): void {
    this.cancelTimer();
    if (!this.users || !this.connection) return;
    const now = this.now();
    if (this.until !== null && now >= this.until) this.lose();
    if (!this.users) return; // deadline notification may retire the last work
    if (this.challenge && now >= this.challenge.start + DETACHED_HEALTH_WINDOW_MS) this.challenge = null;
    if (!this.challenge && now >= this.lastRequestAt + DETACHED_HEALTH_CADENCE_MS) {
      const connection = this.connection;
      const challenge = { id: randomUUID(), start: now, cursor: connection.authCursor, revision: connection.revision };
      this.lastRequestAt = now; this.challenge = challenge;
      if (!connection.send("auth.health_request", { connectionId: connection.connectionId, syncId: connection.syncId,
        challengeId: challenge.id, authCursor: challenge.cursor })) { this.challenge = null; this.lose(); }
    }
    if (!this.users || !this.connection) return;
    const next = Math.min(this.until ?? Infinity, this.challenge ? this.challenge.start + DETACHED_HEALTH_WINDOW_MS :
      this.lastRequestAt + DETACHED_HEALTH_CADENCE_MS);
    this.timer = setTimeout(() => this.tick(), Math.max(1, next - this.now())); this.timer.unref?.();
  }
}

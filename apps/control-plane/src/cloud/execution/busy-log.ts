import type { ActorBusyReason } from "./errors.js";

/** One journal line per workspace and reason per minute, with how many refusals it stands for: a busy loop is visible
 * without its retries flooding the log. */
export class BusyLog {
  private readonly seen = new Map<string, { at: number; count: number }>();
  constructor(private readonly logger?: Pick<Console, "warn">, private readonly now: () => number = Date.now, private readonly windowMs = 60_000) {}

  /** reason: an ActorBusy reason, or another closed code (begin_lease records why a begin carried no lease). */
  record(route: string, workspaceId: string, reason: ActorBusyReason | string): void {
    const key = `${route}:${workspaceId}:${reason}`, now = this.now(), entry = this.seen.get(key);
    if (entry && now - entry.at < this.windowMs) { entry.count++; return; }
    this.logger?.warn(`[cloud-v2] ${route} busy reason=${reason} workspace=${workspaceId.slice(0, 8)}${entry ? ` refusals=${entry.count + 1}` : ""}`);
    this.seen.set(key, { at: now, count: 0 });
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
  }
}

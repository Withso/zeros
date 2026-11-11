import type pg from "pg";
import { postgresNotificationSubscription } from "../../postgres-notifications.js";
import { HttpError } from "../../authz.js";

export type TeamHint = "changed" | "presence" | "authority" | "gap";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CloudTeamSignals {
  private readonly listeners = new Map<string,Set<(hint: TeamHint) => void>>();
  private count = 0;
  private readonly subscription;
  constructor(pool: pg.Pool) {
    this.subscription = postgresNotificationSubscription(pool,{
      channels: ["zeros_cloud_v2_team","zeros_cloud_v2_presence","zeros_security_event","zeros_cloud_github_access"],
      onDisconnect: () => this.all("gap"),
      onNotification: notice => {
        if (notice.channel === "zeros_security_event" || notice.channel === "zeros_cloud_github_access") { this.all("authority"); return; }
        const id = notice.payload ?? "";
        if (!UUID.test(id)) return;
        for (const listener of this.listeners.get(id) ?? []) listener(notice.channel === "zeros_cloud_v2_presence" ? "presence" : "changed");
      },
    });
  }
  private all(hint: TeamHint) { for (const listeners of this.listeners.values()) for (const listener of listeners) listener(hint); }
  subscribe(id: string, listener: (hint: TeamHint) => void): () => void {
    if (this.count>=1024) throw new HttpError(429,"rate_limited","Too many workspace streams");
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id,listeners); this.count++;
    return () => { if (listeners.delete(listener)) this.count--; if (!listeners.size) this.listeners.delete(id); };
  }
  start() { return this.subscription.start(); }
  healthy() { return this.subscription.healthy(); }
  async close() { this.all("gap"); await this.subscription.stop(); }
}

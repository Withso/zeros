import type pg from "pg";
import { postgresNotificationSubscription, type PostgresNotificationSubscription } from "../../postgres-notifications.js";
import { CloudV2PromptSignals } from "../prompt-signals.js";
import { HttpError } from "../../authz.js";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
export const deviceSignal = (userId: string, deviceId: string) => `device:${userId}:${deviceId}`;
export const requestSignal = (workspaceId: string, requestId: string) => `request:${workspaceId}:${requestId}`;

/** This adds a channel to the existing LISTEN session, not a connection per
 * Mac. Hints only wake readers; the durable row still owns every decision. */
export class CloudLocalCommandSignals {
  private readonly signals = new CloudV2PromptSignals();
  private readonly changes = new Set<() => void>();
  private readonly listener: PostgresNotificationSubscription;
  constructor(pool: pg.Pool) {
    this.listener = postgresNotificationSubscription(pool, {
      channels: ["zeros_local_commands", "zeros_security_event"],
      onReady: () => { this.signals.wakeAll(); for (const notify of this.changes) notify(); }, onDisconnect: () => this.signals.wakeAll(),
      onNotification: notification => {
        for (const notify of this.changes) notify();
        if (notification.channel === "zeros_security_event") { this.signals.wakeAll(); return; }
        try {
          const value: unknown = JSON.parse(notification.payload ?? "");
          if (!value || typeof value !== "object") return;
          if ("userId" in value && "deviceId" in value && uuid(value.userId) && uuid(value.deviceId)) this.signals.wake(deviceSignal(value.userId, value.deviceId));
          if ("workspaceId" in value && "requestId" in value && uuid(value.workspaceId) && uuid(value.requestId)) this.signals.wake(requestSignal(value.workspaceId, value.requestId));
        } catch { /* A malformed hint cannot authorize delivery or execution. */ }
      },
    });
  }
  start() { return this.listener.start(); }
  subscribe(notify: () => void) { this.changes.add(notify); return () => { this.changes.delete(notify); }; }
  healthy() { return this.listener.healthy(); }
  wait(key: string, milliseconds: number, signal: AbortSignal) {
    try { return this.signals.wait(key, milliseconds, signal); }
    catch (error) {
      if (error instanceof HttpError && error.status === 429) throw new HttpError(429,"local_commands_limited","Too many local command channels or waits");
      throw error;
    }
  }
  async close() { this.signals.wakeAll(); await this.listener.stop(); }
}

import type pg from "pg";
import { z } from "zod";

import { postgresNotificationSubscription } from "../postgres-notifications.js";
import type { DeviceStreamServer } from "./device-stream-server.js";

/** Migration 0154: `<workspace uuid>:<catalog version>` on every committed
 * workspace document version change, insert and hard delete. */
export const DEVICE_STREAM_CATALOG_CHANNEL = "zeros_cloud_workspace_catalog";
const PAYLOAD = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[1-9][0-9]{0,18}$/;

/** `DatabaseUplinkTurnStore`: a validated `DeviceStreamNotification` JSON for
 * a turn's first terminal transition. Titles carry no content. */
export const DEVICE_STREAM_TURN_CHANNEL = "zeros_cloud_turn_notifications";
const turnIdentity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const DeviceStreamTurnNotificationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["turn.completed", "turn.failed", "turn.needs_attention"]),
  workspaceId: z.string().uuid(),
  chatId: turnIdentity,
  turnId: turnIdentity,
  title: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
}).strict();

export function handleDeviceStreamNotification(server: Pick<DeviceStreamServer, "workspaceChanged" | "publishNotification">,
  channel: string, payload: string): void {
  if (channel === DEVICE_STREAM_TURN_CHANNEL) {
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return; }
    const notification = DeviceStreamTurnNotificationSchema.safeParse(value);
    if (notification.success) server.publishNotification(notification.data);
    return;
  }
  if (channel !== DEVICE_STREAM_CATALOG_CHANNEL) return;
  const match = PAYLOAD.exec(payload);
  if (match) server.workspaceChanged(match[1]!);
}

/** Shares the process's LISTEN session. Every ready, the first included,
 * re-reads every connected account: the server admits streams before LISTEN
 * is up, so a hint committed before then is repaired from the durable rows
 * like one lost while the listener was down. */
export function startDeviceStreamNotifications(pool: pg.Pool, server: DeviceStreamServer,
  logger: Pick<Console, "warn"> = console): () => Promise<void> {
  const listener = postgresNotificationSubscription(pool, {
    channels: [DEVICE_STREAM_CATALOG_CHANNEL, DEVICE_STREAM_TURN_CHANNEL],
    onNotification: notice => handleDeviceStreamNotification(server, notice.channel, notice.payload ?? ""),
    onReady: () => server.refreshEverything(),
    onUnavailable: () => logger.warn("[realtime] device stream catalog notifications unavailable; relying on security events and reconnects"),
  });
  void listener.start().catch(() => {});
  return () => listener.stop();
}

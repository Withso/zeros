import type pg from "pg";

import { postgresNotificationSubscription } from "../postgres-notifications.js";
import type { DatabaseUplinkPresenceStore } from "./uplink-presence.js";
import type { CloudEngineUplinkServer } from "./uplink-server.js";

export const UPLINK_OWNER_CHANNEL = "zeros_cloud_engine_uplink_owner";
export const UPLINK_AUTHORITY_CHANNEL = "zeros_cloud_engine_uplink_authority";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function handleUplinkNotification(server: Pick<CloudEngineUplinkServer, "ownerChanged" | "revalidate" | "revalidateWorkspace">,
  channel: string, payload: string): void {
  if (channel === UPLINK_OWNER_CHANNEL) {
    const [engineInstanceId, connectionId, connectedAt] = payload.split(":");
    const connectedAtMs = Number(connectedAt);
    if (engineInstanceId && connectionId && UUID.test(engineInstanceId) && UUID.test(connectionId) && Number.isSafeInteger(connectedAtMs))
      server.ownerChanged(engineInstanceId, connectionId, connectedAtMs);
    return;
  }
  if (channel !== UPLINK_AUTHORITY_CHANNEL) return;
  const id = payload.slice(2);
  if (!UUID.test(id)) return;
  if (payload.startsWith("e:")) server.revalidate([id]);
  else if (payload.startsWith("w:")) server.revalidateWorkspace(id);
}

/** Shares the process's LISTEN session. After every (re)connect, owners and
 * authority are re-read for every owned uplink, so a notification lost while
 * the listener was down is repaired rather than trusted. */
export function startUplinkNotifications(
  pool: pg.Pool,
  server: CloudEngineUplinkServer,
  presence: Pick<DatabaseUplinkPresenceStore, "owners">,
  logger: Pick<Console, "warn"> = console,
): () => Promise<void> {
  const listener = postgresNotificationSubscription(pool, {
    channels: [UPLINK_OWNER_CHANNEL, UPLINK_AUTHORITY_CHANNEL],
    onNotification: notice => handleUplinkNotification(server, notice.channel, notice.payload ?? ""),
    onReady: () => {
      server.revalidate();
      void presence.owners(server.ownedEngineInstances()).then(rows => {
        for (const row of rows) server.ownerChanged(row.engineInstanceId, row.connectionId, row.connectedAtMs);
      }).catch(() => {});
    },
    onUnavailable: () => logger.warn("[realtime] uplink notifications unavailable; owners and authority rely on the periodic recheck"),
  });
  void listener.start().catch(() => {});
  return () => listener.stop();
}

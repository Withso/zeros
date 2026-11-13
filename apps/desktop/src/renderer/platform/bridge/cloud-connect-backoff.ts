// §14.5: one connect backoff per exact account + organization + workspace, shared by every opener (the runtime
// client's reconnects, the lifecycle's re-attach, explicit opens), so a 503 from POST connect or a relay 1013 is
// never retried on each catalog change. The delay doubles per failure with jitter, grows to at least 30 s, and is
// cleared only by a ready connection.
import { workspaceAccessScope } from "../team-sharing-registry";

const BASE_MS = 1_000, CAP_MS = 60_000, QUIET_MS = 60_000, MAX_RECORDS = 256;
type Record = { failures: number; notBefore: number; firstFailureAt: number };
const records = new Map<string, Record>();

export function cloudConnectBackoffKey(target: { organizationId: string; workspaceId: string }): string {
  return `${workspaceAccessScope() ?? ""}|${target.organizationId}|${target.workspaceId}`;
}

/** Records one failed connect and returns the wait before the next attempt. */
export function recordCloudConnectFailure(key: string, now = Date.now()): number {
  const previous = records.get(key);
  const failures = (previous?.failures ?? 0) + 1;
  const ceiling = Math.min(CAP_MS, BASE_MS * 2 ** (failures - 1));
  const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  records.delete(key);
  records.set(key, { failures, notBefore: now + delay, firstFailureAt: previous?.firstFailureAt ?? now });
  while (records.size > MAX_RECORDS) records.delete(records.keys().next().value!);
  return delay;
}

export function cloudConnectWaitMs(key: string, now = Date.now()): number {
  return Math.max(0, (records.get(key)?.notBefore ?? 0) - now);
}

/** A failing connect stays quiet (no toast) until it has kept failing for a minute. */
export function cloudConnectFailureQuiet(key: string, now = Date.now()): boolean {
  const record = records.get(key);
  return !!record && now - record.firstFailureAt < QUIET_MS;
}

/** Whether connects to this key have failed since its last ready connection. */
export function cloudConnectFailing(key: string): boolean {
  return records.has(key);
}

export function resetCloudConnectBackoff(key: string): void {
  records.delete(key);
}

export function resetCloudConnectBackoffForTests(): void {
  records.clear();
}

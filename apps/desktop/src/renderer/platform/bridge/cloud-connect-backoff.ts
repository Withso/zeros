// Share backoff by account and workspace so catalog changes cannot retry a refused connection early; only readiness resets it.
import { workspaceAccessScope } from "../team-sharing-registry";

const BASE_MS = 1_000, CAP_MS = 60_000, QUIET_MS = 60_000, MAX_RECORDS = 256;
type Record = { failures: number; notBefore: number; firstFailureAt: number };
const records = new Map<string, Record>();

export function cloudConnectBackoffKey(target: { organizationId: string; workspaceId: string }): string {
  return `${workspaceAccessScope() ?? ""}|${target.organizationId}|${target.workspaceId}`;
}

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

/** Suppress user-facing errors during the first minute of continuous failures. */
export function cloudConnectFailureQuiet(key: string, now = Date.now()): boolean {
  const record = records.get(key);
  return !!record && now - record.firstFailureAt < QUIET_MS;
}

export function cloudConnectFailing(key: string): boolean {
  return records.has(key);
}

export function resetCloudConnectBackoff(key: string): void {
  records.delete(key);
}

export function resetCloudConnectBackoffForTests(): void {
  records.clear();
}

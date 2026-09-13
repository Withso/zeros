import {
  providerUsageSnapshotSchema,
  type BrowserSubscriptionProvider,
  type ProviderUsageSnapshot,
} from "@zeros/protocol/provider-auth";
import { nativeInvoke } from "../../platform/runtime";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import {
  persistProviderUsage,
  restoreProviderUsage,
} from "./provider-usage-storage";
export { pruneProviderUsageAccounts } from "./provider-usage-storage";

export const PROVIDER_USAGE_MAX_AGE_MS = 30 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
export const providerUsageCache = new KeyedAsyncCache<ProviderUsageSnapshot>({
  maxEntries: 32,
  initialSnapshot: restoreProviderUsage,
});
const failures = new Map<string, { until: number; error: Error }>();
export function providerUsageKey(
  provider: BrowserSubscriptionProvider,
  method: "account" | "cli",
  accountId: string | undefined,
  authRevision: number,
  identity = "",
): string {
  return JSON.stringify([
    provider,
    method,
    method === "account" ? (accountId ?? null) : null,
    authRevision,
    identity,
  ]);
}
export async function readProviderUsage(
  key: string,
  force = false,
): Promise<ProviderUsageSnapshot> {
  const failed = failures.get(key);
  if (!force && failed && failed.until > Date.now()) throw failed.error;
  const [provider, method, accountId, , identity] = JSON.parse(key) as [
    BrowserSubscriptionProvider,
    "account" | "cli",
    string | null,
    number,
    string,
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (method === "cli" && (!identity || identity === "[null,null]"))
      throw new Error("Usage belongs to a different connection.");
    const raw = await Promise.race([
      nativeInvoke("provider_subscription", {
        provider,
        method,
        action: "usage",
        ...(accountId ? { accountId } : {}),
        ...(identity && identity !== "[null,null]" ? { identity } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Usage request timed out.")),
          25_000,
        );
      }),
    ]);
    const value = providerUsageSnapshotSchema.parse(raw);
    if (
      value.provider !== provider ||
      value.method !== method ||
      (value.accountId ?? null) !== accountId ||
      (identity && identity !== "[null,null]" && value.identity !== identity)
    )
      throw new Error("Usage belongs to a different connection.");
    failures.delete(key);
    persistProviderUsage(key, value);
    return value;
  } catch (error) {
    const safe =
      error instanceof Error ? error : new Error("Usage is unavailable.");
    if (failures.size >= 32) failures.delete(failures.keys().next().value!);
    failures.set(key, {
      until: Date.now() + FAILURE_BACKOFF_MS,
      error: safe,
    });
    throw safe;
  } finally {
    clearTimeout(timer);
  }
}

export function usageResetLabel(
  resetsAt: number | undefined,
  now = Date.now(),
): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "Reset time unavailable";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "Reset pending";
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return days
    ? `Resets in ${days}d${hours % 24 ? ` ${hours % 24}h` : ""}`
    : `Resets in ${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
}

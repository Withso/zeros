import type {
  ProviderUsageRequest,
  ProviderUsageSnapshot,
} from "@zeros/protocol/provider-auth";
import { providerUsageSnapshotSchema } from "@zeros/protocol/provider-auth";
import type {
  ProviderAccountStore,
  StoredProviderAccount,
} from "./provider-account-store";

export type ProviderUsageData = Pick<
  ProviderUsageSnapshot,
  "windows" | "plan" | "organization" | "identity"
>;
type Window = ProviderUsageSnapshot["windows"][number];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const usageText = (value: unknown, max = 100): string | undefined =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\r\n\0]/.test(value)
    ? value.trim()
    : undefined;

function timestamp(value: unknown): number | undefined {
  const parsed =
    typeof value === "string"
      ? /^\d+$/.test(value)
        ? Number(value)
        : Date.parse(value)
      : number(value);
  if (parsed === undefined || !Number.isFinite(parsed) || parsed <= 0)
    return undefined;
  const ms = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  return ms <= 8_640_000_000_000_000 ? ms : undefined;
}
function window(id: Window["id"], percent: unknown, reset: unknown): Window[] {
  const used = number(percent);
  if (used === undefined) return [];
  const resetsAt = timestamp(reset);
  return [
    {
      id,
      usedPercent: Math.max(0, Math.min(100, used)),
      ...(resetsAt ? { resetsAt } : {}),
    },
  ];
}

/** Provider shapes verified against the pinned CLI/SDK. Missing/null windows
 * are not zero usage, and a pooled allowance is never split into made-up pools. */
export function normalizeClaudeUsage(raw: unknown): ProviderUsageData {
  const data = record(raw);
  const primary = record(data.five_hour);
  const weekly = record(data.seven_day);
  return {
    windows: [
      ...window("five-hour", primary.utilization, primary.resets_at),
      ...window("weekly", weekly.utilization, weekly.resets_at),
    ],
  };
}
export function normalizeCodexUsage(raw: unknown): ProviderUsageData {
  const data = record(raw);
  // Explicit durations take precedence over ordering (some plans omit the
  // short window). Unknown durations must not be labelled five-hour/weekly.
  const windows: Window[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const entry = record(data[key]);
    const minutes = entry.windowDurationMins;
    const id =
      minutes === 300 ? "five-hour" : minutes === 10080 ? "weekly" : undefined;
    if (id && !windows.some((w) => w.id === id))
      windows.push(...window(id, entry.usedPercent, entry.resetsAt));
  }
  return {
    windows,
    ...(usageText(data.planType) ? { plan: usageText(data.planType) } : {}),
  };
}
export function normalizeCursorUsage(raw: unknown): ProviderUsageData {
  const data = record(raw);
  const plan = record(data.planUsage);
  const pool = (kind: "auto" | "api", id: Window["id"]) => {
    const used = number(plan[`${kind}PercentUsed`]);
    const spend = number(plan[`${kind}Spend`]);
    const limit = number(plan[`${kind}Limit`]);
    return window(
      id,
      used ??
        (spend !== undefined && limit !== undefined && limit > 0
          ? (spend / limit) * 100
          : undefined),
      data.billingCycleEnd,
    );
  };
  return {
    windows: [...pool("auto", "cursor"), ...pool("api", "third-party")],
  };
}

export interface ProviderUsageDependencies {
  readStore(): ProviderAccountStore;
  readUsage(
    account: StoredProviderAccount | null,
    signal: AbortSignal,
  ): Promise<ProviderUsageData>;
}

/** No credentials or provider response bodies cross IPC. An account switch
 * during a slow read invalidates the response, including A→B→A changes that
 * replaced A's credentials. Reads neither change account selection nor launch
 * a model/session. */
export async function readSelectedProviderUsage(
  request: ProviderUsageRequest,
  deps: ProviderUsageDependencies,
): Promise<ProviderUsageSnapshot> {
  const store = deps.readStore();
  const selected = store.accounts.find(
    (account) => account.id === store.activeId,
  );
  if (
    store.method !== request.method ||
    (request.method === "account" &&
      (!request.accountId ||
        store.activeId !== request.accountId ||
        selected?.state !== "connected")) ||
    (request.method === "cli" &&
      (request.accountId || request.provider === "cursor" || !request.identity))
  ) {
    throw new Error("The connection changed. Refresh to view its usage.");
  }
  const before = JSON.stringify(store);
  let data: ProviderUsageData;
  try {
    data = await deps.readUsage(
      request.method === "account" ? selected! : null,
      AbortSignal.timeout(20_000),
    );
  } catch {
    // Provider errors can echo authorization headers, raw bodies, or paths.
    throw new Error("Usage is unavailable right now. Try refreshing.");
  }
  if (
    JSON.stringify(deps.readStore()) !== before ||
    (request.identity !== undefined && data.identity !== request.identity)
  )
    throw new Error("The connection changed. Refresh to view its usage.");
  return providerUsageSnapshotSchema.parse({
    ...data,
    provider: request.provider,
    method: request.method,
    ...(request.accountId ? { accountId: request.accountId } : {}),
    fetchedAt: Date.now(),
  });
}

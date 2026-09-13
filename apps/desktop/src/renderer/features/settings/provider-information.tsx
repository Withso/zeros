import React, { useEffect, useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import type {
  BrowserSubscriptionProvider,
  ProviderSubscriptionStatus,
} from "@zeros/protocol/provider-auth";
import { Button } from "../../shared/ui";
import { cn } from "../../shared/ui/cn";
import { ZerosSpinner } from "../../shared/ui/loading/zeros-spinner";
import { ProgressBar } from "../../shared/ui/primitives/progress-bar";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { useNativeRuntime } from "../../platform/runtime";
import {
  providerAuthRevision,
  subscribeProviderAuth,
} from "../../platform/provider-auth-state";
import { useCachedRead } from "../../state/use-cached-read";
import {
  PROVIDER_USAGE_MAX_AGE_MS,
  providerUsageCache,
  providerUsageKey,
  readProviderUsage,
  usageResetLabel,
} from "./provider-usage";
import { SUBSCRIPTION_NAMES } from "./subscription-connection-panel";

const vendors = { claude: "Anthropic", codex: "OpenAI", cursor: "Cursor" };
const noSubscription = () => () => {};
const labels = {
  "five-hour": "5-hour limit",
  weekly: "Weekly limit",
  cursor: "Cursor models · Monthly",
  "third-party": "Third-party models · Monthly",
};

export function ProviderInformation({
  provider,
  connected,
  method,
  status,
  surfaceActive,
}: {
  provider: BrowserSubscriptionProvider;
  connected: boolean;
  method: "account" | "cli" | "apiKey";
  status: ProviderSubscriptionStatus | undefined;
  surfaceActive: boolean;
}) {
  const native = useNativeRuntime().ready;
  const revision = useSyncExternalStore(
    surfaceActive ? subscribeProviderAuth : noSubscription,
    providerAuthRevision,
    providerAuthRevision,
  );
  const key =
    connected && method !== "apiKey"
      ? providerUsageKey(
          provider,
          method,
          status?.activeAccountId,
          revision,
          JSON.stringify([status?.email, status?.organization]),
        )
      : null;
  const active = surfaceActive && native && key !== null;
  const read = useCachedRead(providerUsageCache, key, readProviderUsage, {
    enabled: active,
    maxAgeMs: PROVIDER_USAGE_MAX_AGE_MS,
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || !key) return;
    const revalidate = (force = false) => {
      void providerUsageCache
        .load(key, () => readProviderUsage(key), {
          maxAgeMs: PROVIDER_USAGE_MAX_AGE_MS,
          force,
        })
        .catch(() => {});
    };
    // Opening this tab explicitly refreshes the retained snapshot. Concurrent
    // mounts share the same request; hidden surfaces neither poll nor focus-read.
    revalidate(true);
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    const timer = setInterval(
      () => revalidate(true),
      PROVIDER_USAGE_MAX_AGE_MS,
    );
    const onFocus = () => revalidate();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      clearInterval(clock);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, key]);
  const data = connected ? read.data : undefined;
  const coldLoading = active && !data && !read.error;
  const refreshing = active && read.refreshing;
  const subscription = connected && method !== "apiKey" ? status : undefined;
  const organization = data?.organization ?? subscription?.organization;
  const fields = [
    ["Provider", vendors[provider]],
    [
      "Plan",
      connected && method === "apiKey"
        ? "API"
        : (data?.plan ?? subscription?.plan ?? "—"),
    ],
    ["Account", subscription?.email ?? "—"],
    ...(provider === "claude" || organization
      ? [["Org", organization ?? "—"]]
      : []),
  ];
  const windows =
    provider === "cursor"
      ? (["cursor", "third-party"] as const)
      : (["five-hour", "weekly"] as const);
  return (
    <section
      className="border-border1 mt-2 min-w-0 rounded-lg border"
      aria-label={`${SUBSCRIPTION_NAMES[provider]} account information`}
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 p-4 text-sm">
        {fields.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-fg2">{label}</dt>
            <dd className="text-fg1 min-w-0 break-words">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      <div className="border-border1 flex flex-col gap-4 border-t p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-fg1 text-[14px] font-medium">Usage limits</h3>
          <Tooltip label="Refresh usage">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Refresh ${SUBSCRIPTION_NAMES[provider]} usage`}
              aria-busy={refreshing}
              disabled={!active || read.loading || read.refreshing}
              onClick={() => {
                if (active && key)
                  void providerUsageCache
                    .load(key, () => readProviderUsage(key, true), {
                      force: true,
                    })
                    .catch(() => {});
              }}
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  refreshing && "motion-safe:animate-spin",
                )}
                aria-hidden="true"
              />
            </Button>
          </Tooltip>
        </div>
        {coldLoading ? (
          <div
            className="text-fg2 flex items-center gap-2 text-sm"
            role="status"
          >
            <ZerosSpinner size={20} />
            <span>Loading usage limits</span>
          </div>
        ) : (
          data &&
          windows.map((id) => {
            const usage = data?.windows.find((entry) => entry.id === id);
            return (
              <div key={id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-fg1">{labels[id]}</span>
                  <span className="text-fg2 tabular-nums">
                    {usage
                      ? `${Math.round(usage.usedPercent)}% used`
                      : "Not available"}
                  </span>
                </div>
                <ProgressBar
                  value={usage?.usedPercent}
                  aria-label={labels[id]}
                />
                {usage && (
                  <span
                    className="text-fg2 text-xs"
                    title={
                      usage.resetsAt
                        ? new Date(usage.resetsAt).toLocaleString()
                        : undefined
                    }
                  >
                    {usageResetLabel(
                      usage.resetsAt,
                      Math.max(now, data?.fetchedAt ?? 0),
                    )}
                  </span>
                )}
              </div>
            );
          })
        )}
        {read.error && (
          <p className="text-fg2 text-xs" role="status">
            {data
              ? "Could not refresh usage. Showing the last update."
              : "Usage is unavailable right now. Try refreshing."}
          </p>
        )}
        {!connected ? (
          <p className="text-fg2 text-xs">
            Connect to view your plan and usage.
          </p>
        ) : method === "apiKey" ? (
          <p className="text-fg2 text-xs">
            Subscription limits are not available with an API connection.
          </p>
        ) : null}
      </div>
    </section>
  );
}

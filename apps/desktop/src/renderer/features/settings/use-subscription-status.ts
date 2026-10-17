import { useEffect } from "react";
import type { ProviderSubscriptionStatus } from "@zeros/protocol/provider-auth";
import { useNativeRuntime } from "../../platform/runtime";
import { subscribeProviderAuth } from "../../platform/provider-auth-state";
import { useCachedRead } from "../../state/use-cached-read";
import { documentIsVisible, useDocumentActive } from "../../state/use-document-active";
import { isSubscriptionProvider, readSubscription, subscriptionCache } from "./subscription-connection";

type Observation = { users: number; revision: number; stop(): void };
const observations = new Map<string, Observation>();

/** The provider card and its dialog share one observer of external CLI/store
 * changes. Hidden windows retain invalidations but never start native reads. */
function observe(provider: string): () => void {
  let observation = observations.get(provider);
  if (!observation) {
    observation = { users: 0, revision: 0, stop: () => {} };
    const current = observation;
    const invalidate = () => {
      current.revision++;
      subscriptionCache.invalidate(provider);
    };
    const unsubscribe = subscribeProviderAuth(invalidate);
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    observation.stop = () => {
      unsubscribe();
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
    observations.set(provider, observation);
  }
  observation.users++;
  return () => {
    if (--observation.users === 0) {
      observation.stop();
      observations.delete(provider);
    }
  };
}

async function readObservedSubscription(provider: string): Promise<ProviderSubscriptionStatus> {
  const observed = observations.get(provider);
  if (!observed || !documentIsVisible()) {
    // A queued refresh can outlive its visible observer. Keep the retained
    // value stale for reveal rather than marking that skipped probe fresh.
    subscriptionCache.invalidate(provider);
    const retained = subscriptionCache.getSnapshot(provider).data;
    if (retained) return retained;
    throw new Error("Connection checking is inactive.");
  }
  const revision = observed.revision;
  try {
    return await readSubscription(provider);
  } finally {
    const current = observations.get(provider);
    // The native ACK also writes the cache. Preserve an invalidation that
    // arrived during that read so it cannot swallow a newer external login.
    if (!current || current !== observed || current.revision !== revision)
      subscriptionCache.invalidate(provider);
  }
}

export function warmSubscriptionStatus(provider: string): void {
  if (!observations.has(provider) || !documentIsVisible()) return;
  void subscriptionCache.load(provider, () => readObservedSubscription(provider), { maxAgeMs: 15_000 }).catch(() => {});
}

export function useSubscriptionStatus(provider: string, surfaceActive: boolean) {
  const native = useNativeRuntime().ready;
  const active = native && surfaceActive && isSubscriptionProvider(provider);
  const visible = useDocumentActive(active);
  useEffect(() => active ? observe(provider) : undefined, [active, provider]);
  return useCachedRead(subscriptionCache, provider, readObservedSubscription, {
    enabled: visible,
    maxAgeMs: 15_000,
  });
}

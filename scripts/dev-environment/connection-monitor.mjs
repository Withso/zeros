import { setTimeout as delay } from "node:timers/promises";
import { withHostedLease } from "./hosted-state.mjs";

const description = result => ({
  ready: "Dev agent connection references are current.",
  inactive: "Dev connection maintenance stopped because this environment is no longer active.",
})[result.state];

/** Refresh connection authority while the hosted environment remains active. */
export async function monitorHostedAgents({ registry, identity, generation, profile, services, signal, mutation = operation => operation(), watch = true, retry = false, progress = () => {} }) {
  if (!profile.connections?.enabled) return;
  let last, retryOnce = retry;
  while (!signal?.aborted) {
    let result;
    try {
      result = await mutation(() => withHostedLease(registry, identity, async lease => {
        if (lease.state.generation !== generation || lease.state.status !== "ready") return { state: "inactive" };
        return services.agents(lease, { retry: retryOnce });
      }, { signal }));
      retryOnce = false;
      if (result.absent) result = { state: "inactive" };
      const message = description(result);
      if (message && last !== message) { progress(message); last = message; }
      if (result.state === "inactive" || !watch && ["ready"].includes(result.state)) return result;
    } catch (error) {
      if (signal?.aborted) return;
      if (!["DEV_LEASE_BUSY", "DEV_LOCAL_BUSY"].includes(error?.code)) {
        const message = "Dev connection maintenance could not advance; ownership and cleanup receipts were preserved. Check pnpm dev:doctor and retry pnpm dev:agents after resolving provider access.";
        if (last !== message) { progress(message); last = message; }
        if (!watch) throw new Error(message);
      }
    }
    try { await delay(15_000, undefined, { signal }); }
    catch { if (!signal?.aborted) throw new Error("Dev agent monitor interrupted"); }
  }
}

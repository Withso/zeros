import { refuseRetiredDevNativeCanary } from "./native-agent-retirement.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { withHostedLease } from "./hosted-state.mjs";

const description = result => ({
  "sign-in": "Sign in to Zeros Dev. Its configured test organization will be prepared automatically.",
  seeding: "Dev organization prepared; waiting for its connected agents.",
  connections: "Connect an agent in the Dev organization's Settings → Agents to qualify this worker image.",
  testing: `Checking ${result.provider ?? "connected agent"} on a disposable copy of this worker image.`,
  enabled: `${result.provider ?? "Connected agent"} passed its native tests and is enabled for this worker image.`,
  ready: "All currently connected agent kinds are qualified for this worker image.",
  failed: "An agent test needs attention. Its receipt is retained; use pnpm dev:agents --retry for an explicit retry (at most three attempts per connection/image).",
  inactive: "Dev agent checks stopped because this environment is no longer active.",
})[result.state];

/** Connection authority maintenance without a native fixture remains available.
 * Native qualification intent refuses before acquiring a registry lease. */
export async function monitorHostedAgents({ registry, identity, generation, profile, services, signal, mutation = operation => operation(), watch = true, retry = false, progress = () => {} }) {
  if (profile.fixture) refuseRetiredDevNativeCanary();
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
      if (result.state === "inactive" || !watch && ["sign-in", "connections", "ready", "failed"].includes(result.state)) return result;
    } catch (error) {
      if (signal?.aborted) return;
      if (!["DEV_LEASE_BUSY", "DEV_LOCAL_BUSY"].includes(error?.code)) {
        const message = "Dev agent checks could not advance; ownership and cleanup receipts were preserved. Check pnpm dev:doctor and retry pnpm dev:agents after resolving provider access.";
        if (last !== message) { progress(message); last = message; }
        if (!watch) throw new Error(message);
      }
    }
    try { await delay(result?.state === "testing" || result?.state === "enabled" ? 5000 : 15_000, undefined, { signal }); }
    catch { if (!signal?.aborted) throw new Error("Dev agent monitor interrupted"); }
  }
}

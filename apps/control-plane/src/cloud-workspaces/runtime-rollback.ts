import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CloudWorkspaceBackendConfig } from "../config.js";
import { BoatApiClient } from "./boat-client.js";
import type { RuntimeArtifactStore } from "./runtime-artifact-store.js";
import { DatabaseRuntimeRollbackStore, type RuntimeRollbackStopClaim } from "./runtime-rollback-store.js";
import { runRuntimeRollbackEviction, type RuntimeRollbackHandlers, type RuntimeRollbackResult } from "./runtime-rollback-runner.js";
import type { RuntimeRollbackInput } from "./runtime-rollback-contract.js";

export class CloudRuntimeRollbackCache {
  constructor(private readonly options: {
    store: DatabaseRuntimeRollbackStore;
    run(input: RuntimeRollbackInput, handlers: RuntimeRollbackHandlers, signal: AbortSignal): Promise<RuntimeRollbackResult>;
  }) {}

  /** Cache maintenance is optional; paid compute must still stop on every
   * failure. An intervening wake, however, must not stop a new authority. */
  async beforeStop(claim: RuntimeRollbackStopClaim): Promise<boolean> {
    const { store } = this.options;
    const plan = await store.readStop(claim).catch(() => null);
    if (plan) {
      const remaining = Date.parse(plan.expiresAt) - Date.now();
      if (remaining > 5000 && remaining <= 120_000) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), remaining);
        timer.unref();
        try {
          await this.options.run({ schema: "zeros.runtime-rollback-cache/v1", operation: "evict", fence: randomUUID(), ...plan }, {
            retain: offer => store.retain(claim, offer, abort.signal),
            authorize: async () => !abort.signal.aborted && await store.authorize(claim, plan),
          }, abort.signal);
        } catch { /* No ACK or unknown retirement keeps the payload; stop still runs. */ }
        finally { clearTimeout(timer); }
      }
    }
    return store.isStopCurrent(claim);
  }
}

export function createCloudRuntimeRollbackCache(pool: pg.Pool, cloud: CloudWorkspaceBackendConfig,
  artifacts: RuntimeArtifactStore | null): CloudRuntimeRollbackCache | null {
  if (!cloud.boat || cloud.provider !== "boat" || !artifacts) return null;
  const store = new DatabaseRuntimeRollbackStore({ pool, artifacts });
  const client = new BoatApiClient({ apiKey: cloud.apiKey, billingOrg: cloud.boat.billingOrg, timeoutMs: 45_000 });
  return new CloudRuntimeRollbackCache({ store,
    run: (input, handlers, signal) => runRuntimeRollbackEviction(input, handlers, { client, maxOutputBytes: 64 * 1024 }, signal) });
}

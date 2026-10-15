import { hostedGcEligibility, withHostedLease } from "./hosted-state.mjs";
import { archiveHosted } from "./hosted-lifecycle.mjs";
import { assertHostedCleanupTargets } from "./hosted-protection.mjs";
import { createHmac } from "node:crypto";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function targetSha256(state, profile) {
  if (!/^[a-f0-9]{64}$/.test(profile.registry?.encryptionKey ?? "")) throw new Error("Invalid authenticated cleanup profile");
  // Resources can carry credentials: expose only a domain-separated keyed
  // digest, and recheck it under the existing owner/generation lease.
  return createHmac("sha256", Buffer.from(profile.registry.encryptionKey, "hex")).update("zeros-dev:gc-targets:v1\0")
    .update(JSON.stringify(canonical({ owner: state.owner, generation: state.generation, resources: state.resources,
      pendingBuilderDeletions: state.pendingBuilderDeletions ?? [], pendingWorkerDeletions: state.pendingWorkerDeletions ?? [],
      retiredImages: state.retiredImages ?? [], connectionRegistration: state.connectionRegistration ?? null,
      connectionRevocation: state.connectionRevocation ?? null }))).digest("hex");
}

/** Defense in depth around the existing exact-resource adapter guards. */
export const assertHostedGcTargets = assertHostedCleanupTargets;

export async function planHostedGc(store, profile, { owner, generation, now = Date.now(), inventory } = {}) {
  const scan = await store.list({ history: true });
  const entries = scan.records.filter(({ state }) => (!owner || state.owner === owner) && (!generation || state.generation === generation))
    .sort((a, b) => (Date.parse(a.state.gcLastAttemptAt) || 0) - (Date.parse(b.state.gcLastAttemptAt) || 0));
  const plan = { version: 1, plannedAt: new Date(now).toISOString(), entries: [], quarantine: [...scan.quarantine] };
  for (const { state, historical } of entries) {
    let eligibility = hostedGcEligibility(state, profile, now);
    try { assertHostedGcTargets(state, profile); }
    catch { eligibility = { eligible: false, reason: "protected-or-container-mismatch" }; }
    plan.entries.push({ owner: state.owner, generation: state.generation, identity: state.identity, status: state.status,
      historical: Boolean(historical), targetSha256: targetSha256(state, profile), ...eligibility });
  }
  if (inventory) {
    let resources;
    try { resources = await inventory(); }
    catch { resources = []; plan.quarantine.push({ reason: "incomplete-provider-inventory" }); }
    const known = new Set(scan.records.flatMap(({ state }) => [
      `railway:${state.resources.railway?.id}`, `planetscale:${state.resources.planetscale?.name}`,
      `cloudflare:${state.resources.pages?.name}`, ...(state.resources.images ?? []).map(image => `boat:${image.snapshotId}`)]));
    for (const resource of resources) if (!known.has(`${resource.provider}:${resource.id}`)) plan.quarantine.push({ provider: resource.provider, id: resource.id, reason: "no-authenticated-receipt" });
  }
  return plan;
}

/** Same library for interactive CLI and hosted scheduling. Every action rereads
 * its exact generation under the owner lease; a scan never grants ownership. */
export async function applyHostedGc(store, profile, plan, servicesFor, { signal, now = Date.now, ownerBudgetMs = 60_000, runBudgetMs = 10 * 60_000, maxOwners = 32, mutation = (_entry, operation) => operation() } = {}) {
  if (!Number.isSafeInteger(ownerBudgetMs) || ownerBudgetMs < 1 || ownerBudgetMs > 30 * 60_000) throw new Error("Invalid GC owner time budget");
  if (!Number.isSafeInteger(runBudgetMs) || runBudgetMs < 1 || !Number.isSafeInteger(maxOwners) || maxOwners < 1) throw new Error("Invalid GC run budget");
  const results = [], deadline = now() + runBudgetMs;
  for (const entry of plan.entries.filter(row => row.eligible)) {
    signal?.throwIfAborted();
    if (results.length >= maxOwners || now() >= deadline) break;
    try {
      const ownerSignal = globalThis.AbortSignal.any([...(signal ? [signal] : []), globalThis.AbortSignal.timeout(Math.min(ownerBudgetMs, Math.max(1, deadline - now())))]);
      const result = await mutation(entry, () => withHostedLease(store, { owner: entry.owner, identity: entry.identity }, async ownerLease => {
        let lease = ownerLease;
        if (ownerLease.state.generation !== entry.generation) {
          if (!entry.historical || !store.readHistory) throw new Error("Stale GC generation");
          const history = await store.readHistory(entry.owner, entry.generation);
          if (!history || history.state.status !== "archived") throw new Error("Missing archived history");
          let etag = history.etag;
          lease = { ...ownerLease, state: history.state, save: async () => {
            await ownerLease.fence(); etag = await store.writeHistory(history.state, etag);
          } };
        }
        if (!hostedGcEligibility(lease.state, profile, now()).eligible) throw new Error("GC eligibility changed");
        if (entry.targetSha256 !== undefined && entry.targetSha256 !== targetSha256(lease.state, profile)) throw new Error("GC targets changed");
        assertHostedGcTargets(lease.state, profile);
        lease.state.gcLastAttemptAt = new Date(now()).toISOString(); await lease.save();
        const services = await servicesFor(lease.state);
        try { await archiveHosted(lease, profile, services); await services.releaseAdmission?.(lease); }
        finally { services.removeLocalSources?.(); services.close?.(); }
      }, { signal: ownerSignal }));
      if (result?.absent) throw new Error("Scanned GC receipt disappeared; cleanup is unconfirmed");
      results.push({ owner: entry.owner, generation: entry.generation, outcome: "archived-or-retention-reconciled" });
    } catch {
      results.push({ owner: entry.owner, generation: entry.generation, outcome: "unconfirmed" });
    }
  }
  const deferred = plan.entries.filter(row => row.eligible).length - results.length;
  return { complete: !deferred && results.every(row => row.outcome !== "unconfirmed"), deferred, results };
}

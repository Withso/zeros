import { bindHostedProfile } from "./hosted-state.mjs";
import { ensurePlanetScaleBranch, reconcilePlanetScaleRoles } from "./planetscale.mjs";
import { ensureRailwayEnvironment, ensureRailwayDevDomain, reconcileRailwayUpload } from "./railway.mjs";
import { ensureDevPages, ensureDevDns, ensureDevPagesDomain } from "./hosted-cloudflare.mjs";
import { ensureHostedWebhook } from "./hosted-workos.mjs";
import { reconcileDevImageCreates } from "./hosted-image.mjs";
import { retireHostedAgentSsh } from "./hosted-agent-ssh.mjs";
import { assertHostedCleanupTargets } from "./hosted-protection.mjs";

/** Recovery identifies original resources. Absence, elapsed time, HTTP 409/422
 * and provider outages never authorize erasing an uncertain dispatch. */
export async function reconcileHosted(lease, profile, requests = {}) {
  assertHostedCleanupTargets(lease.state, profile);
  bindHostedProfile(lease.state, profile);
  const outcomes = [];
  const tasks = [
    ["planetscale", () => !lease.state.resources.planetscale?.deleted && ensurePlanetScaleBranch(lease, profile.planetscale, requests.ps, { reconcileOnly: true })],
    ["roles", () => reconcilePlanetScaleRoles(lease, profile.planetscale, requests.ps)],
    ["railway", () => !lease.state.resources.railway?.deleted && ensureRailwayEnvironment(lease, profile.railway, requests.railway, { reconcileOnly: true })],
    ["pages", () => !lease.state.resources.pages?.deleted && ensureDevPages(lease, profile, requests.cf, { reconcileOnly: true })],
    ["workos", () => !lease.state.resources.workos?.deleted && ensureHostedWebhook(lease, profile, requests.workos, { reconcileOnly: true })],
    ["images", () => reconcileDevImageCreates(lease, profile, requests.boat)],
    ["agent-ssh", () => retireHostedAgentSsh(lease, profile, requests.railway)],
    ["railway-domain", () => lease.state.resources.railway?.domain && !lease.state.resources.railway.deleted && ensureRailwayDevDomain(lease, profile,
      desired => ensureDevDns(lease, profile.cloudflare, desired, requests.cf, { reconcileOnly: true }), requests.railway, { reconcileOnly: true })],
    ["pages-domain", () => lease.state.resources.pages?.domain && !lease.state.resources.pages.deleted && ensureDevPagesDomain(lease, profile, requests.cf, { reconcileOnly: true })],
    ["railway-upload", async () => {
      if (!await reconcileRailwayUpload(lease, profile.railway, requests.railway)) throw new Error("Unconfirmed Railway upload needs provider evidence or whole-environment archive");
    }],
    ...(lease.state.resources.dns ?? []).filter(record => !record.deleted).map((record, index) => [`dns:${index}`, () => ensureDevDns(lease, profile.cloudflare,
      { name: record.name, type: record.type, content: record.content }, requests.cf, { reconcileOnly: true })]),
  ];
  for (const [resource, operation] of tasks) {
    await lease.fence();
    try { await operation(); outcomes.push({ resource, outcome: "reconciled" }); }
    catch { outcomes.push({ resource, outcome: "unconfirmed" }); }
  }
  lease.state.reconciliations ??= [];
  lease.state.reconciliations = [...lease.state.reconciliations.slice(-19), { at: new Date().toISOString(), outcomes }];
  await lease.save();
  return { complete: outcomes.every(row => row.outcome === "reconciled"), outcomes };
}

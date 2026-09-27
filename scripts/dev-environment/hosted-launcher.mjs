#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceIdentity, developmentHome, privateDirectory, systemEnvironment, acquireWorkspaceLock } from "./state.mjs";
import { cleanupHostedLocalState } from "./hosted-local.mjs";
import { loadHostedProfile, hostedDesktopEnvironment, hostedPublicProfile } from "./hosted-profile.mjs";
import { r2Registry, withHostedLease } from "./hosted-state.mjs";
import { startHosted, archiveHosted } from "./hosted-lifecycle.mjs";
import { hostedServices } from "./hosted-services.mjs";
import { run } from "./processes.mjs";
import { pollProvider } from "./provider-http.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const action = process.argv[2] ?? "start";
const lifecycle = new AbortController();
let releaseDesktop;
const cancel = () => lifecycle.abort(new Error("Dev operation interrupted; its receipt was preserved"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, cancel);

async function main() {
  if (!["start", "backend", "archive", "doctor", "seed"].includes(action)) throw new Error("Use start, backend, archive, doctor or seed");
  const profile = loadHostedProfile(root), identity = workspaceIdentity(root);
  if (action === "start" && process.platform !== "darwin") throw new Error("Zeros Desktop requires macOS. Use pnpm dev:backend to provision and test this checkout's hosted backend from Linux.");
  const directory = privateDirectory(privateDirectory(developmentHome(), "hosted"), identity.owner);
  if (action === "start") releaseDesktop = acquireWorkspaceLock({ directory, state: identity });
  const registry = r2Registry(profile.registry), services = hostedServices(root, directory, profile, message => console.log(`[zeros-dev] ${message}`));
  let state;
  try {
    if (action === "doctor") {
      const current = await registry.read(identity.owner);
      console.log(JSON.stringify({ owner: identity.owner, mode: "hosted", status: current?.state.status ?? "never-launched",
        generation: current?.state.generation ?? null, identity: profile.workos.environment,
        archiveIncomplete: current?.state.status === "archiving", source: current?.state.source?.sourceSha256 ?? null,
        completedCleanupSteps: Object.keys(current?.state.steps ?? {}).filter(key => current.state.steps[key]),
        providerResources: current ? {
          railwayEnvironmentId: current.state.resources.railway?.id ?? null,
          planetScaleBranch: current.state.resources.planetscale?.name ?? null,
          pagesProject: current.state.resources.pages?.name ?? null,
          images: (current.state.resources.images ?? []).map(r => ({ name: r.snapshotId, qualified: Boolean(r.qualified), retired: Boolean(r.snapshotDeleted),
            builderDeletion: r.builder?.deletionOperationId ?? null })),
          retiredImages: current.state.retiredImages ?? [],
          pendingBuilderDeletions: (current.state.pendingBuilderDeletions ?? []).map(r => ({
            id: r.id, operation: r.deletionOperationId, stage: r.deletionStage, expectedBy: r.deletionExpectedBy ?? null,
          })),
        } : null,
        note: "Read-only status. Provider write permissions and authenticated desktop/cloud qualification are verified by an actual launch." }, null, 2));
      return;
    }
    const operate = () => withHostedLease(registry, identity, async lease => {
      if (action === "archive") return archiveHosted(lease, profile, services);
      if (action === "seed") return services.seed(lease);
      const result = await startHosted(lease, identity, profile, services); state = structuredClone(lease.state); return result;
    }, { create: !["archive", "seed"].includes(action), signal: lifecycle.signal });
    const result = action === "archive" ? await pollProvider("Previous Dev process shutdown", async () => {
      try { return await operate(); }
      catch (error) { if (error?.code === "DEV_LEASE_BUSY") return false; throw error; }
    }, { signal: lifecycle.signal, timeout: 180_000, interval: 2000 }) : await operate();
    if (action === "seed") {
      if (!result.seeded) throw new Error(profile.fixture?.bootstrapOrganization
        ? "Launch Dev and sign in normally before running dev:seed to import your verified test Organization"
        : "Launch Dev, sign in and select the configured Organization before running dev:seed");
      return;
    }
    if (action === "archive") {
      // Shared receipt remains as a tombstone so another machine can create a
      // fresh generation only after every provider cleanup step has finished.
      const localRemoved = cleanupHostedLocalState(directory, identity);
      console.log(`[zeros-dev] ${result.absent ? "No hosted environment exists for this checkout." : "Archive complete. The Dev backend, branch, workers, web facade and R2 objects were removed; worker snapshot names were retired."}`);
      if (result.delayedImageStorageRemoval) console.log("[zeros-dev] Boat image/builder storage cleanup remains pending on the provider's schedule. Its receipts are retained and checked on later Run/Archive operations; this does not delay PlanetScale branch deletion.");
      if (!localRemoved) console.log("[zeros-dev] Local desktop data was retained because this machine still has Zeros Dev running. Close it and rerun archive to remove that local data.");
      return;
    }
    const publicProfile = hostedPublicProfile(state, profile);
    console.log(`[zeros-dev] Ready: ${publicProfile.apiOrigin}. ${result.reused ? "Existing data retained." : "Current source deployed."}`);
    if (action === "backend") return;
  } finally { services.close(); services.removeLocalSources(); registry.close(); }
  // Do not hold a remote provisioning lease for the lifetime of the desktop.
  // Conductor's archive hook can now acquire it from either machine.
  const desktopEnv = { ...systemEnvironment(), ...hostedDesktopEnvironment(state, profile, directory) };
  const controller = lifecycle;
  controller.signal.throwIfAborted();
  try {
    await run("pnpm", ["electron:dev:prep"], { cwd: root, env: desktopEnv, signal: controller.signal, inherit: true, timeout: 300_000, label: "Dev desktop build" });
    await run(process.execPath, [path.join(root, "scripts/dev-instance.mjs"), process.argv.includes("--run-only") ? "--run-only" : "--watch"],
      { cwd: root, env: desktopEnv, signal: controller.signal, inherit: true, timeout: 7 * 24 * 3600_000, label: "Zeros Dev" });
  } catch (error) { if (!controller.signal.aborted) throw error; }
}

main().catch(error => { console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Operation failed; retry with the retained receipt"}`); process.exitCode = 1; })
  .finally(() => { releaseDesktop?.(); for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, cancel); });

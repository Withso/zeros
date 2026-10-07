#!/usr/bin/env node
import { NATIVE_AGENT_CANARY_RETIREMENT, refuseRetiredDevNativeCanary } from "./native-agent-retirement.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceIdentity, developmentHome, privateDirectory, systemEnvironment, acquireWorkspaceLock, withHostedMutation } from "./state.mjs";
import { cleanupHostedLocalState } from "./hosted-local.mjs";
import { loadHostedProfile, hostedDesktopEnvironment, hostedPublicProfile } from "./hosted-profile.mjs";
import { r2Registry, withHostedLease, resolveHostedOwner, selectHostedOwner, bindHostedProfile, adoptHostedOwner, hostedGcEligibility } from "./hosted-state.mjs";
import { startHosted, archiveHosted } from "./hosted-lifecycle.mjs";
import { hostedServices } from "./hosted-services.mjs";
import { run, withDevPortRetry } from "./processes.mjs";
import { pollProvider } from "./provider-http.mjs";
import { reconcileHosted } from "./hosted-reconcile.mjs";
import { hostedDiagnostic, inspectHostedLive } from "./hosted-doctor.mjs";
import { monitorHostedAgents } from "./hosted-agent-monitor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const action = process.argv[2] ?? "start";
const lifecycle = new AbortController();
// Native qualification is optional for app/backend launch. Report its closed
// refusal while allowing those neighboring actions to keep running.
const monitorAgents = input => monitorHostedAgents(input).catch(error => {
  if (error?.code !== NATIVE_AGENT_CANARY_RETIREMENT.code) throw error;
  console.log(`[zeros-dev] ${NATIVE_AGENT_CANARY_RETIREMENT.code}: ${NATIVE_AGENT_CANARY_RETIREMENT.message}`);
  return { state: "retired" };
});
let releaseDesktop;
const cancel = () => lifecycle.abort(new Error("Dev operation interrupted; its receipt was preserved"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, cancel);

async function main() {
  if (!["start", "backend", "archive", "doctor", "seed", "agents", "adopt", "reconcile"].includes(action)) throw new Error("Use start, backend, archive, doctor, seed or agents");
  if (action === "agents") refuseRetiredDevNativeCanary();
  const profile = loadHostedProfile(root), registry = r2Registry(profile.registry);
  const argument = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const owner = argument("--owner"), generation = argument("--generation");
  let identity, services;
  try {
    if ((owner || generation) && !["archive", "doctor", "adopt", "reconcile"].includes(action)) throw new Error("Explicit owner selection is limited to doctor, adopt, reconcile and archive");
    if (action === "doctor" && process.argv.includes("--all")) {
      if (owner || generation) throw new Error("Use doctor --all or an exact owner/generation");
      const inventory = await registry.list({ history: true });
      const environments = [];
      for (const record of inventory.records) environments.push({ ...hostedDiagnostic(record.state),
        ...(process.argv.includes("--live") ? { live: await inspectHostedLive(record.state, profile) } : {}) });
      console.log(JSON.stringify({ environments, quarantine: inventory.quarantine }, null, 2));
      return;
    }
    identity = owner || generation || action === "adopt" ? await selectHostedOwner(registry, owner, generation)
      : await resolveHostedOwner(registry, root, process.env, { create: ["start", "backend"].includes(action), readonly: action === "doctor" });
    if (action === "adopt") {
      const current = await registry.read(identity.owner); bindHostedProfile(current.state, profile);
      const previous = workspaceIdentity(root, process.env, { create: false, inspect: true }) ?? identity;
      const bindingDirectory = privateDirectory(privateDirectory(developmentHome(), "hosted"), previous.owner);
      await withHostedMutation(bindingDirectory, previous, () => adoptHostedOwner(registry, root, owner, generation));
      console.log(`[zeros-dev] Adopted existing owner ${identity.owner}; live resource keys were preserved.`); return;
    }
    if (!identity) {
      console.log("[zeros-dev] No private binding or authenticated registry receipt exists for this checkout; nothing to clean."); return;
    }
    if (action === "doctor") {
      const current = await registry.read(identity.owner);
      console.log(JSON.stringify(current ? { ...hostedDiagnostic(current.state), ...(process.argv.includes("--live") ? { live: await inspectHostedLive(current.state, profile) } : {}) } : { owner: identity.owner, status: "no-registry-receipt" }, null, 2));
      return;
    }
  if (action === "start" && process.platform !== "darwin") throw new Error("Zeros Desktop requires macOS. Use pnpm dev:backend to provision and test this checkout's hosted backend from Linux.");
  const directory = privateDirectory(privateDirectory(developmentHome(), "hosted"), identity.owner);
  services = hostedServices(root, directory, profile, message => console.log(`[zeros-dev] ${message}`), { registry });
  let state, localRemoved;
  const mutation = operation => withHostedMutation(directory, identity, async () => {
    try { return await operation(); } finally { services.removeLocalSources(); }
  });
    if (action === "agents") {
      const current = await registry.read(identity.owner);
      if (!current || current.state.status !== "ready") throw new Error("Launch this Dev environment before checking its connected agents");
      await monitorHostedAgents({ registry, identity, generation: current.state.generation, profile, services, signal: lifecycle.signal,
        mutation, watch: process.argv.includes("--watch"), retry: process.argv.includes("--retry"), progress: message => console.log(`[zeros-dev] ${message}`) });
      return;
    }
    const operate = () => mutation(async () => {
      if (action === "start") releaseDesktop ??= acquireWorkspaceLock({ directory, state: identity });
      return withHostedLease(registry, identity, async lease => {
      if (action === "archive") {
        const result = await archiveHosted(lease, profile, services);
        localRemoved = cleanupHostedLocalState(directory, lease.state);
        return result;
      }
      if (action === "reconcile") return reconcileHosted(lease, profile);
      if (action === "seed") return services.seed(lease);
      const result = await startHosted(lease, identity, profile, services); state = globalThis.structuredClone(lease.state); return result;
    }, { create: ["start", "backend"].includes(action), signal: lifecycle.signal });
    });
    // Stop can terminate the old launcher before it releases its registry
    // lease. Let Run resume after shutdown/expiry, using the same fenced
    // acquisition as Archive instead of failing during that short window.
    let waitingForPrevious = false;
    const result = ["start", "backend", "archive"].includes(action) ? await pollProvider("Previous Dev operation", async () => {
      try { return await operate(); }
      catch (error) {
        if (!["DEV_LEASE_BUSY", "DEV_LOCAL_BUSY"].includes(error?.code)) throw error;
        if (!waitingForPrevious) {
          console.log("[zeros-dev] Waiting for the previous Dev operation to release its lock. An interrupted launch can take up to two minutes.");
          waitingForPrevious = true;
        }
        return false;
      }
    }, { signal: lifecycle.signal, timeout: 180_000, interval: 2000 }) : await operate();
    if (action === "reconcile") { console.log(JSON.stringify(result, null, 2)); if (!result.complete) process.exitCode = 1; return; }
    if (action === "seed") {
      if (!result.seeded) throw new Error(profile.fixture?.bootstrapOrganization
        ? "Launch Dev and sign in normally before running dev:seed to import your verified test Organization"
        : "Launch Dev, sign in and select the configured Organization before running dev:seed");
      return;
    }
    if (action === "archive") {
      // Shared receipt remains as a tombstone so another machine can create a
      // fresh generation only after every provider cleanup step has finished.
      console.log(`[zeros-dev] ${result.absent ? "No hosted environment exists for this checkout." : "Archive complete. The Dev backend, branch, workers, web facade and R2 objects were removed; worker snapshot names were retired."}`);
      if (result.delayedImageStorageRemoval) console.log("[zeros-dev] Boat storage cleanup remains pending on the provider's schedule. Its receipts are retained and checked on later Run/Archive operations; this does not delay PlanetScale branch deletion.");
      if (!localRemoved) console.log("[zeros-dev] Local desktop data was retained because this machine still has Zeros Dev running. Close it and rerun archive to remove that local data.");
      return;
    }
    const publicProfile = hostedPublicProfile(state, profile);
    const expiryWarning = hostedGcEligibility(state, profile).warning;
    if (expiryWarning) console.log(`[zeros-dev] ${expiryWarning}`);
    console.log(`[zeros-dev] Ready: ${publicProfile.apiOrigin}. ${result.reused ? "Existing data retained." : "Current source deployed."}`);
    if (action === "backend") {
      await monitorAgents({ registry, identity, generation: state.generation, profile, services, signal: lifecycle.signal,
        mutation, watch: !process.argv.includes("--once"), progress: message => console.log(`[zeros-dev] ${message}`) });
      return;
    }
  // Do not hold a remote provisioning lease for the lifetime of the desktop.
  // Conductor's archive hook can now acquire it from either machine.
  const desktopEnv = { ...systemEnvironment(), ...hostedDesktopEnvironment(state, profile, directory) };
  const controller = lifecycle;
  const monitoring = new AbortController();
  const stopMonitoring = () => monitoring.abort();
  controller.signal.addEventListener("abort", stopMonitoring, { once: true });
  let monitor;
  controller.signal.throwIfAborted();
  try {
    await run("pnpm", ["electron:dev:prep"], { cwd: root, env: desktopEnv, signal: controller.signal, inherit: true, timeout: 300_000, label: "Dev desktop build" });
    monitor = monitorAgents({ registry, identity, generation: state.generation, profile, services, signal: monitoring.signal,
      mutation, progress: message => console.log(`[zeros-dev] ${message}`) });
    await withDevPortRetry(attempt => run(process.execPath, [path.join(root, "scripts/dev-instance.mjs"), process.argv.includes("--run-only") ? "--run-only" : "--watch"],
      { cwd: root, env: { ...desktopEnv, ZEROS_DEV_PORT_ATTEMPT: String(attempt) }, signal: controller.signal, inherit: true, timeout: 7 * 24 * 3600_000, label: "Zeros Dev" }), { signal: controller.signal });
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { monitoring.abort(); await monitor; controller.signal.removeEventListener("abort", stopMonitoring); }
  } finally { services?.close(); registry.close(); }
}

main().catch(error => { console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Operation failed; retry with the retained receipt"}`); process.exitCode = 1; })
  .finally(() => { releaseDesktop?.(); for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, cancel); });

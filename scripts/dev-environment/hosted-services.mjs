import { startHosted } from "./hosted-lifecycle.mjs";
import { persistentConnectionLifecycle } from "./hosted-connections.mjs";
import { readPrivateJson } from "./state.mjs";
import { r2Registry } from "./hosted-state.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey } from "node:crypto";
import { systemEnvironment, privateDirectory } from "./state.mjs";
import { captureDevelopmentSource } from "./source.mjs";
import { ensurePlanetScaleBranch, ensurePlanetScaleRoles, deletePlanetScaleBranch, deletePlanetScaleMigrationRole, planetScaleDevClient, retirePlanetScaleRuntimeRoles, verifyPlanetScaleRuntimeRole } from "./planetscale.mjs";
import { ensureRailwayEnvironment, stopRailwayBackend, configureRailwayBackend, deployRailwayBackend, deleteRailwayEnvironment, railwayDevClient, listRailwayEnvironments, ensureRailwayDevDomain, isRailwayOwnerName } from "./railway.mjs";
import { hostedCloudflareClient, ensureDevPages, ensureDevPagesDomain, ensureDevDns, verifyDevZone, deleteDevPagesAndDns } from "./hosted-cloudflare.mjs";
import { ensureHostedWebhook, deleteHostedWebhook } from "./hosted-workos.mjs";
import { hostedBackendEnvironment, hostedWebEnvironment, hostedPublicProfile } from "./hosted-profile.mjs";
import { ensureDevImage, deleteDevImages, reconcileRetiredBuilders, verifyDevImage, devBoatClient } from "./hosted-image.mjs";
import { devObjectStorage } from "./hosted-storage.mjs";
import { run, waitForHttp, waitForDevSignIn } from "./processes.mjs";
import { pollProvider } from "./provider-http.mjs";
import { ensureDevAuthEnvironment } from "../dev-auth-profile.mjs";
import { endpoints, workosClient } from "./workos.mjs";
import { packDevOperator, unpackDevOperator } from "./operator-artifact.mjs";
import { assertCurrentFixtureFunding, bindFixture, verifyFixtureMembership } from "./hosted-fixtures.mjs";
import { bindHostedProfile } from "./hosted-state.mjs";
import { advanceHostedAgents } from "./hosted-agents.mjs";
import { hostedAgentCanary, hostedAgentRequest } from "./hosted-agent-canary.mjs";
import { startHostedAgentOverSsh, retireHostedAgentSsh } from "./hosted-agent-ssh.mjs";
import { inventoryHostedProviders } from "./hosted-inventory.mjs";
import { reserveHostedAdmission, releaseHostedAdmission } from "./hosted-admission.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Seeding must size its quota from the candidate being deployed (or the
 * recorded deployment for standalone Seed), never an older image in the
 * generation's cleanup ledger. Drain can run before deployment verification
 * writes state.source; its provider uses the image only for configuration. */
export function hostedDatabaseWorker(state, build, action) {
  const inputs = build.workerInputsSha256 ?? state.source?.workerInputsSha256;
  const worker = state.resources.images?.find(r => r.qualified && !r.deleted && !r.snapshotDeleted &&
    (!["seed", "agents-inspect", "agents-enable"].includes(action) || (typeof inputs === "string" && /^[a-f0-9]{64}$/.test(inputs) && r.inputsSha256 === inputs)));
  if (["seed", "agents-inspect", "agents-enable"].includes(action) && !worker) throw new Error("Dev fixture is missing its matching qualified worker image");
  return worker;
}

/** Cleanup may happen months after the runtime credential expires. Repair
 * only the recorded branch's privileges, without applying new migrations. */
export async function ensureHostedDrainAuthority(lease, { verify, ensure, repair, retire }) {
  if (!lease.state.steps.backendStopped || !lease.state.steps.railwayDeleted) throw new Error("Stop the owned backend before repairing cleanup authority");
  if (!lease.state.drainRuntimeRepair) {
    try { await verify(); return; } catch { /* Recheck branch ownership inside role rotation. */ }
  }
  lease.state.drainRuntimeRepair = true; await lease.save();
  try {
    await ensure(); await repair();
    delete lease.state.drainRuntimeRepair; await lease.save();
  } finally { await retire(); }
}

export function hostedServices(root, directory, profile, progress = () => {}, { registry, lifecycleHooks = [] } = {}) {
  const cf = hostedCloudflareClient(profile.cloudflare), ps = planetScaleDevClient(profile.planetscale), railway = railwayDevClient(profile.railway);
  const objects = devObjectStorage(profile.storage), env = systemEnvironment();
  let candidate, cleanupBuild, cleanupDigest, connectionRegistry;
  if(profile.connections?.enabled){
    const operatorPath=process.env.ZEROS_DEV_CONNECTIONS_OPERATOR_PATH;
    if(!operatorPath||!path.isAbsolute(operatorPath))throw new Error("Set the absolute private ZEROS_DEV_CONNECTIONS_OPERATOR_PATH on this launcher/GC host");
    const operator=readPrivateJson(operatorPath);connectionRegistry=r2Registry(operator.registry);
    lifecycleHooks=[...lifecycleHooks,...persistentConnectionLifecycle(profile,{operator,registry:connectionRegistry,source:()=>candidate})];
  }
  const generationDirectory = lease => privateDirectory(privateDirectory(directory, "generations"), lease.state.generation);
  const operatorBuild = async lease => {
    const digest = lease.state.resources.operator?.digest;
    if (cleanupBuild && cleanupDigest !== digest) { fs.rmSync(cleanupBuild.directory, { recursive: true, force: true }); cleanupBuild = undefined; }
    if (!cleanupBuild) {
      cleanupBuild = unpackDevOperator(await objects.readOperator(lease.state), digest,
        fs.mkdtempSync(path.join(generationDirectory(lease), "cleanup-")), root);
      cleanupDigest = digest;
    }
    return cleanupBuild;
  };
  const buildBackend = async (lease, source) => {
    await run("pnpm", ["--dir", "apps/control-plane", "build"], { cwd: source.directory, env, signal: lease.signal, timeout: 180_000, label: "Dev backend build" });
  };
  const source = async lease => {
    if (candidate) return candidate;
    progress("Capturing and checking this checkout's current source");
    candidate = captureDevelopmentSource(root, generationDirectory(lease));
    // The complete private snapshot is committed before scanning, so the normal
    // tracked-file secret gate covers formerly untracked source as well.
    await run(process.execPath, ["scripts/check-secrets.mjs"], { cwd: candidate.directory, env, signal: lease.signal, label: "Dev source secret scan" });
    for (const relative of ["node_modules", "apps/control-plane/node_modules", "apps/web/node_modules", "apps/marketing/node_modules", "packages/protocol/node_modules", "packages/design-core/node_modules", "packages/design-web/node_modules"]) {
      const from = path.join(root, relative), to = path.join(candidate.directory, relative);
      if (!fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 }); fs.symlinkSync(from, to, "dir");
      if (relative === "node_modules") fs.symlinkSync(from, path.join(candidate.worker.directory, "node_modules"), "dir");
    }
    await buildBackend(lease, candidate); return candidate;
  };
  const database = async (lease, action, build, fixtureProof, agentJob) => {
    await lease.fence();
    const state = lease.state;
    const worker = hostedDatabaseWorker(state, build, action);
    return JSON.parse(await run(process.execPath, [path.join(here, "hosted-database.mjs")], { cwd: root, env, signal: lease.signal,
      timeout: 300_000, label: `Dev database ${action}`, input: JSON.stringify({ action, buildRoot: build.directory,
        owner: state.owner, generation: state.generation, roles: state.resources.planetscale.roles,
        backendStopped: state.steps.backendStopped && state.steps.railwayDeleted, boat: profile.boat, worker,
        ...(["agents-inspect", "agents-enable"].includes(action) ? { agentRequest: hostedAgentRequest(state, profile,
          agentJob?.organizationImageId ? { ...agentJob.image, id: agentJob.organizationImageId } : worker) } : {}),
        ...(agentJob ? { agentConnection: agentJob.connection, agentChange: { operationId: agentJob.id, actorUserId: agentJob.actorUserId,
          enabled: true, reason: `Automatic isolated Dev native qualification ${state.owner}/${state.generation}`, evidence: agentJob.evidence } } : {}),
        ...(action === "seed" ? { fixture: bindFixture(state, profile.fixture), fixtureProof } : {}) }) }));
  };
  const seed = async (lease, build) => {
    assertCurrentFixtureFunding(profile.fixture);
    const fixture = bindFixture(lease.state, profile.fixture); await lease.save();
    const proof = fixture.bootstrapOrganization ? await verifyFixtureMembership(fixture, workosClient(profile)) : undefined;
    const result = await database(lease, "seed", build, proof);
    progress(result.seeded ? "Dev test member has the standard Pro monthly allowance; initial workspace limits are seeded and operator quota changes are preserved"
      : fixture.bootstrapOrganization
        ? "Sign into this Dev app; the launcher will prepare your verified test Organization automatically"
        : "Sign into this Dev app and select the configured Organization; the launcher will prepare its cloud test fixture automatically");
    return result;
  };
  return {
    lifecycleHooks,
    async reserveGeneration(lease) {
      if (!registry) throw new Error("Dev allocation requires the account admission registry");
      await reserveHostedAdmission(registry, lease.state, profile);
    },
    releaseAdmission: lease => registry ? releaseHostedAdmission(registry, lease, profile) : undefined,
    async preflight(lease) {
      assertCurrentFixtureFunding(profile.fixture);
      if (profile.fixture) { bindFixture(lease.state, profile.fixture); await lease.save(); }
      progress("Checking Dev provider access before allocating resources");
      await reconcileRetiredBuilders(lease, profile);
      try {
        if (createPrivateKey(Buffer.from(profile.github.privateKeyBase64, "base64").toString("utf8")).asymmetricKeyType !== "rsa") throw new Error();
      } catch { throw new Error("The configured GitHub App private key is invalid; no resources were allocated"); }
      for (const relative of ["node_modules/tsx", "apps/control-plane/node_modules/pg", "apps/web/node_modules/wrangler"]) {
        if (!fs.existsSync(path.join(root, relative))) throw new Error("Run Conductor setup to install the root, control-plane and web dependencies before Dev launch");
      }
      await verifyDevZone(profile.cloudflare, cf);
      for (const kind of ["api", "app"]) {
        const name = `${kind}-dev-${lease.state.owner}.${profile.cloudflare.domain}`;
        const records = await cf(`/zones/${profile.cloudflare.zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`);
        const receipt = lease.state.resources.dns?.find(r => r.name === name);
        if (!Array.isArray(records) || records.length > 1 || records.some(r => !receipt || r.comment !== receipt.comment || (receipt.id && r.id !== receipt.id))) {
          throw new Error("An existing Dev hostname needs its original tunnel/environment retired first; no billable resources were allocated");
        }
      }
      await cf(`/accounts/${profile.cloudflare.accountId}/pages/projects?per_page=1`);
      const environments = await listRailwayEnvironments(profile.railway, railway);
      if (environments.some(e => isRailwayOwnerName(e.name, lease.state) && e.id !== lease.state.resources.railway?.id && e.name !== lease.state.resources.railway?.name)) {
        throw new Error("A previous Dev environment exists outside this receipt; restore its original registry before provisioning another generation");
      }
      if (profile.railway.protectedEnvironmentIds.some(id => !environments.some(e => e.id === id))) throw new Error("Railway Dev token cannot see the configured protected environment");
      const db = await ps("");
      if (db.name !== profile.planetscale.database || db.kind !== "postgresql" || db.default_branch !== profile.planetscale.protectedBranch) throw new Error("PlanetScale Dev database/default branch does not match the profile");
      await objects.verify(lease.state); await endpoints(workosClient(profile));
      if (profile.workos.environment === "alpha") {
        const auth = await ensureDevAuthEnvironment({ processEnv: {} });
        if (auth.issue || auth.source === "none" || auth.env.AUTH_DESKTOP_CLIENT_ID !== profile.workos.desktopClientId ||
            auth.env.AUTH_ISSUER !== `https://api.workos.com/user_management/${profile.workos.webClientId}`) throw new Error("The explicitly shared Alpha identity no longer matches its public contract");
      }
    },
    captureSource: source,
    async ensureImage(lease, build) {
      const existing = lease.state.resources.images?.some(r => r.inputsSha256 === build.workerInputsSha256 && r.qualified && !r.deleted);
      progress(existing ? "Verifying the existing cloud worker image" : "Building and qualifying the changed cloud worker image; this can take several minutes");
      if (!existing) {
        if (!registry) throw new Error("Dev builder allocation requires the account admission registry");
        const inventory = await inventoryHostedProviders(profile);
        // An earlier interrupted attempt can leave a never-started builder
        // reservation; release it before competing for the owner's slot.
        await releaseHostedAdmission(registry, lease, profile);
        await reserveHostedAdmission(registry, lease.state, profile, { kind: "builder", inventory,
          snapshotName: `dev-${lease.state.owner}-${lease.state.generation.slice(0, 8)}-${build.workerInputsSha256.slice(0, 16)}` });
      }
      try { return await ensureDevImage(lease, profile, build, directory, objects, { progress }); }
      finally { if (registry) await releaseHostedAdmission(registry, lease, profile); }
    },
    async ensureDatabase(lease) {
      progress(lease.state.resources.planetscale?.name ? "Reusing this checkout's PlanetScale Dev branch and its data" : "Creating this checkout's disposable PlanetScale Dev branch");
      await ensurePlanetScaleBranch(lease, profile.planetscale, ps); await ensurePlanetScaleRoles(lease, profile.planetscale, ps);
    },
    async ensureBackend(lease) {
      progress(lease.state.resources.railway?.id ? "Reusing this checkout's Railway Dev environment" : "Creating this checkout's Railway Dev environment");
      await ensureRailwayEnvironment(lease, profile.railway, railway);
    },
    stopBackend: lease => stopRailwayBackend(lease, profile.railway, railway),
    async migrate(lease, build) {
      progress("Applying the release migrations with a temporary database role");
      const operator = packDevOperator(build.directory);
      try {
        await database(lease, "migrate", build);
        // Keep the last usable operator if a new migration fails. Publish the
        // new one before any matching API deployment can allocate a worker.
        await objects.saveOperator(lease, operator);
        lease.state.databaseInitialized = true; await lease.save();
        if (profile.fixture) await seed(lease, build);
      }
      finally { await deletePlanetScaleMigrationRole(lease, profile.planetscale, ps); }
    },
    async seed(lease) {
      if (lease.state.status !== "ready") throw new Error("Launch the Dev environment before running dev:seed");
      bindHostedProfile(lease.state, profile);
      bindFixture(lease.state, profile.fixture); await lease.save();
      await operatorBuild(lease);
      await ensurePlanetScaleRoles(lease, profile.planetscale, ps);
      try { return await seed(lease, cleanupBuild); }
      finally { await deletePlanetScaleMigrationRole(lease, profile.planetscale, ps); }
    },
    async agents(lease, options) {
      if(lease.state.status==='ready' && profile.connections?.enabled && lease.state.connectionRegistration &&
        Date.parse(lease.state.connectionRegistration.expiresAt)<=Date.now()+6*3600000)
        await startHosted(lease,{owner:lease.state.owner,identity:lease.state.identity},profile,this);
      if (lease.state.status !== "ready" || !profile.fixture) return { state: profile.connections?.enabled ? "ready" : "inactive" };
      bindHostedProfile(lease.state, profile); bindFixture(lease.state, profile.fixture);
      await retireHostedAgentSsh(lease, profile);
      await operatorBuild(lease);
      const canary = hostedAgentCanary(lease, profile, undefined, {
        reserve: job => {
          if (!registry) throw new Error("Dev canary allocation requires the account admission registry");
          return reserveHostedAdmission(registry, lease.state, profile, { kind: "builder", computeId: `canary:${job.id}` });
        },
        release: () => registry ? releaseHostedAdmission(registry, lease, profile) : undefined,
      });
      return advanceHostedAgents(lease, profile, {
        ...canary,
        inspect: () => database(lease, "agents-inspect", cleanupBuild),
        seed: () => this.seed(lease),
        start: (job, image) => startHostedAgentOverSsh(lease, profile, generationDirectory(lease), {
          ...hostedAgentRequest(lease.state, profile, image), target: canary.target(job), startedAt: job.startedAt,
          credentialId: job.connection.credentialId, credentialRevision: job.connection.credentialRevision,
          connectionRevision: job.connection.connectionRevision, model: job.connection.model,
        }),
        enable: async job => {
          await ensurePlanetScaleRoles(lease, profile.planetscale, ps);
          try { await database(lease, "agents-enable", cleanupBuild, undefined, job); }
          finally { await deletePlanetScaleMigrationRole(lease, profile.planetscale, ps); }
        },
      }, options);
    },
    retireDatabaseCredentials: lease => retirePlanetScaleRuntimeRoles(lease, profile.planetscale, ps),
    retireAgentAccess: lease => retireHostedAgentSsh(lease, profile),
    ensureWebhook: lease => ensureHostedWebhook(lease, profile),
    async deployBackend(lease, build, worker) {
      progress("Deploying the captured backend source to Railway");
      await configureRailwayBackend(lease, profile.railway, hostedBackendEnvironment(lease.state, profile, build, worker), railway);
      await deployRailwayBackend(lease, profile.railway, build.backend, railway);
      await ensureRailwayDevDomain(lease, profile, desired => ensureDevDns(lease, profile.cloudflare, desired, cf), railway);
    },
    async deployWeb(lease, build) {
      progress("Deploying the matching authentication web facade");
      const p = await ensureDevPages(lease, profile, cf), webEnv = hostedWebEnvironment(lease.state, profile);
      await run("npm", ["--prefix", "apps/web", "run", "build"], { cwd: build.directory, env: { ...env, ...webEnv, CF_PAGES_COMMIT_SHA: build.commit }, signal: lease.signal, timeout: 180_000, label: "Dev web build" });
      await lease.fence();
      await run(process.execPath, [path.join(root, "apps/web/node_modules/wrangler/bin/wrangler.js"), "pages", "deploy", "dist",
        "--project-name", p.name, "--branch", "dev", "--commit-hash", build.commit, "--commit-dirty=false"],
      { cwd: path.join(build.directory, "apps/web"), env: { ...env, CLOUDFLARE_API_TOKEN: profile.cloudflare.apiToken,
        CLOUDFLARE_ACCOUNT_ID: profile.cloudflare.accountId, WRANGLER_SEND_METRICS: "false", CI: "true" }, signal: lease.signal, timeout: 300_000, label: "Dev web deployment" });
      await ensureDevPagesDomain(lease, profile, cf);
    },
    async verify(lease, build) {
      progress("Verifying the deployed owner, generation, source and sign-in routing");
      const state = lease.state, p = hostedPublicProfile(state, profile);
      await verifyPlanetScaleRuntimeRole(lease, profile.planetscale, ps);
      await verifyDevImage(state.resources.images?.find(image => image.inputsSha256 === build.workerInputsSha256 && !image.deleted), profile, devBoatClient(profile.boat, lease.signal));
      await waitForHttp(`${p.apiOrigin}/healthz`, { signal: lease.signal, timeout: 120_000, accept: async response => {
        if (!response.ok) return false;
        const d = (await response.json()).development;
        return d?.owner === state.owner && d.runId === state.runId && d.generation === state.generation &&
          d.sourceSha256 === build.sourceSha256 && d.workerInputsSha256 === build.workerInputsSha256;
      } });
      await waitForHttp(`${p.appOrigin}/zeros-deployment.json`, { signal: lease.signal, timeout: 120_000, accept: async response => response.ok && (await response.json()).commitSha === build.commit });
      await waitForDevSignIn(p, { signal: lease.signal });
    },
    async deleteWorkers(lease) {
      if (!lease.state.backendEverDeployed) return;
      progress("Confirming deletion of this Dev database's cloud workers");
      const build = await operatorBuild(lease);
      await ensureHostedDrainAuthority(lease, {
        verify: () => verifyPlanetScaleRuntimeRole(lease, profile.planetscale, ps),
        ensure: () => ensurePlanetScaleRoles(lease, profile.planetscale, ps),
        repair: () => database(lease, "repair-runtime-role", build),
        retire: () => deletePlanetScaleMigrationRole(lease, profile.planetscale, ps),
      });
      await pollProvider("Dev cloud worker cleanup", async () => {
        const result = await database(lease, "drain", build);
        if (result.retired?.length) {
          const pending = new Map((lease.state.pendingWorkerDeletions ?? []).map(record => [record.deletionOperationId, record]));
          for (const record of result.retired) pending.set(record.deletionOperationId, record);
          lease.state.pendingWorkerDeletions = [...pending.values()];
          // Commit the journal transfer BEFORE allowing lifecycle to delete
          // the branch or operator artifact. A failed CAS keeps both intact.
          await lease.save();
        }
        return result.complete;
      },
        { signal: lease.signal, timeout: 300_000, interval: 3000 });
    },
    deleteBackend: lease => deleteRailwayEnvironment(lease, profile.railway, railway),
    deleteImages: lease => deleteDevImages(lease, profile),
    reconcileRetiredBuilders: lease => reconcileRetiredBuilders(lease, profile),
    deleteWeb: lease => deleteDevPagesAndDns(lease, profile, cf),
    deleteWebhook: lease => deleteHostedWebhook(lease, profile),
    deleteObjects: lease => objects.clear(lease),
    deleteDatabase: lease => deletePlanetScaleBranch(lease, profile.planetscale, ps),
    close() { objects.close(); connectionRegistry?.close(); },
    removeLocalSources() {
      if (candidate) { fs.rmSync(candidate.directory, { recursive: true, force: true }); fs.rmSync(candidate.worker.directory, { recursive: true, force: true }); fs.rmSync(candidate.backend.archive, { force: true }); }
      if (cleanupBuild) fs.rmSync(cleanupBuild.directory, { recursive: true, force: true });
      candidate = undefined; cleanupBuild = undefined; cleanupDigest = undefined;
    },
  };
}

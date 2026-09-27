import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey } from "node:crypto";
import { systemEnvironment } from "./state.mjs";
import { captureDevelopmentSource } from "./source.mjs";
import { ensurePlanetScaleBranch, ensurePlanetScaleRoles, deletePlanetScaleBranch, deletePlanetScaleMigrationRole, planetScaleDevClient } from "./planetscale.mjs";
import { ensureRailwayEnvironment, stopRailwayBackend, configureRailwayBackend, deployRailwayBackend, deleteRailwayEnvironment, railwayDevClient, listRailwayEnvironments, ensureRailwayDevDomain, isRailwayOwnerName } from "./railway.mjs";
import { hostedCloudflareClient, ensureDevPages, ensureDevPagesDomain, ensureDevDns, verifyDevZone, deleteDevPagesAndDns } from "./hosted-cloudflare.mjs";
import { ensureHostedWebhook, deleteHostedWebhook } from "./hosted-workos.mjs";
import { hostedBackendEnvironment, hostedWebEnvironment, hostedPublicProfile } from "./hosted-profile.mjs";
import { ensureDevImage, deleteDevImages, reconcileRetiredBuilders } from "./hosted-image.mjs";
import { devObjectStorage } from "./hosted-storage.mjs";
import { run, waitForHttp, waitForDevSignIn } from "./processes.mjs";
import { pollProvider } from "./provider-http.mjs";
import { ensureDevAuthEnvironment } from "../dev-auth-profile.mjs";
import { endpoints, workosClient } from "./workos.mjs";
import { packDevOperator, unpackDevOperator } from "./operator-artifact.mjs";
import { assertCurrentFixtureFunding, bindFixture, verifyFixtureMembership } from "./hosted-fixtures.mjs";
import { bindHostedProfile } from "./hosted-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export function hostedServices(root, directory, profile, progress = () => {}) {
  const cf = hostedCloudflareClient(profile.cloudflare), ps = planetScaleDevClient(profile.planetscale), railway = railwayDevClient(profile.railway);
  const objects = devObjectStorage(profile.storage), env = systemEnvironment();
  let candidate, cleanupBuild;
  const buildBackend = async (lease, source) => {
    await run("pnpm", ["--dir", "apps/control-plane", "build"], { cwd: source.directory, env, signal: lease.signal, timeout: 180_000, label: "Dev backend build" });
  };
  const source = async lease => {
    if (candidate) return candidate;
    progress("Capturing and checking this checkout's current source");
    candidate = captureDevelopmentSource(root, directory);
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
  const database = async (lease, action, build, fixtureProof) => {
    await lease.fence();
    const state = lease.state;
    const worker = state.resources.images?.find(r => r.qualified && !r.deleted);
    return JSON.parse(await run(process.execPath, [path.join(here, "hosted-database.mjs")], { cwd: root, env, signal: lease.signal,
      timeout: 300_000, label: `Dev database ${action}`, input: JSON.stringify({ action, buildRoot: build.directory,
        owner: state.owner, generation: state.generation, roles: state.resources.planetscale.roles,
        backendStopped: state.steps.backendStopped && state.steps.railwayDeleted, boat: profile.boat, worker,
        ...(action === "seed" ? { fixture: bindFixture(state, profile.fixture), fixtureProof } : {}) }) }));
  };
  const seed = async (lease, build) => {
    assertCurrentFixtureFunding(profile.fixture);
    const fixture = bindFixture(lease.state, profile.fixture); await lease.save();
    const proof = fixture.bootstrapOrganization ? await verifyFixtureMembership(fixture, workosClient(profile)) : undefined;
    const result = await database(lease, "seed", build, proof);
    progress(result.seeded ? "Dev test member has the standard Pro monthly allowance and one workspace/running-workspace quota"
      : fixture.bootstrapOrganization
        ? "Sign into this Dev app, then run pnpm dev:seed to import your verified test Organization and enable its cloud fixture"
        : "Sign into this Dev app and select the configured Organization, then run pnpm dev:seed to enable its cloud test fixture");
    return result;
  };
  return {
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
    async ensureImage(lease, build) { progress("Qualifying the matching cloud worker image"); return ensureDevImage(lease, profile, build, directory, objects); },
    async ensureDatabase(lease) { progress("Preparing this checkout's disposable PlanetScale branch"); await ensurePlanetScaleBranch(lease, profile.planetscale, ps); await ensurePlanetScaleRoles(lease, profile.planetscale, ps); },
    async ensureBackend(lease) { progress("Preparing this checkout's Railway environment"); await ensureRailwayEnvironment(lease, profile.railway, railway); },
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
      cleanupBuild = unpackDevOperator(await objects.readOperator(lease.state), lease.state.resources.operator.digest,
        fs.mkdtempSync(path.join(directory, "cleanup-")), root);
      await ensurePlanetScaleRoles(lease, profile.planetscale, ps);
      try { return await seed(lease, cleanupBuild); }
      finally { await deletePlanetScaleMigrationRole(lease, profile.planetscale, ps); }
    },
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
      if (!cleanupBuild) cleanupBuild = unpackDevOperator(await objects.readOperator(lease.state), lease.state.resources.operator.digest,
        fs.mkdtempSync(path.join(directory, "cleanup-")), root);
      const build = cleanupBuild;
      await pollProvider("Dev cloud worker cleanup", async () => (await database(lease, "drain", build)).complete,
        { signal: lease.signal, timeout: 300_000, interval: 3000 });
    },
    deleteBackend: lease => deleteRailwayEnvironment(lease, profile.railway, railway),
    deleteImages: lease => deleteDevImages(lease, profile),
    reconcileRetiredBuilders: lease => reconcileRetiredBuilders(lease, profile),
    deleteWeb: lease => deleteDevPagesAndDns(lease, profile, cf),
    deleteWebhook: lease => deleteHostedWebhook(lease, profile),
    deleteObjects: lease => objects.clear(lease),
    deleteDatabase: lease => deletePlanetScaleBranch(lease, profile.planetscale, ps),
    close() { objects.close(); },
    removeLocalSources() {
      if (candidate) { fs.rmSync(candidate.directory, { recursive: true, force: true }); fs.rmSync(candidate.worker.directory, { recursive: true, force: true }); fs.rmSync(candidate.backend.archive, { force: true }); }
      if (cleanupBuild) fs.rmSync(cleanupBuild.directory, { recursive: true, force: true });
    },
  };
}

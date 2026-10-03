import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { r2Registry, withHostedLease } from "../dev-environment/hosted-state.mjs";
import { reserveHostedAdmission, releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { devBoatClient } from "../dev-environment/hosted-image.mjs";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { boatImageAdapter, runtimeOwnerAdapter } from "./worker-adapters";
import { reconcileWorkerSnapshotHolds, reserveWorkerSlot, workerOwner, workerSnapshotName } from "./worker-admission";
import { releaseCanaryAdapter } from "./worker-canary";
import { releaseCanaryBroker } from "./worker-broker";
import { workerExecutionConfig } from "./worker-config";
import { workerIdentityAdapter } from "./worker-identity";
import { promoteWorker } from "./worker";
import { ReleaseIdentity, requireCheck, type PromotionConfig } from "./contracts";
import { githubClient } from "./github";
import { jsonClient } from "./io";
import type { WorkerQualificationProfile } from "./worker-profile";
import { reconcileFailedReleaseBuilderHolds, reconcileReleaseBuilderRetentions } from "./worker-builder-retirement";
import { reconcileReleaseCanaryRetirements, releaseCanaryCleanup, retireReleaseCanary } from "./worker-canary-recovery";

const name = z.string().min(1).max(256);
const admissionConfiguration = z.object({ version: z.literal(1), registry: z.object({ endpoint: name, bucket: name, accessKeyId: name, secretAccessKey: name,
  encryptionKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), profile: z.object({
  boat: z.object({ accountScope: name, billingOrg: name, baseSnapshot: name }).strict(), railway: z.object({ projectId: name }).strict(),
  planetscale: z.object({ organization: name, database: name }).strict(), cloudflare: z.object({ accountId: name }).strict(),
}).strict() }).strict();

export function workerAdmissionConfiguration(env: NodeJS.ProcessEnv) {
  let parsed;
  try { parsed = admissionConfiguration.safeParse(JSON.parse(env.WORKER_ADMISSION_CONFIG_JSON ?? "")); }
  catch { throw new Error("Protected worker shared-account admission configuration is invalid"); }
  requireCheck(parsed.success, "Protected worker shared-account admission configuration is invalid");
  requireCheck(parsed.data.profile.boat.accountScope === env.BOAT_ACCOUNT_SCOPE && parsed.data.profile.boat.billingOrg === env.BOAT_BILLING_ORG &&
    parsed.data.profile.boat.baseSnapshot === env.BOAT_BASE_SNAPSHOT, "Worker admission configuration belongs to another Boat account or protected base");
  return parsed.data;
}
export async function assertWorkerApi(config: PromotionConfig, read = jsonClient()) {
  const parsed = ReleaseIdentity.safeParse(await read(`${config.api}/v1/release-identity`));
  requireCheck(parsed.success && parsed.data.channel === config.channel && parsed.data.sourceSha === config.sourceSha &&
    parsed.data.migrations.head === parsed.data.migrations.expectedHead, "Worker canaries require the new exact-SHA channel API and current schema first");
}
export async function workerSnapshotInventory(request: any) {
  const names: { provider: string; id: string }[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await request("GET", `/named-snapshots${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    requireCheck(response.status === 200 && Array.isArray(response.body?.snapshots), "Worker named snapshot inventory is unavailable");
    for (const row of response.body.snapshots) {
      requireCheck(typeof row?.name === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(row.name) && !names.some(value => value.id === row.name), "Worker snapshot inventory identity changed during pagination");
      names.push({ provider: "boat", id: row.name });
    }
    const next = response.body.nextCursor;
    requireCheck(!response.body.hasMore || typeof next === "string" && next.length > 0, "Worker named snapshot inventory is incomplete");
    if (!next) return names;
    requireCheck(typeof next === "string" && next.length <= 1024 && !cursors.has(next), "Worker snapshot inventory cursor is invalid");
    cursors.add(next); cursor = next;
  }
  throw new Error("Worker snapshot inventory exceeded its page bound");
}

function workerStateStore(config: PromotionConfig, admission: ReturnType<typeof workerAdmissionConfiguration>) {
  const registry = r2Registry(admission.registry), owner = workerOwner(config.channel);
  const identity = { owner, identity: createHash("sha256").update(JSON.stringify(["release-worker", config.repository, config.channel])).digest("hex") };
  const key = `release-workers/v1/${config.channel}.json`;
  const store = { read: () => registry.readDocument(key, owner, (state: any) => state),
    write: (_owner: string, state: any, etag: string) => registry.writeDocument(key, state, etag),
    readAdmission: () => registry.readAdmission(), writeAdmission: (ledger: any, etag: string) => registry.writeAdmission(ledger, etag),
    list: async () => ({ records: [], quarantine: [] }) };
  return { registry, identity, store };
}

export async function reconcileWorkerNativeStorage(env: NodeJS.ProcessEnv) {
  const { config, actorUserId } = workerExecutionConfig(env), admission = workerAdmissionConfiguration(env);
  const github = githubClient(config, env), broker = releaseCanaryBroker(config, env, "smoke");
  await github.assertRequiredChecks(); await github.assertCurrent(); await assertWorkerApi(config);
  const { registry, identity, store } = workerStateStore(config, admission);
  try {
    requireCheck(await store.readAdmission(), "Initialize and reconcile the shared Boat admission ledger before release cleanup");
    const result = await withHostedLease(store, identity, async (lease: any) => {
      await github.assertRequiredChecks(); await github.assertCurrent(); await assertWorkerApi(config); await lease.fence();
      const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
      const core = nativeAgentCanary(lease, admission.profile, devBoatClient({ apiKey: env.BOAT_API_KEY }, signal),
        { release: () => releaseHostedAdmission(store, lease, admission.profile) },
        { strictCleanup: true, releaseStorageDeferral: true, cleanupTimeoutMs: 0 });
      return reconcileReleaseCanaryRetirements(config, actorUserId, lease, core, broker.retire, { signal });
    }, { create: false });
    requireCheck(typeof result === "number" || result?.absent === true, "Release native storage reconciliation result is unconfirmed");
    return typeof result === "number" ? result : 0;
  } finally { registry.close(); }
}

export async function executeWorkerPromotion(env: NodeJS.ProcessEnv, inputsSha256: string, qualificationProfile: WorkerQualificationProfile) {
  const execution = workerExecutionConfig(env), { config } = execution;
  const admission = workerAdmissionConfiguration(env);
  const github = githubClient(config, env), broker = releaseCanaryBroker(config, env, qualificationProfile);
  await github.assertRequiredChecks();
  await github.assertCurrent();
  await assertWorkerApi(config);
  const { registry, identity, store } = workerStateStore(config, admission);
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-release-worker-"));
  try {
    requireCheck(await store.readAdmission(), "Initialize and reconcile the shared Boat admission ledger before release execution");
    return await withHostedLease(store, identity, async (lease: any) => {
      const state = lease.state;
      if (state.status === "provisioning" && state.resources && typeof state.resources === "object" &&
        !Array.isArray(state.resources) && Object.keys(state.resources).length === 0 &&
        (state.releaseRuns === undefined || Array.isArray(state.releaseRuns) && state.releaseRuns.length === 0)) {
        state.releaseRuns ??= [];
        state.resources.images = [];
      }
      const runs = state.releaseRuns;
      const request = devBoatClient({ apiKey: env.BOAT_API_KEY }, lease.signal), profile = admission.profile;
      const release = () => releaseHostedAdmission(store, lease, profile);
      const current = async () => { await github.assertRequiredChecks(); await github.assertCurrent(); await assertWorkerApi(config); await lease.fence(); };
      await current();
      requireCheck(state.owner === workerOwner(config.channel) && Array.isArray(runs) && runs.length <= 100 &&
        Array.isArray(state.resources.images), "Release canary historical ownership is unconfirmed");
      // Temporarily defer earlier test-machine recovery for Alpha publication.
      // Preserve the entire journal and admission holds; this run still uses
      // the normal exact-source qualification and strict cleanup below.
      if (config.channel !== "alpha") {
        await reconcileReleaseBuilderRetentions(config, { lease, profile, request, readAdmission: () => store.readAdmission() });
        const recoverySignal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
        const historical = nativeAgentCanary(lease, profile, devBoatClient({ apiKey: env.BOAT_API_KEY }, recoverySignal), { release },
          { strictCleanup: true, releaseStorageDeferral: true, cleanupTimeoutMs: 0 });
        await reconcileReleaseCanaryRetirements(config, execution.actorUserId, lease, historical, broker.retire, { signal: recoverySignal });
      }
      const credentials = await broker.preflight(), releaseCanaryBindings = [...credentials.values()];
      let run = runs.find((value: any) => value.runId === config.runId);
      if (!run) {
        requireCheck(runs.length < 100, "Worker release recovery history reached its bound; reconcile before another run");
        run = { runId: config.runId, sourceSha: config.sourceSha, inputsSha256, actorUserId: execution.actorUserId, qualificationProfile, operationId: randomUUID(), canaries: [] };
        runs.push(run); await lease.save();
      }
      requireCheck(run.sourceSha === config.sourceSha && run.inputsSha256 === inputsSha256 && run.actorUserId === execution.actorUserId && run.qualificationProfile === qualificationProfile, "Worker recovery run identity or qualification profile changed");
      if (!run.releaseCanaryBindings) {
        requireCheck(!run.canaries.length && !run.evidence, "Worker recovery is missing its credential designation evidence; reconcile before a fresh run");
        run.releaseCanaryBindings = releaseCanaryBindings; await lease.save();
      }
      requireCheck(JSON.stringify(run.releaseCanaryBindings) === JSON.stringify(releaseCanaryBindings), "Worker credential designations changed during recovery; reconcile before a fresh run");
      if (!run.maxUsedHours) {
        const meter = await request("GET", `/limits?org=${encodeURIComponent(profile.boat.billingOrg)}`);
        requireCheck(meter.status === 200 && Number.isFinite(meter.body?.creditUsedSeconds) && meter.body.creditUsedSeconds >= 0, "Worker account-wide budget meter is unavailable");
        run.maxUsedHours = meter.body.creditUsedSeconds / 3600 + execution.budgetHours; await lease.save();
      }
      const images = state.resources.images;
      let record = images.find((value: any) => value.releaseRunId === config.runId);
      if (!record) {
        const slot = createHash("sha256").update(JSON.stringify([config.sourceSha, config.runId])).digest("hex");
        record = { releaseRunId: config.runId, purpose: "release-worker", inputsSha256, sourceCommit: config.sourceSha, snapshotId: workerSnapshotName(state, slot) };
        images.push(record); await lease.save();
      }
      const image = await boatImageAdapter(config, env, path.join(directory, "kit"), { lease, record, profile, maxUsedHours: run.maxUsedHours, snapshotName: record.snapshotId, request,
        reserve: async () => {
          await reconcileFailedReleaseBuilderHolds(config, { lease, profile, request, readAdmission: () => store.readAdmission() }, store);
          const inventory = await workerSnapshotInventory(request);
          await reconcileWorkerSnapshotHolds(store, lease, profile, inventory, request);
          return reserveWorkerSlot(store, lease, profile, config.channel, record.snapshotId, inventory);
        }, release, readAdmission: () => store.readAdmission() });
      const native = nativeAgentCanary(lease, { ...profile, boat: { ...profile.boat, builderBudgetHours: execution.canaryBudgetHours } }, request, {
        reserve: (job: any) => reserveHostedAdmission(store, state, profile, { kind: "builder", computeId: `canary:${job.id}` }), release,
      }, { strictCleanup: true, releaseStorageDeferral: true, maxUsedHours: run.maxUsedHours, cleanupTimeoutMs: 300_000,
        nativeDeadlineSeconds: qualificationProfile === "full" ? 2400 : 420 });
      const core = { ...native, retire: (job: any) => retireReleaseCanary(lease, native, broker.retire, job),
        start: (job: any, input: any) => native.start(job, input, undefined,
          async (_transport: any, target: any) => broker.start(target, job.kind, async intent => {
            requireCheck(!job.admissionRequest || JSON.stringify(job.admissionRequest) === JSON.stringify(intent), "Release canary retained admission intent changed");
            job.admissionRequest ??= intent; await lease.save();
          })) };
      const canary = releaseCanaryAdapter(lease, run, credentials, core, { qualificationProfile });
      const cleanup = async () => {
        const canariesRetired = await canary.cleanup();
        try {
          const imageBuilder = await image.cleanup();
          return canariesRetired && imageBuilder ? { ...releaseCanaryCleanup(lease, run), imageBuilder } : null;
        } catch { return null; }
      };
      try {
        const receipt = await promoteWorker({ ...config, kinds: execution.kinds, actorUserId: execution.actorUserId, operationId: run.operationId, inputsSha256, qualificationProfile, releaseCanaryBindings }, {
          build: () => image.build(), cleanupBuilder: () => image.cleanup(),
          qualify: async (candidate, kind) => { await current(); return canary.qualify(candidate, kind); }, cleanup, assertCurrent: current,
          saveEvidence: async evidence => { run.evidence = evidence; await lease.save(); },
          withOwner: runtimeOwnerAdapter(config, env, { lease, run }), updateIdentity: workerIdentityAdapter(config, env),
        });
        run.receipt = receipt; run.completedAt = receipt.completedAt; state.status = "ready"; await lease.save();
        return receipt;
      } catch (error) { await cleanup(); throw error; }
    }, { create: true });
  } finally { registry.close(); await rm(directory, { recursive: true, force: true }); }
}

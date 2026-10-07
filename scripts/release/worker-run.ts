import { createHash } from "node:crypto";
import { z } from "zod";
import { r2Registry, withHostedLease } from "../dev-environment/hosted-state.mjs";
import { devBoatClient } from "../dev-environment/hosted-image.mjs";
import { nativeAgentCanary } from "../dev-environment/native-agent-canary.mjs";
import { workerOwner } from "./worker-admission";
import { releaseCanaryBroker } from "./worker-broker";
import { workerExecutionConfig } from "./worker-config";
import type { WorkerReceipt } from "./worker";
import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { releaseHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { ReleaseIdentity, requireCheck, type PromotionConfig } from "./contracts";
import { githubClient } from "./github";
import { jsonClient } from "./io";
import type { WorkerQualificationProfile } from "./worker-profile";
import { reconcileReleaseBuilderRetentions, reconcileFailedReleaseBuilderHolds } from "./worker-builder-retirement";
import { reconcileReleaseCanaryRetirements } from "./worker-canary-recovery";

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
  const { config, actorUserId } = workerExecutionConfig(env, { cleanupOnly: true }), admission = workerAdmissionConfiguration(env);
  const github = githubClient(config, env), broker = releaseCanaryBroker(config, env, "smoke");
  await github.assertRequiredChecks(); await github.assertCurrent(); await assertWorkerApi(config);
  const { registry, identity, store } = workerStateStore(config, admission);
  try {
    requireCheck(await store.readAdmission(), "Initialize and reconcile the shared Boat admission ledger before release cleanup");
    const result = await withHostedLease(store, identity, async (lease: any) => {
      await github.assertRequiredChecks(); await github.assertCurrent(); await assertWorkerApi(config); await lease.fence();
      const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(15_000)]);
      const request = devBoatClient({ apiKey: env.BOAT_API_KEY }, signal);
      const builderContext = { lease, profile: admission.profile, request, readAdmission: () => store.readAdmission() };
      await reconcileReleaseBuilderRetentions(config, builderContext);
      await reconcileFailedReleaseBuilderHolds(config, builderContext, store);
      const core = nativeAgentCanary(lease, admission.profile, request,
        { release: () => releaseHostedAdmission(store, lease, admission.profile) },
        { strictCleanup: true, releaseStorageDeferral: true, cleanupTimeoutMs: 0 });
      return reconcileReleaseCanaryRetirements(config, actorUserId, lease, core, broker.retire, { signal });
    }, { create: false });
    requireCheck(typeof result === "number" || result?.absent === true, "Release native storage reconciliation result is unconfirmed");
    return typeof result === "number" ? result : 0;
  } finally { registry.close(); }
}

/** New v3 release builds are retired. Cleanup above deliberately has its own
 * guarded entry and must not pass through this producer. */
export async function executeWorkerPromotion(_env: NodeJS.ProcessEnv, _inputsSha256: string, _qualificationProfile: WorkerQualificationProfile): Promise<z.infer<typeof WorkerReceipt>> {
  refuseRetiredWorkerPromotion();
}

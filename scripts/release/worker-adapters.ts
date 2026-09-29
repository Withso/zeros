import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { main as imageKit, TEMPLATES, type KitDeps } from "../cloud-workspace-validation/boat-image/boat-image";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { devBoatClient, confirmBoatDeletion } from "../dev-environment/hosted-image.mjs";
import { manageCloudAgentRuntime } from "../../apps/control-plane/src/manage-cloud-agent-runtime";
import { planetScaleClient, roleConnectionString } from "../../apps/control-plane/src/manage-release-migration";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { requireCheck, type PromotionConfig } from "./contracts";
import { poll } from "./io";
import type { WorkerCandidate, WorkerDependencies } from "./worker";

/** Image-kit sequence also used by hosted-image.mjs, with committed source and
 * channel names, without creating Dev identities or changing build metadata. */
export async function buildBoatImage(input: { sourceSha: string; directory: string; baseSnapshot: string; maxUsedHours: number }, deps: {
  kit(args: string[]): Promise<any>; nameSnapshot(): Promise<string>; pause?: (ms: number) => Promise<void>;
}): Promise<WorkerCandidate> {
  const call = deps.kit, dir = path.join(input.directory, input.sourceSha.slice(0,12));
  await call(["export"]);
  await call(["builder", "create", "--from", input.baseSnapshot, "--max-used-hours", String(input.maxUsedHours)]);
  await poll(async () => ["ready", "running", "idle"].includes((await call(["builder", "status"])).state), { sleep: deps.pause, attempts: 30 });
  const previous = JSON.parse(await call(["builder", "run", path.join(TEMPLATES, "build-hash.sh")]));
  await call(["generate", "--previous", previous.commit]);
  const snapshotId = await deps.nameSnapshot();
  await call(["builder", "run", path.join(dir, "builder-preflight.sh")]);
  await call(["builder", "upload"]);
  await call(["builder", "run", path.join(dir, "install.sh"), "120"]);
  await poll(async () => {
    const result = JSON.parse(await call(["builder", "run", path.join(dir, "build-status.sh")]));
    requireCheck(!result.result || result.result.passed === true, "Native worker build failed");
    return result.result?.passed === true;
  }, { sleep: deps.pause, attempts: 150 });
  await call(["attestation", "start"]);
  const attestation = await poll(async () => {
    const result = await call(["attestation", "status"]);
    if (!result.finished) return false;
    requireCheck(result.qualified === true && result.matchesCommit === true && Number.isSafeInteger(result.measuredStorageMiB), "Worker attestation failed");
    return result;
  }, { sleep: deps.pause, attempts: 120 });
  await call(["generate-post"]);
  // snapshot save itself performs fresh sanitation and rejects private state.
  await call(["snapshot", "save"]);
  await poll(async () => (await call(["snapshot", "status"])).state === "ready", { sleep: deps.pause, attempts: 60 });
  return { snapshotId, sourceCommit: input.sourceSha, buildSha256: attestation.buildSha256, storageMiB: attestation.measuredStorageMiB, architecture: "linux/amd64" };
}
export async function boatImageAdapter(config: PromotionConfig, env: NodeJS.ProcessEnv, directory: string) {
  requireCheck(env.BOAT_API_KEY && env.BOAT_BILLING_ORG && env.BOAT_BASE_SNAPSHOT && /^[a-z0-9][a-z0-9-]{0,62}$/.test(env.BOAT_BASE_SNAPSHOT), "Boat image authority/configuration missing");
  const budget = Number(env.BOAT_BUILDER_BUDGET_HOURS);
  requireCheck(Number.isFinite(budget) && budget > 0 && budget <= 2, "Boat builder budget must be positive and at most two hours");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const request = devBoatClient({ apiKey: env.BOAT_API_KEY }, undefined);
  const meter = await request("GET", `/limits?org=${encodeURIComponent(env.BOAT_BILLING_ORG)}`);
  requireCheck(meter.status === 200 && Number.isFinite(meter.body?.creditUsedSeconds), "Boat meter is unavailable");
  const maxUsedHours = meter.body.creditUsedSeconds / 3600 + budget;
  const deps: KitDeps = { boat: request, billingOrg: env.BOAT_BILLING_ORG, repoRoot: process.cwd(), stateDir: directory,
    imageContract: imageContractSha256, now: Date.now, randomUUID, randomHex: () => randomBytes(16).toString("hex") };
  return {
    build: () => buildBoatImage({ sourceSha: config.sourceSha, directory, baseSnapshot: env.BOAT_BASE_SNAPSHOT!, maxUsedHours }, {
      kit: args => imageKit(args, deps),
      nameSnapshot: async () => {
        const file = path.join(directory, config.sourceSha.slice(0,12), "generation.json");
        const generation = JSON.parse(await readFile(file, "utf8"));
        generation.snapshotName = `zeros-${config.channel}-${config.sourceSha.slice(0,16)}-${config.runId}`;
        requireCheck(generation.snapshotName.length <= 63, "Worker snapshot name exceeds provider bound");
        await writeFile(file, JSON.stringify(generation), { mode: 0o600 });
        return generation.snapshotName;
      },
    }),
    async cleanup() {
      const file = path.join(directory, "builder.json");
      let builder;
      try { builder = JSON.parse(await readFile(file, "utf8")); } catch { return false; }
      const lease = { signal: undefined, save: () => writeFile(file, JSON.stringify(builder), { mode: 0o600 }), fence: async () => {} };
      await confirmBoatDeletion(lease, builder, request, { allowDeferredStorage: false });
      return builder.deleted === true;
    },
  };
}
/** One short-lived login spans both operator calls. No permanent DATABASE_URL
 * is accepted from the job, and the runtime application never receives DDL. */
export function runtimeOwnerAdapter(config: PromotionConfig, env: NodeJS.ProcessEnv): WorkerDependencies["withOwner"] {
  const request = planetScaleClient({ organization: config.organization, tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID!, token: env.PLANETSCALE_SERVICE_TOKEN! });
  return async action => {
    const route = `/databases/${config.database}/branches/${config.databaseBranch}/roles`;
    const created = await request("POST", route, { name: `zeros-worker-${randomUUID()}`, inherited_roles: ["postgres"], ttl: 3600 });
    const role = created.body as any;
    requireCheck(created.status < 300 && typeof role?.id === "string", "Worker owner role creation unconfirmed");
    let deleted = false;
    let value;
    try {
      requireCheck(typeof role.password === "string" && typeof role.username === "string" && typeof role.access_host_url === "string", "Worker owner role response incomplete");
      const databaseUrl = roleConnectionString(role);
      const pool = createMigrationPool(databaseUrl, { role: "postgres", maxConnections: 1, applicationName: "zeros-worker-promotion" });
      try {
        value = await action({ loginIdentity: role.username, manage: (document, approval) => manageCloudAgentRuntime(pool, document, {
          databaseUrl, channel: config.channel, execute: approval !== undefined, ...(approval ? { approval } : {}),
        }) });
      } finally { await pool.end(); }
    } finally {
      const response = await request("DELETE", `${route}/${encodeURIComponent(role.id)}`).catch(() => ({ status: 0 }));
      deleted = response.status >= 200 && response.status < 300; role.password = "";
    }
    return { value, deleted };
  };
}

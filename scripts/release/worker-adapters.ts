import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { main as imageKit, KitError, TEMPLATES, type KitDeps } from "../cloud-workspace-validation/boat-image/boat-image";
import { imageContractSha256 } from "../cloud-workspace-validation/config";
import { devBoatClient } from "../dev-environment/hosted-image.mjs";
import { dispatchDevCreate, acknowledgeDevCreate, DevProviderError } from "../dev-environment/provider-http.mjs";
import { manageCloudAgentRuntime, nativeCapabilitiesFromChecks } from "../../apps/control-plane/src/manage-cloud-agent-runtime";
import { planetScaleClient, roleConnectionString } from "../../apps/control-plane/src/manage-release-migration";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { DIGEST, SHA, PromotionError, requireCheck, type PromotionConfig } from "./contracts";
import { poll } from "./io";
import type { WorkerCandidate, WorkerDependencies } from "./worker";
import { WorkerBuilderCreationBodySchema, releaseBuilderCreationScope, retireReleaseBuilder, retireFailedReleaseBuilder } from "./worker-builder-retirement";

/** Image-kit sequence also used by hosted-image.mjs, with committed source and
 * channel names, without creating Dev identities or changing build metadata. */
export async function buildBoatImage(input: { sourceSha: string; directory: string; baseSnapshot: string; maxUsedHours: number; state?: any }, deps: {
  kit(args: string[]): Promise<any>; nameSnapshot(): Promise<string>; pause?: (ms: number) => Promise<void>; exists?: (file: string) => boolean; save?: () => Promise<void>;
}): Promise<WorkerCandidate> {
  requireCheck(SHA.test(input.sourceSha) && Number.isFinite(input.maxUsedHours) && input.maxUsedHours > 0, "Invalid worker build identity or budget");
  const call = deps.kit, dir = path.join(input.directory, input.sourceSha.slice(0,12));
  const state = input.state ?? {}, exists = deps.exists ?? (() => false);
  requireCheck(!exists(path.join(dir, "source.json")) || state.installStarted || exists(path.join(dir, "source.tar.gz")),
    "Worker recovery archive is missing; reconcile the original build before another allocation or upload");
  if (!exists(path.join(dir, "source.json"))) await call(["export"]);
  if (!exists(path.join(input.directory, "builder.json"))) await call(["builder", "create", "--from", input.baseSnapshot, "--max-used-hours", String(input.maxUsedHours)]);
  await poll(async () => {
    const status = await call(["builder", "status"]);
    requireCheck(status.wallet === "billing-org", "Worker builder billing identity is unconfirmed");
    return ["ready", "running", "idle"].includes(status.state);
  }, { sleep: deps.pause, attempts: 30, timeoutMs: 5 * 60_000 });
  if (!exists(path.join(dir, "generation.json"))) {
    const previous = JSON.parse(await call(["builder", "run", path.join(TEMPLATES, "build-hash.sh")]));
    requireCheck(SHA.test(previous.commit ?? ""), "Worker base source is unconfirmed");
    await call(["generate", "--previous", previous.commit]);
  }
  const snapshotId = await deps.nameSnapshot();
  if (!state.installStarted) {
    await call(["builder", "run", path.join(dir, "builder-preflight.sh")]);
    await call(["builder", "upload"]);
    state.installStarted = true; await deps.save?.();
    await call(["builder", "run", path.join(dir, "install.sh"), "120"]);
  }
  await poll(async () => {
    const result = JSON.parse(await call(["builder", "run", path.join(dir, "build-status.sh")]));
    requireCheck(!result.result || result.result.passed === true, "Native worker build failed");
    return result.result?.passed === true;
  }, { sleep: deps.pause, attempts: 150 });
  if (!state.attestationStarted) { state.attestationStarted = true; await deps.save?.(); await call(["attestation", "start"]); }
  const attestation = await poll(async () => {
    const result = await call(["attestation", "status"]);
    if (!result.finished) return false;
    requireCheck(result.qualified === true && result.matchesCommit === true && result.sourceCommit === input.sourceSha && DIGEST.test(result.buildSha256 ?? "") &&
      Number.isSafeInteger(result.measuredStorageMiB) && result.measuredStorageMiB > 0, "Worker attestation failed");
    return result;
  }, { sleep: deps.pause, attempts: 120 });
  if (!exists(path.join(dir, "sanitize.sh"))) await call(["generate-post"]);
  // snapshot save itself performs fresh sanitation and rejects private state.
  if (!exists(path.join(dir, "snapshot-ledger.json"))) await call(["snapshot", "save"]);
  await poll(async () => (await call(["snapshot", "status"])).state === "ready", { sleep: deps.pause, attempts: 60 });
  return { snapshotId, sourceCommit: input.sourceSha, buildSha256: attestation.buildSha256, storageMiB: attestation.measuredStorageMiB, architecture: "linux/amd64" };
}
export async function boatImageAdapter(config: PromotionConfig, env: NodeJS.ProcessEnv, directory: string, context: {
  lease: any; record: any; profile: any; maxUsedHours: number; snapshotName: string; reserve(): Promise<unknown>; release(): Promise<unknown>;
  request?: any; kit?: typeof imageKit; readAdmission?: () => Promise<any>;
}) {
  requireCheck(env.BOAT_API_KEY && env.BOAT_BILLING_ORG && env.BOAT_BASE_SNAPSHOT && /^[a-z0-9][a-z0-9-]{0,62}$/.test(env.BOAT_BASE_SNAPSHOT), "Boat image authority/configuration missing");
  const budget = Number(env.BOAT_BUILDER_BUDGET_HOURS);
  requireCheck(Number.isFinite(budget) && budget > 0 && budget <= 2, "Boat builder budget must be positive and at most two hours");
  requireCheck(context && context.record.sourceCommit === config.sourceSha && context.record.snapshotId === context.snapshotName, "Worker build requires a bound shared-account admission receipt");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const request = context.request ?? devBoatClient({ apiKey: env.BOAT_API_KEY }, context.lease.signal);
  const { lease, record } = context;
  const attestationCommand = /^commands\/\d{1,16}-attest-status\.sh\.json$/;
  const allowed = /^(?:builder(?:-intent)?\.json|[a-f0-9]{12}\/\w[\w-]*\.(?:json|sh)|commands\/\d{1,16}-attest-status\.sh\.json)$/;
  for (const [file, text] of Object.entries(record.kitFiles ?? {})) {
    requireCheck(allowed.test(file) && typeof text === "string" && text.length <= 512 * 1024, "Invalid worker recovery receipt");
    const target = path.join(directory, file); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // "wx" keeps a file the interrupted build already wrote, without a separate
    // existence check that could race with it.
    await writeFile(target, text, { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const persist = async () => {
    const files: Record<string, string> = {};
    const entries = fs.readdirSync(directory, { recursive: true });
    // Keep one private status response, including the failure that precedes
    // native-attestation.json. Polling must not grow the encrypted journal.
    const latestAttestation = entries.filter((file): file is string => typeof file === "string" && attestationCommand.test(file))
      .sort((left, right) => Number(right.slice(9).split("-")[0]) - Number(left.slice(9).split("-")[0]))[0];
    for (const file of entries) {
      if (typeof file !== "string" || !allowed.test(file)) continue;
      if (attestationCommand.test(file) && file !== latestAttestation) continue;
      // Check and read one descriptor, opened without following a symlink, so
      // the file cannot be swapped between the check and the read.
      let descriptor = -1;
      try { descriptor = fs.openSync(path.join(directory, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch {}
      requireCheck(descriptor >= 0, "Invalid worker kit recovery file");
      try {
        const stat = fs.fstatSync(descriptor);
        requireCheck(stat.isFile() && stat.size <= 512 * 1024, "Invalid worker kit recovery file");
        const text = fs.readFileSync(descriptor, "utf8");
        files[file] = attestationCommand.test(file) && Buffer.byteLength(text) > 64 * 1024
          ? JSON.stringify({ truncated: true, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"),
            head: text.slice(0, 8192), tail: text.slice(-8192) }) : text;
      } finally {
        fs.closeSync(descriptor);
      }
    }
    requireCheck(JSON.stringify(files).length <= 1024 * 1024, "Worker kit recovery receipt exceeds its bound");
    record.kitFiles = files; await lease.save();
  };
  const meter = await request("GET", `/limits?org=${encodeURIComponent(env.BOAT_BILLING_ORG)}`);
  requireCheck(meter.status === 200 && Number.isFinite(meter.body?.creditUsedSeconds), "Boat meter is unavailable");
  record.maxUsedHours ??= Math.min(context.maxUsedHours, meter.body.creditUsedSeconds / 3600 + budget); await lease.save();
  const maxUsedHours = record.maxUsedHours;
  const deps: KitDeps = { boat: async (method, route, options = {}) => {
    await persist(); await lease.fence();
    const previous = Boolean(record.builderIntent);
    const key = method === "POST" && route === "/sandboxes" ? "builderCreate" : method === "POST" && route === "/named-snapshots" ? "snapshotCreate" : null;
    if (key === "builderCreate") {
      if (!record.builderIntent) {
        const body = WorkerBuilderCreationBodySchema.safeParse(options.body);
        requireCheck(context.profile.boat?.accountScope === env.BOAT_ACCOUNT_SCOPE && context.profile.boat.billingOrg === env.BOAT_BILLING_ORG &&
          context.profile.boat.baseSnapshot === env.BOAT_BASE_SNAPSHOT && body.success && body.data.from === env.BOAT_BASE_SNAPSHOT,
          "Worker builder original account/base/environment intent is invalid");
        const scope = await releaseBuilderCreationScope(config, { lease, record, profile: context.profile, request, readAdmission: context.readAdmission });
        record.builderIntent = { body: options.body, key: options.headers?.["idempotency-key"], at: Date.now(), scope };
      }
      await lease.save();
    }
    if (key === "snapshotCreate") { record.snapshotRequested = true; await lease.save(); }
    const dispatch = async () => {
      const response = await request(method, route, options);
      if (key && response.status >= 300) throw new DevProviderError("Boat Dev", response.status, response.requestId);
      if (key === "builderCreate") {
        requireCheck(/^bx_[a-z0-9]+$/.test(response.body?.sandbox?.id ?? ""), "Worker builder allocation is unconfirmed");
        record.builder = { id: response.body.sandbox.id }; await lease.save();
      }
      const sandbox = response.body?.sandbox;
      if (response.status >= 200 && response.status < 300 && sandbox && record.builder && sandbox.id === record.builder.id &&
          sandbox.team?.id === env.BOAT_BILLING_ORG && record.builderIntent?.scope && !record.builder.billingOrgConfirmed) {
        record.builder.billingOrgConfirmed = true; record.builder.billingObservedAt = new Date().toISOString();
        record.builder.accountBinding = record.builderIntent.scope.accountBinding; await lease.save();
      }
      return response;
    };
    if (!key) return dispatch();
    const intent = record.builderIntent;
    const idempotentReplay = key === "builderCreate" && previous && intent.key === options.headers?.["idempotency-key"] &&
      JSON.stringify(intent.body) === JSON.stringify(options.body) && Date.now() - intent.at < 23 * 3600_000;
    return dispatchDevCreate(lease, record, "Boat Dev", dispatch, { key, idempotentReplay });
  }, billingOrg: env.BOAT_BILLING_ORG, repoRoot: process.cwd(), stateDir: directory,
    imageContract: imageContractSha256, now: Date.now, randomUUID, randomHex: () => randomBytes(16).toString("hex") };
  const call = async (args: string[]) => {
    const measured = await request("GET", `/limits?org=${encodeURIComponent(env.BOAT_BILLING_ORG!)}`);
    requireCheck(measured.status === 200 && Number.isFinite(measured.body?.creditUsedSeconds) && measured.body.creditUsedSeconds / 3600 < maxUsedHours, "Worker builder account-wide budget is unavailable or exhausted");
    if (record.builder && !record.builder.deleted && Date.now() - (record.lastRenewedAt ?? record.builderIntent?.at ?? Date.now()) > 45 * 60_000) {
      record.lastRenewedAt = Date.now(); await lease.save();
      await (context.kit ?? imageKit)(["builder", "renew", "--max-used-hours", String(maxUsedHours)], deps);
    }
    try { return await (context.kit ?? imageKit)(args, deps); }
    catch (error) {
      if (args[0] === "attestation" && error instanceof KitError) throw new PromotionError("Worker image attestation failed; private command receipt retained");
      throw error;
    }
    finally { await persist(); }
  };
  const verify = async () => {
    const response = await request("GET", `/named-snapshots/${record.snapshotId}`), snapshot = response.body?.snapshot;
    requireCheck(response.status === 200 && snapshot?.name === record.snapshotId && snapshot.status === "ready" && snapshot.sourceSandboxId === record.builder?.id,
      "Worker snapshot identity is unconfirmed; reconcile before another capture");
    await acknowledgeDevCreate(lease, record, "snapshotCreate");
  };
  return {
    async build() {
      if (record.candidate) { await verify(); return record.candidate as WorkerCandidate; }
      await context.reserve();
      const image = await buildBoatImage({ sourceSha: config.sourceSha, directory, baseSnapshot: env.BOAT_BASE_SNAPSHOT!, maxUsedHours, state: record }, {
      kit: call, exists: fs.existsSync, save: () => lease.save(),
      nameSnapshot: async () => {
        const file = path.join(directory, config.sourceSha.slice(0,12), "generation.json");
        const generation = JSON.parse(await readFile(file, "utf8"));
        generation.snapshotName = context.snapshotName;
        requireCheck(generation.snapshotName.length <= 63, "Worker snapshot name exceeds provider bound");
        await writeFile(file, JSON.stringify(generation), { mode: 0o600 });
        await persist(); return generation.snapshotName;
      },
      });
      await verify(); record.candidate = image; record.buildSha256 = image.buildSha256; record.qualified = true; await lease.save();
      return image;
    },
    async cleanup() {
      if (!record.builder && record.builderIntent && !["planned", "rejected"].includes(record.builderCreate?.phase)) {
        requireCheck(Date.now() - record.builderIntent.at < 23 * 3600_000, "Worker builder creation requires reconciliation outside its replay window");
        await dispatchDevCreate(lease, record, "Boat Dev", async () => {
          const response = await request("POST", "/sandboxes", { body: record.builderIntent.body, headers: { "idempotency-key": record.builderIntent.key, "x-boat-org": env.BOAT_BILLING_ORG } });
          requireCheck(response.status < 300 && /^bx_[a-z0-9]+$/.test(response.body?.sandbox?.id ?? ""), "Worker builder creation reconciliation is unconfirmed");
          record.builder = { id: response.body.sandbox.id }; await lease.save();
        }, { key: "builderCreate", idempotentReplay: true });
      }
      const retirement = { lease, record, profile: context.profile, request, readAdmission: context.readAdmission };
      let result = null;
      if (record.builder) {
        const uncaptured = !record.candidate && !record.builderProvenance && !record.builder.cleanup && !record.snapshotRequested &&
          record.snapshotCreate === undefined && record.builderCreate?.phase === "acknowledged" && record.builder.billingOrgConfirmed &&
          record.builderIntent?.scope && record.kitFiles?.["builder.json"] && record.kitFiles?.[`${config.sourceSha.slice(0, 12)}/source.json`];
        if (record.builder.failedBuildRetirement || uncaptured) await retireFailedReleaseBuilder(config, retirement);
        else result = await retireReleaseBuilder(config, retirement);
      }
      await context.release(); return result;
    },
  };
}
/** One short-lived login spans both operator calls. No permanent DATABASE_URL
 * is accepted from the job, and the runtime application never receives DDL. */
export async function reconcileRuntimeApproval(pool: any, document: any, expected?: { planSha256: string; targetSha256: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cloud-runtime-qualification:${document.evidence.provider}:${document.evidence.imageRef}`]);
    const receipt = (await client.query(`SELECT request_sha256,target_sha256,plan_sha256,evidence_sha256,deployment_channel,source_commit,actor_user_id
      FROM cloud_agent_runtime_qualification_changes WHERE operation_id=$1`, [document.operationId])).rows[0];
    if (!receipt) return null;
    requireCheck(receipt.request_sha256 === createHash("sha256").update(JSON.stringify(document)).digest("hex") &&
      receipt.evidence_sha256 === document.evidence.evidenceSha256 && receipt.deployment_channel === configChannel(document) && receipt.source_commit === document.evidence.sourceCommit &&
      receipt.actor_user_id === document.actorUserId && DIGEST.test(receipt.plan_sha256) && DIGEST.test(receipt.target_sha256) &&
      (!expected || receipt.plan_sha256 === expected.planSha256 && receipt.target_sha256 === expected.targetSha256), "Runtime approval reconciliation does not match the retained exact request and target");
    const owner = await client.query("SELECT 1 FROM users WHERE id=$1 AND staff_role='platform_owner' AND auth_status='active' AND deleted_at IS NULL", [document.actorUserId]);
    requireCheck(owner.rowCount === 1, "Runtime approval reconciliation requires the accountable active platform owner");
    const rows = (await client.query(`SELECT credential_kind,profile,enabled,mcp_qualified,native_capabilities,qualified_at
      FROM cloud_agent_runtime_qualifications WHERE provider=$1 AND image_ref=$2 AND runtime_contract_sha256=$3`,
    [document.evidence.provider, document.evidence.imageRef, document.evidence.runtimeContractSha256])).rows;
    requireCheck(rows.length === document.evidence.credentials.length && document.evidence.credentials.every((credential: any) => {
      const row = rows.find((value: any) => value.credential_kind === credential.kind), capabilities = nativeCapabilitiesFromChecks(credential);
      return row && row.enabled === true && row.mcp_qualified === true && row.profile === document.evidence.profile &&
        new Date(row.qualified_at).getTime() === Date.parse(document.evidence.qualifiedAt) &&
        Object.entries(capabilities).every(([key, value]) => row.native_capabilities?.[key] === value);
    }), "Runtime approval readback is missing an enabled exact-image native kind or capability");
    return { state: "replayed", planSha256: receipt.plan_sha256, targetSha256: receipt.target_sha256 };
  } finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
}
const configChannel = (document: any) => document.evidence.channel;

export function runtimeOwnerAdapter(config: PromotionConfig, env: NodeJS.ProcessEnv, options: {
  lease: any; run: any; request?: any; pool?: typeof createMigrationPool; manage?: typeof manageCloudAgentRuntime;
}): WorkerDependencies["withOwner"] {
  const request = options.request ?? planetScaleClient({ organization: config.organization, tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID!, token: env.PLANETSCALE_SERVICE_TOKEN! });
  const { lease, run } = options;
  const route = `/databases/${config.database}/branches/${config.databaseBranch}/roles`;
  const findLostRole = async (name: string) => {
    let found;
    for (let page = 1; page <= 10; page++) {
      const result = await request("GET", `${route}?per_page=100&page=${page}`);
      requireCheck(result.status === 200 && Array.isArray(result.body?.data), "Worker owner role inventory is unconfirmed");
      for (const role of result.body.data) if (role.name === name) { requireCheck(!found, "Worker owner role intent has multiple provider matches"); found = role; }
      if (result.body.data.length < 100) return found;
    }
    throw new PromotionError("Worker owner role inventory exceeded its page bound");
  };
  const removeRole = async (role: any) => {
    if (role.deleted) return true;
    if (!role.id) {
      if (["planned", "rejected"].includes(role.phase)) { role.deleted = true; await lease.save(); return true; }
      const found = await findLostRole(role.name);
      requireCheck(found && typeof found.id === "string" && found.id.length > 0 && found.id.length <= 128,
        "Worker owner role creation remains uncertain; reconcile its retained intent before retrying");
      role.id = found.id; role.username = found.username; await lease.save();
    }
    const target = `${route}/${encodeURIComponent(role.id)}`;
    const before = await request("GET", target);
    requireCheck(before.status === 404 || before.status === 200 && before.body?.id === role.id && before.body?.name === role.name &&
      (!role.username || before.body.username === role.username), "Worker owner role deletion identity changed");
    if (before.status === 200) {
      role.deleteRequested = true; await lease.save(); await lease.fence();
      await request("DELETE", target).catch(() => ({ status: 0 }));
    }
    const after = await request("GET", target);
    requireCheck(after.status === 404, "Worker owner role deletion is unconfirmed");
    role.deleted = true; delete role.credentials; await lease.save(); return true;
  };
  return async action => {
    const branch = await request("GET", `/databases/${config.database}/branches/${config.databaseBranch}`);
    requireCheck(branch.status === 200 && branch.body?.name === config.databaseBranch && branch.body.production === true, "Worker owner target must be this channel's primary production branch");
    if (run.ownerRole && !run.ownerRole.deleted && !run.ownerRole.credentials) await removeRole(run.ownerRole);
    if (!run.ownerRole || run.ownerRole.deleted) { run.ownerRole = { name: `zeros-worker-${randomUUID()}`, phase: "planned" }; await lease.save(); }
    const role = run.ownerRole;
    let deleted = false;
    let value;
    try {
      if (!role.credentials) {
        role.phase = "dispatched"; await lease.save(); await lease.fence();
        const created = await request("POST", route, { name: role.name, inherited_roles: ["postgres"], ttl: 3600 });
        if ([401, 403].includes(created.status)) { role.phase = "rejected"; await lease.save(); }
        requireCheck(created.status >= 200 && created.status < 300 && typeof created.body?.id === "string" && created.body.id.length > 0 && created.body.id.length <= 128,
          "Worker owner role creation is unconfirmed; reconcile its retained intent");
        role.id = created.body.id; role.username = created.body.username; role.credentials = created.body; role.phase = "active"; await lease.save();
      }
      const credentials = role.credentials;
      requireCheck(typeof credentials.password === "string" && typeof credentials.username === "string" && typeof credentials.access_host_url === "string", "Worker owner role response incomplete");
      const databaseUrl = roleConnectionString(credentials);
      const pool = (options.pool ?? createMigrationPool)(databaseUrl, { role: "postgres", maxConnections: 1, applicationName: "zeros-worker-promotion" });
      try {
        value = await action({ loginIdentity: credentials.username, manage: async (document: any, approval) => {
          requireCheck(document.evidence.channel === config.channel && document.evidence.sourceCommit === config.sourceSha && document.operationId === run.operationId,
            "Worker runtime approval request does not match this channel, source and operation");
          const recorded = await reconcileRuntimeApproval(pool, document, run.approval);
          if (recorded) {
            requireCheck(!approval || approval === recorded.planSha256, "Worker replay approval hash does not match its audit receipt");
            run.approval = { ...recorded, phase: "applied" }; await lease.save(); return recorded;
          }
          if (approval) { run.approval.phase = "dispatched"; await lease.save(); await lease.fence(); }
          let result;
          try {
            result = await (options.manage ?? manageCloudAgentRuntime)(pool, document, {
              databaseUrl, channel: config.channel, execute: approval !== undefined, ...(approval ? { approval } : {}),
            });
          } catch {
            const reconciled = await reconcileRuntimeApproval(pool, document, run.approval);
            requireCheck(reconciled, "Worker runtime approval did not apply; its primary audit was reconciled before stopping this attempt");
            result = reconciled;
          }
          run.approval = { ...result, phase: approval ? "applied" : "planned" }; await lease.save();
          if (approval) {
            const confirmed = await reconcileRuntimeApproval(pool, document, result);
            requireCheck(confirmed, "Worker runtime approval primary readback is unconfirmed");
          }
          return result;
        } });
      } finally { await pool.end(); }
    } finally {
      try { deleted = await removeRole(role); }
      catch { deleted = false; }
    }
    requireCheck(deleted, "Worker approval owner-role deletion is unconfirmed; no tuple or receipt may be published");
    return { value, deleted };
  };
}

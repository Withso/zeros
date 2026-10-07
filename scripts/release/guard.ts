import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CHANNELS, ReleaseIdentity, releaseSource, promotionConfig, PromotionError, type Channel } from "./contracts";
import { channelBaseline, migrationManifest, workerInputsSha256 } from "./source";
import { githubClient } from "./github";

type DisabledCandidate = { channel: Channel; sourceSha: string; cloudEnabled: boolean; provider?: string; repository?: string; branch?: string };
type GuardDependencies = { fetch?: typeof fetch; channelBaseline?: typeof channelBaseline; migrationManifest?: typeof migrationManifest; workerInputsSha256?: typeof workerInputsSha256;
  cutoverReceipt?: (channel: Channel, sourceSha: string, manifestSha256: string) => Promise<boolean> };

/** One anonymous, bounded read; the rollout switch must not need provider
 * credentials, follow redirects, retry a stalled origin, or print its body. */
export async function publicIdentity(channel: Channel, fetcher: typeof fetch = fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("identity timeout")); }, 5_000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(`${CHANNELS[channel].api}/v1/release-identity`, { method: "GET", credentials: "omit",
        redirect: "error", cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      if (response.status === 404 || response.status === 403) return { present: false, identity: null };
      if (!response.ok && response.status !== 503) return { present: true, identity: null };
      const text = await response.text();
      if (text.length > 64 * 1024) return { present: true, identity: null };
      let value: unknown;
      try { value = JSON.parse(text); } catch { return { present: true, identity: null }; }
      const parsed = ReleaseIdentity.safeParse(value);
      return { present: true, identity: response.ok && parsed.success && parsed.data.channel === channel && parsed.data.migrations.head === parsed.data.migrations.expectedHead ? parsed.data : null };
    })(), deadline]);
  } catch { return { present: false, identity: null }; } finally { clearTimeout(timer); }
}

/** The commit a channel's Pages surface serves, from its anonymous deployment
 * manifest; null when unavailable or malformed. Same bounds as identity. */
export async function publicPagesSource(origin: string, surface: "app" | "ops", fetcher: typeof fetch = fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("pages timeout")); }, 5_000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(`${origin}/zeros-deployment.json`, { method: "GET", credentials: "omit",
        redirect: "error", cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > 4 * 1024) return null;
      const value = JSON.parse(text);
      return value?.version === 1 && value.surface === surface && typeof value.commitSha === "string" && /^[a-f0-9]{40}$/.test(value.commitSha)
        ? value.commitSha as string : null;
    })(), deadline]);
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function hostedWorkerPromotionRequired(enabled: boolean, _candidate: Pick<DisabledCandidate, "channel" | "sourceSha" | "provider">, _deps: GuardDependencies = {}) {
  if (!enabled) return false;
  refuseRetiredWorkerPromotion();
}

function manualCutoverSteps(candidate: DisabledCandidate) {
  const database = `zeros-control-plane-${candidate.channel}`;
  return `Owner steps: dispatch controlled-cutover.yml for ${candidate.channel} from ${candidate.branch || "the release branch"} at ${candidate.sourceSha}, ` +
    `with approvals listing exactly the plan's pending controlled migrations and confirm=${database}. It holds independent deploys, fences writers ` +
    `with maintenance mode, backs up and migrates, deploys this SHA, uploads Pages and verifies WorkOS; its receipt is required here. ` +
    `Then re-run the failed Release (${candidate.channel}) workflow for the same SHA. See docs/deployment-environments.md for controlled cutovers and recovery.`;
}

export async function disabledGuard(_files: string[], candidate: DisabledCandidate, deps: GuardDependencies = {}) {
  // Event-local diffs lose an unresolved migration on descendant pushes and
  // have no meaningful base on dispatch. Only published channel state counts.
  const manifest = await (deps.migrationManifest ?? migrationManifest)(candidate.sourceSha);
  let baseline: Awaited<ReturnType<typeof channelBaseline>> = null;
  try {
    baseline = deps.channelBaseline ? await deps.channelBaseline(candidate.channel) : await channelBaseline(candidate.channel, undefined,
      () => githubClient({ sourceSha: candidate.sourceSha, repository: candidate.repository ?? process.env.GITHUB_REPOSITORY ?? "",
        branch: candidate.branch ?? "" }, process.env).lastPublication(candidate.channel));
  } catch { /* Missing GitHub authority/history is not proof; live identity can still verify manual cutover. */ }
  let previous: Awaited<ReturnType<typeof migrationManifest>> | undefined;
  if (baseline) { try { previous = await (deps.migrationManifest ?? migrationManifest)(baseline.sourceSha); } catch { /* Require live proof below. */ } }
  const observed = await publicIdentity(candidate.channel, deps.fetch ?? fetch), identity = observed.identity;
  const identityMatches = !!identity && (identity.sourceSha === candidate.sourceSha ||
    identity.migrations.expectedHead === manifest.head && identity.migrations.manifestSha256 === manifest.sha256);
  // Unless the published schema is verifiably unchanged, the matching API was
  // cut over. That cutover is complete only with its own controlled-cutover
  // receipt (API, Pages and WorkOS) and every Pages surface serving the same
  // commit, so a stopped or unknown cutover cannot authorize publication.
  const verifiedUnchanged = !!previous && previous.sha256 === manifest.sha256;
  let pagesVerified = true, receiptVerified = true;
  if (identityMatches && !verifiedUnchanged) {
    const { app, ops } = CHANNELS[candidate.channel];
    const surfaces: [string, "app" | "ops"][] = ops ? [[app, "app"], [ops, "ops"]] : [[app, "app"]];
    const served = await Promise.all(surfaces.map(([origin, surface]) => publicPagesSource(origin, surface, deps.fetch ?? fetch)));
    pagesVerified = served.every(sha => sha === identity!.sourceSha);
    try {
      receiptVerified = await (deps.cutoverReceipt ?? ((channel: Channel, sha: string, manifestSha256: string) => githubClient({ sourceSha: candidate.sourceSha,
        repository: candidate.repository ?? process.env.GITHUB_REPOSITORY ?? "", branch: candidate.branch ?? "" }, process.env)
        .cutoverReceipt(channel, sha, manifestSha256)))(candidate.channel, identity!.sourceSha, identity!.migrations.manifestSha256);
    } catch { receiptVerified = false; }
  }
  const manualCutoverVerified = identityMatches && pagesVerified && receiptVerified;
  let workerChanged = true, workerVerified = false;
  const hash = deps.workerInputsSha256 ?? workerInputsSha256;
  if (baseline) { try { workerChanged = await hash(baseline.sourceSha) !== await hash(candidate.sourceSha); } catch { /* Unknown is changed. */ } }
  if (identity?.cloud.enabled && identity.cloud.state === "healthy" && identity.workerQualified === true && identity.worker?.provider === (candidate.provider || "boat")) {
    try {
      workerVerified = identity.worker.sourceSha === candidate.sourceSha ||
        await hash(identity.worker.sourceSha) === await hash(candidate.sourceSha);
    } catch { /* Unavailable history is not qualification; never print child diagnostics. */ }
  }
  const migrations = observed.present ? !manualCutoverVerified : !previous || previous.sha256 !== manifest.sha256;
  const needsWorker = candidate.cloudEnabled && (observed.present || workerChanged);
  const changes = { migrations, worker: workerChanged };
  const blocked = migrations && !manualCutoverVerified || needsWorker && !workerVerified;
  const notes = ["Hosted promotion is DISABLED.",
    `Channel baseline: ${baseline ? `${baseline.tag} at ${baseline.sourceSha}` : "unavailable"}; live identity: ${observed.present ? "authoritative" : "unavailable"}.`,
    `Migration changes: ${changes.migrations ? "yes" : "no"}; worker input changes: ${changes.worker ? "yes" : "no"}; cloud-enabled desktop: ${candidate.cloudEnabled ? "yes" : "no"}.`,
    "This guard performed no backend, database, worker, or Pages mutations."];
  if (baseline?.evidence) notes.push(baseline.evidence);
  if (!baseline) notes.push("Published baseline unavailable: require the channel tag and retained successful release publish-step evidence (GitHub actions:read), or verify manual cutover through live identity.");
  if (manualCutoverVerified) notes.push("manual cutover verified by the public release identity; this is not a hosted success receipt or backup audit.");
  if (identityMatches && !pagesVerified) notes.push("The API reports the cutover, but the channel's Pages do not serve its commit yet; finish the cutover's Pages upload before publication.");
  if (identityMatches && pagesVerified && !receiptVerified) notes.push(`No successful controlled-cutover receipt exists for ${identity!.sourceSha}; run or finish controlled-cutover.yml for this channel before publication.`);
  if (changes.migrations && !manualCutoverVerified) notes.push("Candidate migration cutover is not verified. Without a published channel baseline or matching live identity, publication is blocked.", manualCutoverSteps(candidate));
  if (changes.worker && !candidate.cloudEnabled) notes.push("Worker input changes are warning-only because this desktop builds with cloud disabled.");
  if (workerVerified) notes.push("Qualified live worker identity matches the candidate's committed worker inputs.");
  if (needsWorker && !workerVerified) notes.push("Cloud-enabled desktop requires a qualified matching live worker: build and natively qualify the candidate image, apply cloud-runtime:manage plan then execute with the same owner login, select the complete worker tuple, deploy the backend, verify public readiness, and rerun this workflow.");
  notes.push(blocked ? "Desktop publication is blocked." : "Legacy desktop publication may proceed; hosted promotion remains disabled.");
  return { ...changes, blocked, manualCutoverVerified, workerVerified, message: notes.join(" ") };
}
async function main() {
  if (process.env.ZEROS_WORKER_PROMOTION === "enabled") refuseRetiredWorkerPromotion();
  const source = releaseSource(process.env);
  const enabled = process.env.ZEROS_HOSTED_PROMOTION === "enabled";
  if (enabled) promotionConfig(process.env); // Missing authority is a failure, never a silent skip.
  const workerRequired = enabled && await hostedWorkerPromotionRequired(process.env.ZEROS_WORKER_PROMOTION === "enabled", {
    ...source, provider: process.env.CLOUD_WORKSPACE_PROVIDER,
  });
  const result = enabled ? { blocked: false, message: "Hosted promotion enabled; required secret names and target identities are present." }
    : await disabledGuard([], {
      ...source, cloudEnabled: process.env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true", provider: process.env.CLOUD_WORKSPACE_PROVIDER,
    });
  console.log(`::${result.blocked ? "error" : enabled ? "notice" : "warning"}::${result.message}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.message}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `enabled=${enabled}\nworker_enabled=${workerRequired}\n`);
  if (result.blocked) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => {
  console.error(error instanceof PromotionError ? `::error::${error.message}` : "::error::Release guard failed: missing authority, invalid channel identity, or unavailable comparison. No publication is authorized."); process.exitCode = 1;
});

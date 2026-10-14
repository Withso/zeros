import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createGitHubApi } from "./recovery-api.mjs";
import { INCIDENT_SCHEMA, validateSchema } from "./recovery-contract.mjs";
import { decideScope, loadPolicy } from "./scope.mjs";
import { decideHourlyGate, hourlySnapshot, trustedHourlyRun, REPO, HOURLY_PATH } from "../zeros-dev/hourly-actions.mjs";

const SHA = /^[a-f0-9]{40}$/;
export function cloudCanaryRequired(ledger) {
  if (!ledger || typeof ledger.full !== "boolean" || !ledger.lanes || typeof ledger.lanes !== "object" || Array.isArray(ledger.lanes) ||
    !Object.keys(ledger.lanes).length || Object.values(ledger.lanes).some(value => typeof value !== "boolean")) return true;
  return ledger.full || ["cloud-runtime", "control-plane", "control-plane-db", "runtime-bundle"].some(lane => ledger.lanes[lane] === true);
}
export function cloudRequiredForFiles(files, labels = []) {
  const statuses = { added: "A", modified: "M", removed: "D", renamed: "R100", copied: "C100", changed: "T" };
  try {
    return cloudCanaryRequired(decideScope({ policy: loadPolicy(), labels, changes: files.map(file => ({
      path: file.filename, status: statuses[file.status], ...(file.previous_filename ? { oldPath: file.previous_filename } : {}),
    })) }));
  } catch { return true; }
}

/** Same incident directory and remove-with-the-fix workflow as CI recovery.
 * This variant is owner-reviewed, never minted by the Preflight retry bot. */
export function createHourlyRepairMarker(snapshot) {
  const run = snapshot?.latest;
  if (!trustedHourlyRun(run) || run.status !== "completed" || !snapshot.activated || decideHourlyGate(snapshot, true).allowed) throw new Error("hourly_repair_invalid");
  const source = { sha: run.head_sha, run_id: String(run.id), attempt: run.run_attempt, workflow_path: HOURLY_PATH };
  const signature = createHash("sha256").update(JSON.stringify(["hourly_zeros_dev", source])).digest("hex");
  const value = { schema: "zeros.ci-failure/v1", incident_kind: "hourly_zeros_dev",
    repository: "Withso/zeros", signature, signature_version: 1, base_branch: "main", source, required_lanes: ["cloud-runtime"] };
  validateSchema(value, INCIDENT_SCHEMA.$defs.hourly_marker);
  return { path: `.github/ci-incidents/${signature}.json`, value };
}

export async function validateHourlyRepair(api, { number, head }, snapshot) {
  try {
    if (!Number.isSafeInteger(number) || number < 1 || !SHA.test(head ?? "")) return false;
    const expected = createHourlyRepairMarker(snapshot), pr = await api.get(`${REPO}/pulls/${number}`);
    if (pr.state !== "open" || pr.base?.ref !== "main" || pr.base.repo?.full_name !== "Withso/zeros" ||
      pr.head?.sha !== head || pr.head.repo?.full_name !== "Withso/zeros" || !Number.isSafeInteger(pr.commits) || pr.commits < 2 || pr.commits > 100 ||
      !Number.isSafeInteger(pr.changed_files) || pr.changed_files < 2 || pr.changed_files >= 100) return false;
    const commits = await api.get(`${REPO}/pulls/${number}/commits?per_page=100`);
    if (!Array.isArray(commits) || commits.length !== pr.commits || commits.at(-1)?.sha !== head || commits.some(commit => !SHA.test(commit.sha ?? ""))) return false;
    const first = commits[0].sha, detail = await api.get(`${REPO}/commits/${first}`);
    if (!Array.isArray(detail.files) || detail.files.length >= 100 || !detail.files.some(file => file.filename === expected.path && file.status === "added")) return false;
    const marker = await api.get(`${REPO}/contents/${expected.path}?ref=${first}`);
    if (marker?.type !== "file" || marker.encoding !== "base64" || marker.size > 4096 || typeof marker.content !== "string" || marker.content.length > 8192) return false;
    const value = JSON.parse(Buffer.from(marker.content, "base64").toString("utf8"));
    if (JSON.stringify(value) !== JSON.stringify(expected.value) || await api.get(`${REPO}/contents/${expected.path}?ref=${head}`, { missing: true }) !== null) return false;
    const files = await api.get(`${REPO}/pulls/${number}/files?per_page=100`);
    if (!Array.isArray(files) || files.length !== pr.changed_files || !files.some(file => /(?:\.test\.[cm]?[jt]sx?|\/tests\/test_[^/]+\.py)$/.test(file.filename) && file.status !== "removed") ||
      !files.some(file => /^(?:apps\/|packages\/|scripts\/|\.github\/workflows\/)/.test(file.filename) && !/\.test\./.test(file.filename))) return false;
    const reviews = await api.get(`${REPO}/pulls/${number}/reviews?per_page=100`);
    if (!Array.isArray(reviews) || reviews.length >= 100) return false;
    const latest = new Map();
    for (const review of reviews) {
      if (review.user?.type !== "User" || !/^[A-Za-z0-9-]{1,39}$/.test(review.user.login ?? "") || !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) continue;
      const previous = latest.get(review.user.login);
      if (!previous || Date.parse(review.submitted_at) >= Date.parse(previous.submitted_at)) latest.set(review.user.login, review);
    }
    for (const review of latest.values()) {
      if (review.state !== "APPROVED" || review.commit_id !== head || !Number.isFinite(Date.parse(review.submitted_at))) continue;
      const access = await api.get(`${REPO}/collaborators/${review.user.login}/permission`);
      if (access.permission === "admin") return true;
    }
  } catch { /* No prose, label, API error or partial page can grant an exception. */ }
  return false;
}

export async function evaluateHourly(api, { cloudRequired, number, head, snapshot, now } = {}) {
  let observed;
  try { observed = snapshot ?? await hourlySnapshot(api); }
  catch { return { allowed: cloudRequired === false, alert: true, code: "hourly_unavailable", activated: true }; }
  const decision = decideHourlyGate(observed, cloudRequired !== false, now);
  if (!decision.allowed && await validateHourlyRepair(api, { number, head }, observed)) return { ...decision, allowed: true, code: "hourly_reviewed_repair" };
  return decision;
}

export async function gateMain(env = process.env, args = process.argv.slice(2)) {
  try {
    const api = createGitHubApi({ token: env.GITHUB_TOKEN ?? env.GH_TOKEN });
    if (args.length === 1 && args[0] === "--repair-marker") {
      process.stdout.write(JSON.stringify(createHourlyRepairMarker(await hourlySnapshot(api))) + "\n"); return 0;
    }
    if (args.length) throw new Error();
    const ledger = JSON.parse(env.LEDGER_JSON ?? "");
    if (ledger.schema !== "zeros.ci-selection/v1" || ledger.event !== "pull_request" || ledger.source_sha !== env.PULL_REQUEST_HEAD_SHA ||
      ledger.base_sha !== env.PULL_REQUEST_BASE_SHA || ledger.tested_sha !== env.GITHUB_SHA || !SHA.test(ledger.source_sha ?? "")) throw new Error();
    const result = await evaluateHourly(api, { cloudRequired: cloudCanaryRequired(ledger), number: Number(env.PULL_REQUEST_NUMBER), head: ledger.source_sha });
    process.stdout.write(JSON.stringify({ schema: "zeros.dev-hourly-gate/v1", ...result }) + "\n");
    if (result.alert) process.stdout.write(`::warning::zeros-dev E2E: ${result.code}\n`);
    return result.allowed ? 0 : 1;
  } catch { process.stderr.write("zeros-dev E2E: hourly_unavailable\n"); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await gateMain();

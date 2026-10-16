import { pathToFileURL } from "node:url";
import { createGitHubApi, paginate } from "./recovery-api.mjs";
import { cloudRequiredForFiles, evaluateHourly } from "./zeros-dev-gate.mjs";
import { hourlySnapshot, REPO } from "../zeros-dev/hourly-actions.mjs";

export const HOURLY_STATUS = "zeros/dev-e2e";
const SHA = /^[a-f0-9]{40}$/;
const CODES = new Set(["hourly_checking", "hourly_not_live", "hourly_green", "hourly_running", "hourly_failed", "hourly_stale", "hourly_unavailable", "hourly_reviewed_repair"]);
const failure = () => new Error("hourly_status_unavailable");

/** This writer can update only the one required status on this repository.
 * It cannot merge, change branch protection, write source or use product keys. */
export function createHourlyStatusWriter({ token, workflowRunId, fetchImpl = fetch }) {
  if (!token || !/^[1-9][0-9]{0,19}$/.test(workflowRunId ?? "")) throw failure();
  return async ({ head, state, code, alert = false }) => {
    if (!SHA.test(head ?? "") || !["success", "failure", "pending"].includes(state) || !CODES.has(code) || typeof alert !== "boolean") throw failure();
    const response = await fetchImpl(`https://api.github.com${REPO}/statuses/${head}`, {
      method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal: globalThis.AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.github+json", "content-type": "application/json", "X-GitHub-Api-Version": "2022-11-28", authorization: `Bearer ${token}` },
      body: JSON.stringify({ state, context: HOURLY_STATUS, description: `${alert ? "Noncloud alert: " : ""}${code}`,
        target_url: `https://github.com/Withso/zeros/actions/runs/${workflowRunId}` }),
    });
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw failure();
  };
}

function target(pr) {
  if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || pr.state !== "open" || pr.base?.ref !== "main" ||
    pr.base.repo?.full_name !== "Withso/zeros" || !SHA.test(pr.head?.sha ?? "")) throw failure();
  return { number: pr.number, head: pr.head.sha };
}

/** Re-evaluate every open head on every trigger, not just the event's PR.
 * GitHub concurrency may replace a queued trigger; it must not lose a head. */
export async function refreshHourlyStatuses(api, publish, { now } = {}) {
  const prs = await paginate(api, `${REPO}/pulls?state=open&base=main`, null, 10);
  const targets = prs.map(target);
  if (new Set(targets.map(pr => pr.number)).size !== targets.length) throw failure();
  let snapshot;
  try { snapshot = await hourlySnapshot(api); }
  catch { snapshot = { activated: true, latest: null }; }
  const results = [];
  for (const item of targets) {
    // A pending status fences the previous success while scope/review is read.
    await publish({ head: item.head, state: "pending", code: "hourly_checking" });
    let cloudRequired = true, decision;
    try {
      const pr = await api.get(`${REPO}/pulls/${item.number}`);
      const current = target(pr);
      if (current.head !== item.head) continue; // The new head has no success.
      const files = await paginate(api, `${REPO}/pulls/${item.number}/files`, null, 30);
      if (!Number.isSafeInteger(pr.changed_files) || files.length !== pr.changed_files) throw failure();
      cloudRequired = cloudRequiredForFiles(files, pr.labels ?? []);
      // Neither an owner review nor a scope read applies to a replacement head.
      if (target(await api.get(`${REPO}/pulls/${item.number}`)).head !== item.head) continue;
      decision = await evaluateHourly(api, { cloudRequired, number: item.number, head: item.head, snapshot, now: now ?? Date.now() });
    } catch { decision = { allowed: false, alert: true, code: "hourly_unavailable" }; }
    await publish({ head: item.head, state: decision.allowed ? "success" : decision.code === "hourly_running" ? "pending" : "failure",
      code: decision.code, alert: !cloudRequired && decision.alert });
    results.push({ number: item.number, ...decision });
  }
  return results;
}

export async function statusMain(env = process.env) {
  try {
    if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_REPOSITORY !== "Withso/zeros" || env.GITHUB_REF !== "refs/heads/main" ||
      env.GITHUB_WORKFLOW_REF !== "Withso/zeros/.github/workflows/zeros-dev-e2e-gate.yml@refs/heads/main" ||
      !["pull_request_target", "workflow_run", "schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME)) throw failure();
    const api = createGitHubApi({ token: env.GITHUB_TOKEN });
    const results = await refreshHourlyStatuses(api, createHourlyStatusWriter({ token: env.GITHUB_TOKEN, workflowRunId: env.GITHUB_RUN_ID }));
    process.stdout.write(JSON.stringify({ schema: "zeros.dev-hourly-status/v1", checked: results.length,
      blocked: results.filter(row => !row.allowed).length, alerts: results.filter(row => row.alert).length }) + "\n");
    return 0;
  } catch { process.stderr.write("zeros-dev E2E: hourly_status_unavailable\n"); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await statusMain();

#!/usr/bin/env node
// zeros-dev canary trigger — invoked by Railway cron (every 5 min) on the
// zeros-canary-trigger project. Dispatches the zeros-dev-e2e workflow with
// profile=infrastructure when the chain is due (every 2 h) and no real run is
// in flight. Read-only first; POSTs a dispatch only when due. The token is
// never logged. A non-zero exit fails the cron tick visibly in Railway.
//
// Skipped runs matter: the workflow's schedule ticks land as
// conclusion=skipped no-ops, so the due check only considers real
// workflow_dispatch executions.
const REPO = "Withso/zeros";
const WORKFLOW = "zeros-dev-e2e.yml";
const INTERVAL_MS = 2 * 60 * 60 * 1000;
const API = "https://api.github.com";
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

const token = process.env.GITHUB_DISPATCH_TOKEN;
if (!token) {
  console.error("[canary-trigger] GITHUB_DISPATCH_TOKEN is not set");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const headers = {
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};
const api = async (path, init) => {
  const response = await fetch(`${API}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return response.status === 204 || response.status === 201 ? null : response.json();
};

const realRuns = (runs) =>
  (runs ?? []).filter((run) => run.event === "workflow_dispatch" && run.conclusion !== "skipped");

try {
  const { workflow_runs } = await api(
    `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=25`,
  );
  const runs = realRuns(workflow_runs);
  const active = runs.filter((run) => ACTIVE.has(run.status));
  if (active.length) {
    console.log(`[canary-trigger] suppressed: run ${active[0].id} is ${active[0].status}`);
    process.exit(0);
  }
  const latest = runs[0];
  const ageMs = latest ? Date.now() - Date.parse(latest.created_at) : Number.POSITIVE_INFINITY;
  const ageMin = Math.round(ageMs / 60000);
  if (ageMs < INTERVAL_MS) {
    console.log(`[canary-trigger] suppressed: latest run ${latest.id} is ${ageMin} min old (< 120)`);
    process.exit(0);
  }
  if (dryRun) {
    console.log(
      `[canary-trigger] dry-run: would dispatch ${WORKFLOW} profile=infrastructure (latest ${latest?.id ?? "none"}, age ${latest ? `${ageMin} min` : "n/a"})`,
    );
    process.exit(0);
  }
  await api(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { profile: "infrastructure" } }),
  });
  console.log(
    `[canary-trigger] dispatched ${WORKFLOW} profile=infrastructure (latest was ${latest?.id ?? "none"}, age ${latest ? `${ageMin} min` : "n/a"})`,
  );
} catch (error) {
  console.error(`[canary-trigger] failed: ${error.message}`);
  process.exit(1);
}

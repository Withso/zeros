#!/usr/bin/env node
// Keep ONE open issue "main is red at <sha>" while push Preflight on main is
// failing, and close it when a later commit's push Preflight is green.
// Runs from the default branch (workflow_run). No PR comments; issues only.

import { pathToFileURL } from "node:url";

const TITLE = /^main is red at [0-9a-f]{7,40}\b/;
const MARKER = /<!-- main-red-sha: ([0-9a-f]{40}) -->/;
const RED = new Set(["failure", "timed_out", "startup_failure"]);

/** api(method, route, body?) → parsed JSON; route is relative to repos/<repo>. */
export async function updateMainRed({ api, run, log = console.log }) {
  const { id, head_sha: sha, conclusion, html_url: url, event, head_branch: branch } = run;
  if (event !== "push" || branch !== "main" || !/^[0-9a-f]{40}$/.test(sha ?? "")) return "ignored";
  const open = (await api("GET", "/issues?state=open&per_page=100"))
    .filter((issue) => !issue.pull_request && TITLE.test(issue.title ?? ""));
  const issue = open[0];
  const issueSha = issue?.body?.match(MARKER)?.[1];
  // Runs finish out of order: act only for a commit at or after the recorded one.
  const atOrAfter = async () => {
    if (!issueSha || issueSha === sha) return true;
    const compare = await api("GET", `/compare/${issueSha}...${sha}`);
    return compare?.status === "ahead" || compare?.status === "identical";
  };
  if (RED.has(conclusion)) {
    if (issue && !(await atOrAfter())) return "older-red";
    const jobs = (await api("GET", `/actions/runs/${id}/jobs?per_page=100&filter=latest`)).jobs
      .filter((job) => RED.has(job.conclusion) || job.conclusion === "cancelled");
    const body = [`<!-- main-red-sha: ${sha} -->`, `Push Preflight failed on \`main\` at ${sha}: ${url}`, "",
      "Failed jobs:", ...jobs.map((job) => `- [${job.name}](${job.html_url}) (${job.conclusion})`), "",
      "Fix forward with a PR (or rerun the failed jobs if the failure is a flake). This issue closes on the next green push Preflight."].join("\n");
    const title = `main is red at ${sha.slice(0, 12)}`;
    if (issue) { await api("PATCH", `/issues/${issue.number}`, { title, body }); log(`Refreshed #${issue.number}: ${title}`); return "refreshed"; }
    const created = await api("POST", "/issues", { title, body });
    log(`Opened #${created.number}: ${title}`);
    return "opened";
  }
  if (conclusion === "success" && issue) {
    if (!(await atOrAfter())) return "older-green";
    await api("POST", `/issues/${issue.number}/comments`, { body: `Push Preflight is green again at ${sha}: ${url}` });
    await api("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    log(`Closed #${issue.number}`);
    return "closed";
  }
  return "unchanged";
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const api = async (method, route, body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, { method,
      headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`GitHub ${method} ${route.split("?")[0]} failed (${response.status})`);
    return response.json();
  };
  const run = await api("GET", `/actions/runs/${process.env.RUN_ID}`);
  console.log(`main-red: ${await updateMainRed({ api, run })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });

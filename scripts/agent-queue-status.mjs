#!/usr/bin/env node
// Read-only merge-queue view for agents: queue entries, and for each named
// PR its last removal from the queue and the failed merge-group jobs.
// Usage: pnpm agent:queue-status [<pr-number>...]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Withso/zeros";
const QUEUE_QUERY = `query { repository(owner: "Withso", name: "zeros") {
  mergeQueue(branch: "main") { entries(first: 50) { nodes { position state enqueuedAt pullRequest { number title } } } } } }`;
const PR_QUERY = `query($number: Int!) { repository(owner: "Withso", name: "zeros") { pullRequest(number: $number) {
  number state isInMergeQueue mergeQueueEntry { position state }
  timelineItems(last: 20, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) {
    nodes { __typename ... on AddedToMergeQueueEvent { createdAt } ... on RemovedFromMergeQueueEvent { createdAt reason } } } } } }`;

/** Pure formatting over gh JSON; `runs` are merge_group Preflight/CodeQL/lint
 * runs and `jobs` maps a run id to its jobs. */
export function describeQueue({ entries, prs = [] }) {
  const lines = ["Merge queue for main:"];
  if (!entries.length) lines.push("  (empty)");
  for (const entry of entries)
    lines.push(`  ${entry.position}. #${entry.pullRequest.number} ${entry.state} (enqueued ${entry.enqueuedAt}) ${entry.pullRequest.title}`);
  for (const pr of prs) {
    const events = pr.timelineItems?.nodes ?? [];
    const removed = events.filter((event) => event.__typename === "RemovedFromMergeQueueEvent").at(-1);
    const added = events.filter((event) => event.__typename === "AddedToMergeQueueEvent").at(-1);
    const status = pr.state !== "OPEN" ? pr.state
      : pr.isInMergeQueue ? `in queue at position ${pr.mergeQueueEntry?.position} (${pr.mergeQueueEntry?.state})` : "open, not in the queue";
    lines.push("", `#${pr.number}: ${status}`);
    if (added) lines.push(`  last enqueued ${added.createdAt}`);
    if (removed && (!added || removed.createdAt > added.createdAt || !pr.isInMergeQueue))
      lines.push(`  last removed ${removed.createdAt}: ${removed.reason ?? "unknown reason"}`);
    for (const failure of pr.failures ?? [])
      lines.push(`  failed in merge group: ${failure.workflow} / ${failure.job} (${failure.conclusion}) ${failure.url}`);
  }
  return lines.join("\n");
}

export function runQueueStatus(argv = process.argv.slice(2), { spawn = spawnSync, stdout = console.log, stderr = console.error } = {}) {
  if (argv.some((arg) => !/^[1-9]\d*$/.test(arg))) { stderr("usage: pnpm agent:queue-status [<pr-number>...]"); return 2; }
  const gh = (args) => {
    const result = spawn("gh", args, { encoding: "utf8", stdio: "pipe", shell: false, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("gh request failed");
    return JSON.parse(result.stdout);
  };
  try {
    const entries = gh(["api", "graphql", "-f", `query=${QUEUE_QUERY}`]).data.repository.mergeQueue?.entries.nodes ?? [];
    const prs = argv.map((number) => {
      const pr = gh(["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `number=${number}`]).data.repository.pullRequest;
      const runs = gh(["api", `repos/${REPOSITORY}/actions/runs?event=merge_group&per_page=100`]).workflow_runs
        .filter((run) => run.head_branch?.startsWith(`gh-readonly-queue/main/pr-${number}-`) && run.status === "completed" && run.conclusion !== "success")
        .sort((a, b) => b.id - a.id).slice(0, 3);
      const failures = runs.flatMap((run) => gh(["api", `repos/${REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`]).jobs
        .filter((job) => ["failure", "timed_out", "cancelled"].includes(job.conclusion))
        .map((job) => ({ workflow: run.name, job: job.name, conclusion: job.conclusion, url: job.html_url })));
      return { ...pr, failures };
    });
    stdout(describeQueue({ entries, prs }));
    return 0;
  } catch {
    // gh output can carry credentials; never echo it.
    stderr("Unable to read the merge queue; check gh authentication.");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = runQueueStatus();

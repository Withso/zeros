#!/usr/bin/env node
// actionlint 1.7.12 does not recognize concurrency.queue. Its file-scoped
// unknown-key ignore is safe only while this parsed-YAML policy and its root
// Vitest suite validate every queued workflow.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";

const QUEUED_JOBS = new Map([
  [".github/workflows/concurrency-canary.yml", new Set(["queue-canary"])],
  [
    ".github/workflows/preflight.yml",
    new Set(["ui-smoke-shard", "source-sync-workload"]),
  ],
]);

/** Validate queue uses without changing the policy for ordinary concurrency. */
export function validateQueuedConcurrency(workflow, file) {
  const errors = [];
  const inspect = (concurrency, job) => {
    if (
      !concurrency ||
      typeof concurrency !== "object" ||
      !Object.hasOwn(concurrency, "queue")
    ) {
      return;
    }
    const location = job ? `jobs.${job}.concurrency` : "concurrency";
    const report = (message) => errors.push(`${file}: ${location}: ${message}`);

    if (!job || !QUEUED_JOBS.get(file)?.has(job)) {
      report("queue is permitted only on allowlisted jobs");
    }
    if (concurrency.queue !== "max") {
      report("queue must be the literal max");
    }
    if (typeof concurrency.group !== "string" || !concurrency.group.trim()) {
      report("group must be a nonempty string");
    }
    if (
      Object.hasOwn(concurrency, "cancel-in-progress") &&
      concurrency["cancel-in-progress"] !== false
    ) {
      // Expressions and string booleans cannot prove that work is retained.
      report(
        "cancel-in-progress must be omitted or the literal false with queue",
      );
    }
  };

  inspect(workflow?.concurrency);
  for (const [job, definition] of Object.entries(workflow?.jobs ?? {})) {
    inspect(definition?.concurrency, job);
  }
  return errors;
}

/** Parse every workflow, including files outside the queue allowlist. */
export function validateConcurrency(root = process.cwd()) {
  const directory = path.join(root, ".github/workflows");
  const errors = [];
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const name of files) {
    const file = `.github/workflows/${name}`;
    let workflow;
    try {
      workflow = load(readFileSync(path.join(directory, name), "utf8"));
    } catch (error) {
      errors.push(`${file}: invalid YAML (${error.reason ?? error.message})`);
      continue;
    }
    errors.push(...validateQueuedConcurrency(workflow, file));
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const errors = validateConcurrency();
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("Queued concurrency policy passed.");
    }
  } catch (error) {
    console.error(`Cannot validate workflow concurrency: ${error.message}`);
    process.exitCode = 1;
  }
}

// A merge queue merges an entry only after every required check reports on
// GitHub's synthetic merge-group commit. A required context with no producer
// on that event would hold every queued PR until the queue times it out.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

import { FINAL_CONTEXTS, LEGACY_CONTEXTS } from "../ci/ruleset-migration.mjs";

type Workflow = { on?: unknown; true?: unknown; jobs?: Record<string, { name?: string }> };

const WORKFLOWS = path.resolve(".github/workflows");

function triggers(workflow: Workflow): string[] {
  // YAML 1.1 reads a bare `on` key as the boolean true.
  const on = workflow.on ?? (workflow as Record<string, unknown>)["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return on && typeof on === "object" ? Object.keys(on) : [];
}

function mergeGroupContexts() {
  const producers = new Map<string, string[]>();
  for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).sort()) {
    const workflow = load(readFileSync(path.join(WORKFLOWS, file), "utf8")) as Workflow;
    if (!triggers(workflow).includes("merge_group")) continue;
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const context = typeof job?.name === "string" ? job.name : id;
      producers.set(context, [...(producers.get(context) ?? []), file]);
    }
  }
  return producers;
}

describe("required checks on merge-queue commits", () => {
  const producers = mergeGroupContexts();

  it.each(LEGACY_CONTEXTS)("%s reports on merge_group from exactly one workflow", (context) => {
    expect(producers.get(context), `no merge_group producer for required check "${context}"`).toHaveLength(1);
  });

  it("names the final-ruleset contexts that cannot gate a queue yet", () => {
    // Add a merge_group producer before the ruleset requires one of these on a
    // queue branch; shrink this list in the same change.
    expect(FINAL_CONTEXTS.filter((context) => !producers.has(context))).toEqual(["zeros/ci-gate", "secret-scan"]);
  });
});

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  validateConcurrency,
  validateQueuedConcurrency,
} from "../ci/validate-concurrency.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PREFLIGHT = ".github/workflows/preflight.yml";
const CANARY = ".github/workflows/concurrency-canary.yml";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function queuedJob(queue = "max", cancellation = "", group = "heavy-lane") {
  return load(`
jobs:
  queue-canary:
    concurrency:
      group: ${group}
      queue: ${queue}
      ${cancellation}
`);
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-concurrency-"));
  temporaryRoots.push(root);
  const workflows = path.join(root, ".github/workflows");
  mkdirSync(workflows, { recursive: true });
  for (const [file, source] of Object.entries(files)) {
    writeFileSync(path.join(workflows, file), source);
  }
  return root;
}

describe("queued concurrency policy", () => {
  it("accepts max only on the canary job; coalesced Preflight jobs have no queue", () => {
    const queued = (job: string) =>
      load(`jobs:\n  ${job}:\n    concurrency: { group: lane, queue: max }`);
    expect(validateQueuedConcurrency(queued("queue-canary"), CANARY)).toEqual(
      [],
    );
    for (const job of ["ui-smoke-shard", "source-sync-workload"]) {
      expect(validateQueuedConcurrency(queued(job), PREFLIGHT), job).toEqual([
        expect.stringContaining("allowlisted jobs"),
      ]);
    }
  });

  it("allows literal false cancellation and leaves ordinary concurrency alone", () => {
    expect(
      validateQueuedConcurrency(
        queuedJob("max", "cancel-in-progress: false"),
        CANARY,
      ),
    ).toEqual([]);
    expect(
      validateQueuedConcurrency(
        load("concurrency: { group: ordinary, cancel-in-progress: true }"),
        ".github/workflows/ci.yml",
      ),
    ).toEqual([]);
  });

  it.each(["single", "MAX", "true", "1", "null", "${{ vars.CI_QUEUE }}"])(
    "rejects the unsupported queue value %s",
    (queue) => {
      expect(validateQueuedConcurrency(queuedJob(queue), CANARY)).toEqual([
        expect.stringContaining("queue must be the literal max"),
      ]);
    },
  );

  it.each(["true", '"false"', "${{ github.event_name == 'push' }}"])(
    "rejects cancellation that could cancel queued work: %s",
    (cancellation) => {
      expect(
        validateQueuedConcurrency(
          queuedJob("max", `cancel-in-progress: ${cancellation}`),
          CANARY,
        ),
      ).toEqual([expect.stringContaining("cancel-in-progress")]);
    },
  );

  it.each(["null", '""', '"   "'])("rejects the empty group %s", (group) => {
    expect(
      validateQueuedConcurrency(queuedJob("max", "", group), CANARY),
    ).toEqual([expect.stringContaining("group must be a nonempty string")]);
  });

  it("rejects workflow-level queues and queues on every Preflight job", () => {
    expect(
      validateQueuedConcurrency(
        load("concurrency: { group: whole-run, queue: max }"),
        PREFLIGHT,
      ),
    ).toEqual([expect.stringContaining("allowlisted jobs")]);
    for (const job of [
      "quality",
      "test-shard",
      "test",
      "build",
      "control-plane-static",
      "control-plane-database",
      "control-plane",
      "secret-scan",
      "alpha-gate",
      "ui-smoke",
      "ui-smoke-shard",
      "source-sync",
      "source-sync-workload",
    ]) {
      expect(
        validateQueuedConcurrency(
          load(
            `jobs:\n  ${job}:\n    concurrency: { group: lane, queue: max }`,
          ),
          PREFLIGHT,
        ),
        job,
      ).toEqual([expect.stringContaining("allowlisted jobs")]);
    }
  });

  it("does not extend the allowlist to another workflow or a misspelled job", () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/release-beta.yml",
    ]) {
      expect(validateQueuedConcurrency(queuedJob(), file)).toEqual([
        expect.stringContaining("allowlisted jobs"),
      ]);
    }
    expect(
      validateQueuedConcurrency(
        load(
          "jobs:\n  queue-canaries:\n    concurrency: { group: lane, queue: max }",
        ),
        CANARY,
      ),
    ).toEqual([expect.stringContaining("allowlisted jobs")]);
  });

  it("validates parsed YAML aliases rather than matching source text", () => {
    expect(
      validateQueuedConcurrency(
        load(`
jobs:
  queue-canary:
    concurrency: &heavy
      group: composer
      queue: max
  quality:
    concurrency: *heavy
`),
        CANARY,
      ),
    ).toEqual([expect.stringContaining("jobs.quality.concurrency")]);
  });

  it("scans both workflow extensions and fails on malformed YAML", () => {
    const root = fixture({
      "concurrency-canary.yml":
        "jobs:\n  queue-canary:\n    concurrency: { group: lane, queue: max }",
      "other.yaml":
        "jobs:\n  quality:\n    concurrency: { group: lane, queue: max }",
      "broken.yml": "jobs: [",
    });
    expect(validateConcurrency(root)).toEqual([
      expect.stringContaining("broken.yml: invalid YAML"),
      expect.stringContaining("other.yaml: jobs.quality.concurrency"),
    ]);
  });

  it("returns a failing CLI exit status for an invalid queue", () => {
    const root = fixture({
      "concurrency-canary.yml":
        "jobs:\n  queue-canary:\n    concurrency: { group: lane, queue: single }",
    });
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/ci/validate-concurrency.mjs")],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("queue must be the literal max");
  });

  it("accepts all repository workflows and runs before actionlint in check:actions", () => {
    expect(validateConcurrency(ROOT)).toEqual([]);
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts["check:actions"]).toBe(
      "node scripts/ci/validate-concurrency.mjs && node scripts/check-actions.mjs",
    );
  });

  it("keeps the canary manual, permissionless, and limited to one trivial job", () => {
    const canary = load(readFileSync(path.join(ROOT, CANARY), "utf8")) as {
      name: string;
      on: unknown;
      permissions: unknown;
      jobs: Record<string, { concurrency: unknown; steps: { run: string }[] }>;
    };
    expect(canary.name).toBe("Concurrency Canary");
    expect(canary.on).toEqual({ workflow_dispatch: null });
    expect(canary.permissions).toEqual({});
    expect(Object.keys(canary.jobs)).toEqual(["queue-canary"]);
    expect(canary.jobs["queue-canary"].concurrency).toEqual({
      group: "concurrency-canary",
      queue: "max",
    });
    expect(canary.jobs["queue-canary"].steps).toHaveLength(1);
    expect(canary.jobs["queue-canary"].steps[0].run).toContain(
      "GitHub accepted",
    );
  });
});

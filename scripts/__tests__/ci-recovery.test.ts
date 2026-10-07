import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  classifyFailures,
  decideRecovery,
  failureSignature,
  isFullyGreen,
  isSourceRun,
  laneForJob,
  recoveryMode,
  requiredLanesCovered,
} from "../ci/recovery-policy.mjs";

const jobs = JSON.parse(
  readFileSync(
    new URL("./fixtures/ci-recovery-jobs.json", import.meta.url),
    "utf8",
  ),
);
const sha = "a".repeat(40);
const workflow = {
  id: 321408597,
  name: "Preflight",
  path: ".github/workflows/preflight.yml",
};
const run = {
  id: 123,
  workflow_id: workflow.id,
  name: workflow.name,
  path: workflow.path,
  event: "push",
  head_branch: "main",
  repository: { full_name: "Withso/zeros" },
  head_repository: { full_name: "Withso/zeros" },
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  run_attempt: 1,
};
const roots = classifyFailures([jobs.composer]).roots;
const signature = failureSignature("Withso/zeros", workflow.id, roots);
const incident = {
  signature,
  appAuthor: true,
  branch: "ci-fix/" + signature,
  state: "open",
  untouched: true,
  contract: {
    state: "awaiting_agent",
    claimed_by: null,
    latest_failure: { sha, run_id: "122", attempt: 2 },
    occurrences: [],
  },
};
const decision = (overrides = {}) =>
  decideRecovery({
    run,
    roots,
    signature,
    incident: null,
    openCount: 0,
    newToday: 0,
    retryReserved: false,
    resolved: false,
    mode: "enabled",
    ...overrides,
  });

describe("CI recovery source authentication", () => {
  it("accepts only canonical same-repository main push runs", () => {
    expect(isSourceRun(run, workflow)).toBe(true);
    for (const mutation of [
      { head_branch: "release/1.2.3" },
      { head_branch: "ci-fix/example" },
      { event: "pull_request" },
      { event: "workflow_dispatch" },
      { name: "Another workflow" },
      { path: ".github/workflows/fake.yml" },
      { workflow_id: 99 },
      { repository: { full_name: "Other/zeros" } },
      { head_repository: { full_name: "Other/zeros" } },
      { head_sha: "not-a-sha" },
      { run_attempt: 0 },
    ]) {
      expect(isSourceRun({ ...run, ...mutation }, workflow)).toBe(false);
    }
  });
});

describe("root failures and retry eligibility", () => {
  it("classifies precise historical and current partition names", () => {
    for (const name of [
      "tests-vitest (1/2)",
      "tests-vitest (2/2)",
      "test-shard (1)",
      "test-shard (2)",
      ...[1, 2, 3, 4].map((part) => `tests-vitest (${part}/4)`),
    ]) {
      expect(laneForJob(name), name).toBe("vitest");
    }
    for (const name of [
      "control-plane database",
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(
        (part) => `control-plane database (${part})`,
      ),
      ...[1, 2, 3, 4].map((part) => `tests-control-plane-db (${part}/4)`),
    ]) {
      expect(laneForJob(name), name).toBe("control-plane-db");
    }
  });

  it("does not broaden partition recognition to malformed or unregistered names", () => {
    for (const name of [
      "tests-vitest (0/4)",
      "tests-vitest (5/4)",
      "tests-vitest (3/2)",
      "tests-vitest (1/3)",
      "tests-vitest (1/8)",
      "tests-vitest (1/4) extra",
      "test-shard (3)",
      "control-plane database (0)",
      "control-plane database (9)",
      "control-plane database (01)",
      "control-plane database (1/8)",
      "tests-control-plane-db (5/4)",
      "tests-control-plane-db (8/8)",
    ]) {
      expect(laneForJob(name), name).toBe("unknown");
    }
  });

  it("keeps substantive failures in the new final partitions ineligible for retry", () => {
    for (const [name, step, lane] of [
      ["tests-vitest (4/4)", "Run vitest suite", "vitest"],
      [
        "control-plane database (8)",
        "Control-plane tests (migrations + auth/invite contracts)",
        "control-plane-db",
      ],
    ]) {
      const classification = classifyFailures([
        {
          ...jobs.database,
          name,
          steps: [{ number: 8, name: step, conclusion: "failure" }],
        },
      ]);
      expect(classification.eligible).toBe(false);
      expect(classification.roots).toHaveLength(1);
      expect(classification.roots[0].lane).toBe(lane);
    }
  });

  it("retries registered composer test steps, including legacy runs", () => {
    for (const job of [jobs.composer, jobs.legacyComposer]) {
      const classification = classifyFailures([job]);
      expect(classification.eligible).toBe(true);
      expect(classification.roots[0].lane).toBe("composer");
      expect(classification.roots[0].step).toBe("composer-shard");
    }
  });

  it("retries runner provisioning before substantive execution", () => {
    expect(
      classifyFailures([jobs.provisioning, jobs.setupFailure]).eligible,
    ).toBe(true);
    expect(classifyFailures([jobs.provisioning]).roots[0].step).toBe(
      "runner-provisioning",
    );
    expect(
      classifyFailures([{ ...jobs.provisioning, conclusion: "cancelled" }])
        .eligible,
    ).toBe(false);
  });

  it("excludes only aggregate verdicts whose own producers failed", () => {
    for (const [producer, aggregate, stepName] of [
      [jobs.composer, jobs.composerAggregate, "Enforce the UI smoke result"],
      [
        { ...jobs.provisioning, name: "tests-vitest (1/2)" },
        jobs.testAggregate,
        "Enforce the test result",
      ],
      [
        { ...jobs.provisioning, name: "tests-vitest (4/4)" },
        jobs.testAggregate,
        "Enforce the test result",
      ],
      [
        jobs.setupFailure,
        { ...jobs.testAggregate, name: "source-sync (macOS)" },
        "Enforce the source-sync result",
      ],
      [
        { ...jobs.provisioning, name: "control-plane database (1)" },
        { ...jobs.testAggregate, name: "control plane" },
        "Enforce control-plane results",
      ],
      [
        { ...jobs.provisioning, name: "control-plane database (8)" },
        { ...jobs.testAggregate, name: "control plane" },
        "Enforce control-plane results",
      ],
      [
        jobs.provisioning,
        { ...jobs.testAggregate, name: "alpha-gate" },
        "Enforce all Alpha critical producers and DB reports",
      ],
    ]) {
      const classification = classifyFailures([
        producer,
        {
          ...aggregate,
          steps: [
            { number: 1, name: "Set up job", conclusion: "success" },
            { number: 2, name: stepName, conclusion: "failure" },
          ],
        },
      ]);
      expect(classification.roots).toHaveLength(1);
      expect(classification.eligible).toBe(true);
    }
    expect(classifyFailures([jobs.testAggregate]).eligible).toBe(false);
    expect(classifyFailures([jobs.composer, jobs.testAggregate]).eligible).toBe(
      false,
    );
  });

  it("keeps independent database-report failures when producers are green", () => {
    const reportFailure = {
      ...jobs.testAggregate,
      name: "control plane",
      steps: [
        { number: 1, name: "Set up job", conclusion: "success" },
        {
          number: 5,
          name: "Enforce control-plane results",
          conclusion: "failure",
        },
      ],
    };
    const classification = classifyFailures([
      jobs.composer,
      { ...jobs.database, conclusion: "success", steps: [] },
      reportFailure,
    ]);
    expect(classification.eligible).toBe(false);
    expect(classification.roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "control-plane-db",
          step: "db-reports",
          retryEligible: false,
        }),
      ]),
    );
  });

  it("keeps substantive legacy test jobs and unknown aggregate steps", () => {
    for (const job of [
      {
        ...jobs.testAggregate,
        steps: [{ number: 8, name: "Run vitest suite", conclusion: "failure" }],
      },
      {
        ...jobs.composerAggregate,
        steps: [
          {
            number: 8,
            name: "Unregistered integrity check",
            conclusion: "failure",
          },
        ],
      },
    ]) {
      const classification = classifyFailures([jobs.composer, job]);
      expect(classification.eligible).toBe(false);
      expect(classification.roots).toHaveLength(2);
    }
  });

  it.each(["neutral", "cancelled", "action_required", "stale"])(
    "rejects a composer test step concluded %s even when its job failed",
    (conclusion) => {
      const classification = classifyFailures([
        {
          ...jobs.composer,
          steps: jobs.composer.steps.map((step) =>
            step.number === 8 ? { ...step, conclusion } : step,
          ),
        },
      ]);
      expect(classification.eligible).toBe(false);
    },
  );

  it("recognizes setup failure followed only by successful runner cleanup", () => {
    const setupWithCleanup = {
      ...jobs.setupFailure,
      steps: [
        ...jobs.setupFailure.steps,
        { number: 3, name: "Complete job", conclusion: "success" },
      ],
    };
    expect(classifyFailures([setupWithCleanup]).eligible).toBe(true);
    expect(
      classifyFailures([
        {
          ...setupWithCleanup,
          steps: setupWithCleanup.steps.map((step) =>
            step.number === 3 ? { ...step, conclusion: "failure" } : step,
          ),
        },
      ]).eligible,
    ).toBe(false);
  });

  it("blocks an unfamiliar job conclusion alongside an eligible failure", () => {
    expect(
      classifyFailures([
        jobs.composer,
        { ...jobs.quality, conclusion: "unrecognized" },
      ]).eligible,
    ).toBe(false);
  });

  it("does not mistake the legacy composer workload for its aggregate", () => {
    expect(classifyFailures([jobs.legacyComposer]).roots).toHaveLength(1);
    expect(classifyFailures([jobs.composerAggregate]).eligible).toBe(false);
  });

  it("rejects substantive, unknown, report, install and mixed failures", () => {
    for (const job of [
      jobs.quality,
      jobs.database,
      jobs.secretScan,
      {
        ...jobs.composer,
        steps: [
          { number: 2, name: "Install JS dependencies", conclusion: "failure" },
        ],
      },
      {
        ...jobs.composer,
        steps: [
          {
            number: 2,
            name: "Upload the shard's test report",
            conclusion: "failure",
          },
        ],
      },
      {
        ...jobs.composer,
        steps: [{ number: 2, name: "Unknown test", conclusion: "failure" }],
      },
      { ...jobs.quality, name: "unknown lane" },
    ]) {
      expect(classifyFailures([job]).eligible).toBe(false);
      expect(classifyFailures([jobs.composer, job]).eligible).toBe(false);
    }
  });

  it("requires every failed step to be eligible", () => {
    expect(
      classifyFailures([
        {
          ...jobs.composer,
          steps: [
            ...jobs.composer.steps,
            {
              number: 9,
              name: "Upload the shard's test report",
              conclusion: "failure",
            },
          ],
        },
      ]).eligible,
    ).toBe(false);
  });

  it("does not call an interrupted substantive step a provisioning failure", () => {
    expect(
      classifyFailures([
        {
          ...jobs.composer,
          steps: [
            {
              number: 8,
              name: "Composer UI smoke shard",
              conclusion: null,
              status: "in_progress",
              started_at: "2026-10-06T00:00:00Z",
            },
          ],
        },
      ]).eligible,
    ).toBe(false);
  });
});

describe("failure signatures", () => {
  it("hashes the canonical main scope and sorted root lane/step keys", () => {
    const canonical = JSON.stringify([
      "Withso/zeros",
      "refs/heads/main",
      String(workflow.id),
      ["composer[1/3]:composer-shard"],
    ]);
    expect(signature).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
  });

  it("ignores order, duplicate roots, job IDs, timestamps, SHAs and messages", () => {
    const mixed = classifyFailures([jobs.composer, jobs.quality]).roots;
    expect(failureSignature("Withso/zeros", workflow.id, mixed)).toBe(
      failureSignature("Withso/zeros", workflow.id, [
        ...mixed.reverse().map((root) => ({
          ...root,
          jobId: "999",
          sha: "b".repeat(40),
          message: "arbitrary",
        })),
        mixed[0],
      ]),
    );
    expect(failureSignature("Other/zeros", workflow.id, roots)).not.toBe(
      signature,
    );
    expect(failureSignature("Withso/zeros", 99, roots)).not.toBe(signature);
  });
});

describe("recovery decisions, dedupe and budgets", () => {
  it("defaults to inspection and accepts only the three defined modes", () => {
    for (const value of [undefined, "", "off", "invalid", "ENABLED"]) {
      expect(recoveryMode(value)).toBe("off");
      expect(decision({ mode: recoveryMode(value) }).writeAllowed).toBe(false);
    }
    expect(decision({ mode: "retry" }).writeAllowed).toBe(true);
    expect(
      decision({ mode: "retry", run: { ...run, run_attempt: 2 } }).writeAllowed,
    ).toBe(false);
  });

  it("retries at most once and treats a reserved ambiguous POST as spent", () => {
    expect(decision().action).toBe("retry");
    expect(decision({ run: { ...run, run_attempt: 2 } }).action).toBe("upsert");
    expect(decision({ retryReserved: true }).action).toBe("none");
    expect(
      decision({ roots: classifyFailures([jobs.quality]).roots }).action,
    ).toBe("upsert");
  });

  it("counts all open incident PRs and new creations including reservations", () => {
    const persistent = { ...run, run_attempt: 2 };
    expect(decision({ run: persistent, openCount: 10 }).action).toBe("none");
    expect(decision({ run: persistent, newToday: 3 }).action).toBe("none");
    expect(
      decision({ run: persistent, openCount: 9, newToday: 2 }).action,
    ).toBe("upsert");
    expect(
      decision({ run: persistent, openCount: 10, newToday: 3, incident })
        .action,
    ).toBe("upsert");
  });

  it("dedupes by the exact branch and verified App author", () => {
    const persistent = { ...run, run_attempt: 2 };
    expect(decision({ run: persistent, incident }).reason).toBe(
      "update-incident",
    );
    expect(
      decision({ run: persistent, incident: { ...incident, appAuthor: false } })
        .action,
    ).toBe("none");
    expect(
      decision({
        run: persistent,
        incident: { ...incident, branch: "ci-fix/other" },
      }).action,
    ).toBe("none");
    expect(
      decision({ run: persistent, incident, duplicate: true }).action,
    ).toBe("none");
    expect(decision({ run: persistent, branchExists: true }).action).toBe(
      "none",
    );
  });

  it("preserves human claims, assignees, non-controller commits and resolved PRs", () => {
    for (const modified of [
      { ...incident, untouched: false },
      {
        ...incident,
        contract: {
          ...incident.contract,
          claimed_by: { login: "repair-agent" },
        },
      },
      { ...incident, contract: { ...incident.contract, state: "resolved" } },
    ]) {
      expect(
        decision({ run: { ...run, run_attempt: 2 }, incident: modified })
          .action,
      ).toBe("none");
    }
  });

  it("records an occurrence once and never re-adds an older failure", () => {
    expect(
      decision({
        run: { ...run, run_attempt: 2 },
        incident: {
          ...incident,
          contract: {
            ...incident.contract,
            latest_failure: { sha, run_id: "123", attempt: 2 },
            occurrences: [{ sha, run_id: "123", attempt: 2 }],
          },
        },
      }).action,
    ).toBe("none");
  });
});

describe("green resolution", () => {
  it.each([
    {
      lane: "vitest",
      names: [1, 2, 3, 4].map((part) => `tests-vitest (${part}/4)`),
    },
    {
      lane: "control-plane-db",
      names: [1, 2, 3, 4, 5, 6, 7, 8].map(
        (part) => `control-plane database (${part})`,
      ),
    },
  ])(
    "requires every current $lane partition exactly once",
    ({ lane, names }) => {
      const contract = { required_lanes: [lane] };
      const green = names.map((name) => ({ name, conclusion: "success" }));
      expect(requiredLanesCovered(contract, green)).toBe(true);
      for (let index = 0; index < green.length; index++) {
        const incomplete = green.filter((_, part) => part !== index);
        expect(requiredLanesCovered(contract, incomplete), names[index]).toBe(
          false,
        );
        const duplicate = [...incomplete, green[index === 0 ? 1 : 0]];
        expect(requiredLanesCovered(contract, duplicate), names[index]).toBe(
          false,
        );
        for (const conclusion of ["failure", "cancelled", "skipped"]) {
          const unsuccessful = green.map((job, part) =>
            part === index ? { ...job, conclusion } : job,
          );
          expect(
            requiredLanesCovered(contract, unsuccessful),
            `${names[index]}:${conclusion}`,
          ).toBe(false);
        }
      }
    },
  );

  it("does not use the smaller historical matrices as current failed-lane coverage", () => {
    expect(
      requiredLanesCovered(
        { required_lanes: ["vitest"] },
        [1, 2].map((part) => ({
          name: `tests-vitest (${part}/2)`,
          conclusion: "success",
        })),
      ),
    ).toBe(false);
    expect(
      requiredLanesCovered(
        { required_lanes: ["control-plane-db"] },
        [1, 2, 3, 4].map((part) => ({
          name: `control-plane database (${part})`,
          conclusion: "success",
        })),
      ),
    ).toBe(false);
  });

  const greenJobs = [
    "quality",
    "test",
    "build",
    "source-sync (macOS)",
    "control plane",
    "ui-smoke (composer)",
    "secret scan (PR commit range)",
  ].map((name, i) => ({ id: i + 1, name, conclusion: "success", steps: [] }));

  it("requires the complete canonical main Preflight evidence", () => {
    expect(isFullyGreen({ ...run, conclusion: "success" }, greenJobs)).toBe(
      true,
    );
    expect(
      isFullyGreen({ ...run, conclusion: "success" }, greenJobs.slice(1)),
    ).toBe(false);
    expect(
      isFullyGreen({ ...run, conclusion: "success" }, [
        ...greenJobs,
        { id: 8, name: "new workload", conclusion: "cancelled" },
      ]),
    ).toBe(false);
    expect(
      isFullyGreen(
        { ...run, status: "in_progress", conclusion: "success" },
        greenJobs,
      ),
    ).toBe(false);
  });

  it("resolves only untouched incidents after authenticated ancestry proof", () => {
    expect(decision({ incident, resolved: true }).action).toBe("resolve");
    expect(decision({ incident, resolved: false }).action).toBe("retry");
    expect(
      decision({ incident: { ...incident, untouched: false }, resolved: true })
        .action,
    ).toBe("none");
    expect(
      decision({ incident, resolved: true, mode: "retry" }).writeAllowed,
    ).toBe(false);
    expect(decision({ resolved: true }).action).toBe("none");
  });
});

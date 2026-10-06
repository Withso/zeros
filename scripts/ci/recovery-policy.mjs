import { createHash } from "node:crypto";

export const REPOSITORY = "Withso/zeros";
export const MAIN_REF = "refs/heads/main";
export const PREFLIGHT_PATH = ".github/workflows/preflight.yml";
export const CONTROLLER_PATH = ".github/workflows/ci-recovery.yml";
export const MAX_OPEN = 10;
export const MAX_NEW_PER_DAY = 3;
export const MAX_OCCURRENCES = 32;

const FAILED = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "cancelled",
  "action_required",
  "stale",
  "neutral",
]);
const PROVISIONING = new Set(["failure", "timed_out", "startup_failure"]);
export const COMPOSER_TEST_STEPS = new Set([
  "Composer model-menu interaction contract",
  "Composer UI smoke shard",
  "Run composer UI smoke shard",
  "Run UI smoke shard",
]);

// Commands and presentation names are trusted controller policy. API text,
// logs, PR prose and artifacts cannot supply an executable command.
export const REPRODUCTIONS = Object.freeze({
  composer: {
    platform: "linux",
    command_id: "composer-shard",
    display_command: "pnpm test:ui-smoke",
  },
  quality: {
    platform: "linux",
    command_id: "quality",
    display_command: "pnpm typecheck && pnpm lint && pnpm check:ui",
  },
  vitest: {
    platform: "linux",
    command_id: "vitest",
    display_command: "pnpm test:git",
  },
  build: {
    platform: "linux",
    command_id: "build",
    display_command:
      "pnpm build:ui && pnpm build:engine && pnpm build:electron",
  },
  macos: {
    platform: "macos",
    command_id: "macos",
    display_command: "pnpm smoke:engine",
  },
  "control-plane-db": {
    platform: "linux",
    command_id: "control-plane-db",
    display_command: "pnpm test:control-plane",
  },
  "control-plane-static": {
    platform: "linux",
    command_id: "control-plane-static",
    display_command: "pnpm --dir apps/control-plane typecheck",
  },
  "secret-scan": {
    platform: "linux",
    command_id: "secret-scan",
    display_command: "pnpm check:secrets",
  },
  unknown: {
    platform: "unknown",
    command_id: "manual-triage",
    display_command:
      "Consult the canonical workflow; no registered reproduction command.",
  },
});

export const REQUEST_LABELS = Object.freeze({
  composer: "ci:ui-smoke",
  macos: "ci:macos",
  "control-plane-db": "ci:control-plane-db",
});

const STEP_KEYS = new Map([
  ["Set up job", "runner-provisioning"],
  ["Install JS dependencies", "install-dependencies"],
  [
    "Install control-plane dependencies for title smoke",
    "install-control-plane",
  ],
  ["Install Playwright Chromium", "install-chromium"],
  ["Install Playwright Chromium headless shell", "install-chromium"],
  ["Typecheck — desktop source (renderer + engine)", "typecheck-desktop"],
  ["Typecheck — Electron main + preload", "typecheck-electron"],
  ["Typecheck — packages + marketing", "typecheck-packages"],
  ["Typecheck — web hub + Pages Functions", "typecheck-web"],
  ["Lint (desktop source + Electron)", "lint"],
  ["Design-token consistency", "ui-policy"],
  ["Run vitest suite", "vitest"],
  ["Migration ladder is forward-only", "migrations"],
  ["Secret scan (tracked files)", "tracked-secrets"],
  ["Third-party license inventory is current", "licenses"],
  ["Production dependency audit has no unreviewed high advisory", "audit"],
  ["Build renderer (vite)", "build-renderer"],
  ["Build engine bundle (tsup)", "build-engine"],
  ["Compile Electron main + preload (tsup)", "build-electron"],
  [
    "Compile engine sidecar binary (bun cross-compile → macOS arm64)",
    "build-sidecar",
  ],
  ["Build marketing site", "build-marketing"],
  ["Assemble web hub production build", "build-web"],
  ["Typecheck control plane", "typecheck-control-plane"],
  ["Audit control-plane production dependencies", "audit-control-plane"],
  [
    "Control-plane tests (migrations + auth/invite contracts)",
    "control-plane-db",
  ],
  ["Upload the shard's test report", "report-upload"],
  ["Enforce control-plane results", "db-reports"],
  ["Download database shard reports", "db-reports-download"],
  ["gitleaks", "secret-scan"],
]);

export function canonicalJson(value) {
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function recoveryMode(value) {
  return value === "retry" || value === "enabled" ? value : "off";
}

export function laneForJob(name) {
  if (
    /^tests-ui-smoke \([1-3]\/3\)$/.test(name) ||
    name === "ui-smoke (composer)"
  )
    return "composer";
  if (name === "quality") return "quality";
  if (
    /^tests-vitest \([12]\/2\)$/.test(name) ||
    /^test-shard \([12]\)$/.test(name)
  )
    return "vitest";
  if (name === "build") return "build";
  if (name === "source-sync workload (macOS)" || name === "tests-macos")
    return "macos";
  if (
    /^control-plane database(?: \([1-4]\))?$/.test(name) ||
    /^tests-control-plane-db \([1-4]\/4\)$/.test(name)
  )
    return "control-plane-db";
  if (
    name === "control-plane typecheck + audit" ||
    name === "control-plane-static"
  )
    return "control-plane-static";
  if (name === "secret scan (PR commit range)" || name === "secret-scan")
    return "secret-scan";
  return "unknown";
}

export function reproductionFor(root) {
  const reproduction = {
    ...(REPRODUCTIONS[root.lane] ?? REPRODUCTIONS.unknown),
  };
  if (root.lane === "composer" && root.shard) {
    reproduction.display_command += " --shard=" + root.shard + "/3";
  }
  return reproduction;
}

export function rootKey(root) {
  return (
    root.lane + (root.shard ? "[" + root.shard + "/3]" : "") + ":" + root.step
  );
}

export function latestJobs(jobs) {
  const latest = new Map();
  for (const job of jobs) {
    const previous = latest.get(job.name);
    if (
      !previous ||
      (job.run_attempt ?? 1) > (previous.run_attempt ?? 1) ||
      ((job.run_attempt ?? 1) === (previous.run_attempt ?? 1) &&
        BigInt(job.id) > BigInt(previous.id))
    ) {
      latest.set(job.name, job);
    }
  }
  return [...latest.values()];
}

const unsuccessful = (conclusion) =>
  conclusion !== "success" && conclusion !== "skipped";

function isDependentVerdict(job, step, jobs) {
  let producer;
  if (job.name === "test" && step.name === "Enforce the test result") {
    producer = (candidate) => laneForJob(candidate.name) === "vitest";
  } else if (
    job.name === "source-sync (macOS)" &&
    step.name === "Enforce the source-sync result"
  ) {
    producer = (candidate) => laneForJob(candidate.name) === "macos";
  } else if (
    job.name === "ui-smoke (composer)" &&
    step.name === "Enforce the UI smoke result"
  ) {
    producer = (candidate) =>
      /^tests-ui-smoke \([1-3]\/3\)$/.test(candidate.name);
  } else if (
    job.name === "control plane" &&
    step.name === "Enforce control-plane results"
  ) {
    producer = (candidate) =>
      candidate.name === "control-plane scope" ||
      ["control-plane-db", "control-plane-static"].includes(
        laneForJob(candidate.name),
      );
  } else if (
    job.name === "alpha-gate" &&
    step.name === "Enforce all Alpha critical producers and DB reports"
  ) {
    producer = (candidate) =>
      [
        "quality",
        "vitest",
        "build",
        "control-plane-db",
        "control-plane-static",
        "secret-scan",
      ].includes(laneForJob(candidate.name)) ||
      ["scope", "cloud-runner", "runtime-bundle", "codeql"].includes(
        candidate.name,
      );
  }
  // A familiar job name alone is not dependency evidence. A report checker,
  // direct legacy workload or unknown step can fail independently of shards.
  return Boolean(
    producer &&
    jobs.some(
      (candidate) =>
        candidate !== job &&
        unsuccessful(candidate.conclusion) &&
        producer(candidate),
    ),
  );
}

function rootLane(job, step) {
  if (job.name === "test" && step.name !== "Enforce the test result")
    return "vitest";
  if (
    job.name === "source-sync (macOS)" &&
    step.name !== "Enforce the source-sync result"
  )
    return "macos";
  if (job.name === "control plane") {
    if (
      ["db-reports", "db-reports-download", "control-plane-db"].includes(
        STEP_KEYS.get(step.name),
      )
    )
      return "control-plane-db";
    if (
      ["typecheck-control-plane", "audit-control-plane"].includes(
        STEP_KEYS.get(step.name),
      )
    )
      return "control-plane-static";
  }
  return laneForJob(job.name ?? "");
}

export function classifyFailures(jobs) {
  const roots = [];
  const failedJobs = jobs.filter((job) => unsuccessful(job.conclusion));
  for (const job of failedJobs) {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const executed = steps.filter(
      (step) =>
        !(step.name === "Complete job" && step.conclusion === "success") &&
        step.conclusion !== "skipped" &&
        (step.conclusion ||
          step.started_at ||
          step.status === "in_progress" ||
          step.status === "completed"),
    );
    const setupFailure =
      executed.length === 1 &&
      executed[0].name === "Set up job" &&
      PROVISIONING.has(executed[0].conclusion);
    const provisioning =
      PROVISIONING.has(job.conclusion) && (!executed.length || setupFailure);
    const failedSteps = provisioning
      ? [{ number: 1, name: "Set up job", conclusion: job.conclusion }]
      : steps.filter(
          (step) => step.conclusion && unsuccessful(step.conclusion),
        );
    if (!failedSteps.length)
      failedSteps.push({
        number: 1,
        name: "Unknown failure",
        conclusion: job.conclusion,
      });
    for (const step of failedSteps) {
      if (!provisioning && isDependentVerdict(job, step, jobs)) continue;
      const lane = rootLane(job, step);
      const composerTest =
        lane === "composer" && COMPOSER_TEST_STEPS.has(step.name);
      const key = provisioning
        ? "runner-provisioning"
        : composerTest
          ? "composer-shard"
          : (STEP_KEYS.get(step.name) ??
            "unknown-" + digest(String(step.name)).slice(0, 12));
      roots.push({
        jobId: String(job.id),
        jobName: lane === "unknown" ? "Unregistered workload" : job.name,
        lane,
        shard:
          lane === "composer"
            ? Number(/^tests-ui-smoke \(([1-3])\/3\)$/.exec(job.name)?.[1]) ||
              null
            : null,
        step: key,
        stepName: key.startsWith("unknown-")
          ? "Unregistered failing step"
          : step.name,
        number:
          Number.isInteger(step.number) && step.number > 0 ? step.number : 1,
        conclusion: FAILED.has(step.conclusion) ? step.conclusion : "failure",
        retryEligible:
          provisioning ||
          (composerTest &&
            PROVISIONING.has(job.conclusion) &&
            PROVISIONING.has(step.conclusion)),
      });
    }
  }
  // A dependent alone, an absent producer or an unfamiliar API conclusion
  // cannot become an optimistic retry. It remains an explicit unknown root.
  if (!roots.length && failedJobs.length) {
    roots.push({
      jobId: String(failedJobs[0].id),
      jobName: "Dependent without a failed producer",
      lane: "unknown",
      shard: null,
      step: "aggregate-without-root",
      stepName: "Missing root failure evidence",
      number: 1,
      conclusion: "failure",
      retryEligible: false,
    });
  }
  return {
    roots,
    eligible: roots.length > 0 && roots.every((root) => root.retryEligible),
  };
}

export function failureSignature(repository, workflowId, roots) {
  const keys = [...new Set(roots.map(rootKey))].sort();
  return digest(
    canonicalJson([repository, MAIN_REF, String(workflowId), keys]),
  );
}

const decimal = (value) => /^[1-9]\d{0,19}$/.test(String(value));
const sameRepository = (value) =>
  value?.toLowerCase() === REPOSITORY.toLowerCase();

export function isSourceRun(run, workflow) {
  return (
    workflow?.name === "Preflight" &&
    workflow.path === PREFLIGHT_PATH &&
    String(run.workflow_id) === String(workflow.id) &&
    run.name === "Preflight" &&
    run.path === PREFLIGHT_PATH &&
    run.event === "push" &&
    run.head_branch === "main" &&
    sameRepository(run.repository?.full_name) &&
    sameRepository(run.head_repository?.full_name) &&
    /^[a-f0-9]{40}$/.test(run.head_sha ?? "") &&
    decimal(run.id) &&
    Number.isInteger(run.run_attempt) &&
    run.run_attempt >= 1 &&
    run.run_attempt <= 100
  );
}

export function isAncestorComparison(comparison, ancestor, head) {
  return (
    comparison?.base_commit?.sha === ancestor &&
    comparison.merge_base_commit?.sha === ancestor &&
    ["ahead", "identical"].includes(comparison.status) &&
    (comparison.status !== "identical" || ancestor === head)
  );
}

export function isFullyGreen(run, jobs) {
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  const byName = new Map(jobs.map((job) => [job.name, job.conclusion]));
  const required = [
    "quality",
    "test",
    "build",
    "source-sync (macOS)",
    "control plane",
    "ui-smoke (composer)",
    "secret scan (PR commit range)",
  ];
  return (
    required.every((name) => byName.get(name) === "success") &&
    jobs.every(
      (job) => job.conclusion === "success" || job.conclusion === "skipped",
    )
  );
}

export function requiredLanesCovered(contract, jobs) {
  return contract.required_lanes.every((lane) => {
    if (lane === "unknown") return true;
    const matching = jobs.filter((job) => laneForJob(job.name) === lane);
    if (lane === "composer") {
      const shards = matching.filter((job) =>
        /^tests-ui-smoke \([1-3]\/3\)$/.test(job.name),
      );
      if (shards.length)
        return [1, 2, 3].every((shard) =>
          shards.some(
            (job) =>
              job.name === "tests-ui-smoke (" + shard + "/3)" &&
              job.conclusion === "success",
          ),
        );
      return matching.some(
        (job) =>
          job.name === "ui-smoke (composer)" &&
          job.conclusion === "success" &&
          job.steps?.some(
            (step) =>
              COMPOSER_TEST_STEPS.has(step.name) &&
              step.conclusion === "success",
          ),
      );
    }
    const expected =
      lane === "control-plane-db" ? 4 : lane === "vitest" ? 2 : 1;
    return (
      matching.length >= expected &&
      matching.every((job) => job.conclusion === "success")
    );
  });
}

export function decideRecovery({
  run,
  roots,
  signature,
  incident = null,
  duplicate = false,
  branchExists = false,
  openCount = 0,
  newToday = 0,
  retryReserved = false,
  retryHistoryComplete = true,
  resolved = false,
  mode = "off",
}) {
  const decision = (action, reason) => ({
    signature,
    action,
    reason,
    writeAllowed:
      action !== "none" &&
      (mode === "enabled" || (mode === "retry" && action === "retry")),
  });
  if (duplicate) return decision("none", "duplicate-incident-needs-owner");
  if (incident) {
    if (
      !incident.appAuthor ||
      incident.branch !== "ci-fix/" + signature ||
      incident.state !== "open"
    ) {
      return decision("none", "unowned-branch-needs-owner");
    }
    if (!incident.untouched || incident.contract?.claimed_by) {
      return decision("none", "claimed-touched-or-resolved");
    }
    if (incident.contract?.state === "resolved" && resolved) {
      return decision("resolve", "finish-resolution-label");
    }
    if (incident.contract?.state !== "awaiting_agent") {
      return decision("none", "claimed-touched-or-resolved");
    }
  }
  if (resolved)
    return decision(incident ? "resolve" : "none", "current-main-green");
  if (
    !run ||
    run.status !== "completed" ||
    !FAILED.has(run.conclusion) ||
    !roots?.length
  ) {
    return decision("none", "no-completed-root-failure");
  }
  if (run.run_attempt === 1 && roots.every((root) => root.retryEligible)) {
    if (!retryHistoryComplete)
      return decision("none", "retry-history-needs-owner");
    return retryReserved
      ? decision("none", "retry-outcome-unknown")
      : decision("retry", "eligible-first-attempt");
  }
  if (incident) {
    const latest = incident.contract.latest_failure;
    if (
      BigInt(latest.run_id) > BigInt(run.id) ||
      (String(latest.run_id) === String(run.id) &&
        latest.attempt >= run.run_attempt)
    ) {
      return decision("none", "occurrence-already-recorded");
    }
    return decision("upsert", "update-incident");
  }
  if (branchExists) return decision("none", "retained-ref-needs-owner");
  if (openCount >= MAX_OPEN) return decision("none", "open-incident-budget");
  if (newToday >= MAX_NEW_PER_DAY)
    return decision("none", "daily-creation-budget");
  return decision("upsert", "create-incident");
}

#!/usr/bin/env node
// Owner-run, add-before-remove migration of the main required-check ruleset.
// gh inherits authentication from the owner's session; credentials never enter
// argv, payloads or diagnostics. No workflow or producer is changed here.

import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "Withso/zeros";
export const RULESET_ID = 20461995;
export const ACTIONS_INTEGRATION_ID = 15368;
export const LEGACY_CONTEXTS = [
  "quality",
  "test",
  "build",
  "source-sync (macOS)",
  "control plane",
  "ui-smoke (composer)",
  "secret scan (PR commit range)",
  "actionlint",
  "codeql",
];
export const FINAL_CONTEXTS = [
  "zeros/ci-gate",
  "actionlint",
  "codeql",
  "secret-scan",
];
const REPLACEMENTS = ["zeros/ci-gate", "secret-scan"];
const STAGES = ["add-gate", "add-secret-scan", "finalize", "rollback"];
const RULESET_ENDPOINT = `repos/${REPOSITORY}/rulesets/${RULESET_ID}`;
const API_ROOT = `repos/${REPOSITORY}`;
const DAY_MS = 24 * 60 * 60 * 1000;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// These are the writable fields of the ruleset PUT API. GET-only metadata (id,
// source, timestamps, _links, current_user_can_bypass) is deliberately omitted.
function writableRuleset(live) {
  requireCondition(live?.id === RULESET_ID, "Unexpected ruleset id.");
  requireCondition(live.target === "branch", "Expected a branch ruleset.");
  requireCondition(
    !live.source || live.source.toLowerCase() === REPOSITORY.toLowerCase(),
    "Unexpected ruleset repository.",
  );
  const payload = {};
  for (const key of [
    "name",
    "target",
    "enforcement",
    "conditions",
    "bypass_actors",
    "rules",
  ]) {
    requireCondition(Object.hasOwn(live, key), `Ruleset is missing ${key}.`);
    payload[key] = structuredClone(live[key]);
  }
  return payload;
}

function requiredRule(payload) {
  requireCondition(
    Array.isArray(payload.rules),
    "Ruleset rules are unreadable.",
  );
  const indexes = payload.rules.flatMap((rule, index) =>
    rule.type === "required_status_checks" ? [index] : [],
  );
  requireCondition(
    indexes.length === 1,
    "Expected exactly one required-status-check rule.",
  );
  const index = indexes[0];
  const parameters = payload.rules[index].parameters;
  requireCondition(
    Array.isArray(parameters?.required_status_checks) &&
      typeof parameters.strict_required_status_checks_policy === "boolean",
    "Required-status-check parameters are unreadable.",
  );
  const checks = parameters.required_status_checks;
  const seen = new Set();
  for (const check of checks) {
    requireCondition(
      typeof check.context === "string" && check.context.length > 0,
      "Invalid required context.",
    );
    const key = JSON.stringify([check.context, check.integration_id]);
    requireCondition(
      !seen.has(key),
      `Duplicate requirement: ${check.context}.`,
    );
    seen.add(key);
    if ([...LEGACY_CONTEXTS, ...REPLACEMENTS].includes(check.context)) {
      requireCondition(
        check.integration_id === ACTIONS_INTEGRATION_ID,
        `${check.context} must remain bound to Actions integration ${ACTIONS_INTEGRATION_ID}.`,
      );
    }
  }
  return { index, parameters, checks };
}

export function createPlan(live, stage, rollbackPhase = "restore") {
  requireCondition(STAGES.includes(stage), `Unknown stage: ${stage}.`);
  requireCondition(
    ["restore", "retire"].includes(rollbackPhase),
    "Rollback phase must be restore or retire.",
  );
  const payload = writableRuleset(live);
  const { index, parameters, checks } = requiredRule(payload);
  const before = structuredClone(checks);
  const has = (context) => checks.some((check) => check.context === context);
  const requireNames = (names, message) => {
    const missing = names.filter((name) => !has(name));
    requireCondition(
      missing.length === 0,
      `${message} Missing: ${missing.join(", ")}.`,
    );
  };
  const append = (names) => {
    for (const context of names) {
      if (!has(context))
        checks.push({ context, integration_id: ACTIONS_INTEGRATION_ID });
    }
  };
  requireNames(
    ["actionlint", "codeql"],
    "Independent scanners must stay required.",
  );
  let verifyContexts;
  if (stage === "add-gate") {
    if (!has("zeros/ci-gate"))
      requireNames(
        LEGACY_CONTEXTS,
        "Restore the nine legacy requirements before adding the gate.",
      );
    append(["zeros/ci-gate"]);
    verifyContexts = ["zeros/ci-gate"];
  } else if (stage === "add-secret-scan") {
    requireNames(["zeros/ci-gate"], "Run add-gate first.");
    if (!has("secret-scan"))
      requireNames(
        LEGACY_CONTEXTS,
        "Keep all legacy requirements during the overlap.",
      );
    append(["secret-scan"]);
    verifyContexts = REPLACEMENTS;
  } else if (stage === "finalize") {
    requireNames(
      FINAL_CONTEXTS,
      "Add both replacements before retiring legacy requirements.",
    );
    parameters.required_status_checks = checks.filter(
      (check) =>
        !LEGACY_CONTEXTS.includes(check.context) ||
        FINAL_CONTEXTS.includes(check.context),
    );
    verifyContexts = FINAL_CONTEXTS;
  } else {
    verifyContexts = LEGACY_CONTEXTS;
    if (rollbackPhase === "restore") {
      if (!LEGACY_CONTEXTS.every(has))
        requireNames(
          FINAL_CONTEXTS,
          "Rollback needs the protected final set or the full legacy set.",
        );
      append(LEGACY_CONTEXTS);
    } else {
      requireNames(
        LEGACY_CONTEXTS,
        "Run rollback --rollback-phase restore before retiring replacements.",
      );
      parameters.required_status_checks = checks.filter(
        (check) => !REPLACEMENTS.includes(check.context),
      );
    }
  }
  const after = structuredClone(parameters.required_status_checks);
  return {
    stage,
    rollbackPhase,
    payload,
    beforePayload: writableRuleset(live),
    before,
    after,
    verifyContexts: [...verifyContexts],
    diff: isDeepStrictEqual(before, after)
      ? []
      : [
          {
            op: "replace",
            path: `/rules/${index}/parameters/required_status_checks`,
            value: after,
          },
        ],
  };
}

export function createGhClient(execute = execFileSync) {
  return {
    request(method, endpoint, { paginate = false, input } = {}) {
      const args = [
        "api",
        "--method",
        method,
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2022-11-28",
      ];
      if (paginate) args.push("--paginate", "--slurp");
      if (input) args.push("--input", input);
      let output;
      try {
        output = execute("gh", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120_000,
        });
      } catch (error) {
        // Do not relay stderr, command arguments, or environment from gh.
        throw new Error(
          `gh api ${method} ${endpoint.split("?")[0]} failed (exit ${error.status ?? "unknown"}); check authentication and access.`,
        );
      }
      try {
        return JSON.parse(output);
      } catch {
        throw new Error("gh api returned unreadable JSON.");
      }
    },
  };
}

function listPages(gh, endpoint, key) {
  const pages = gh.request("GET", endpoint, { paginate: true });
  requireCondition(
    Array.isArray(pages),
    "Paginated API response is unreadable.",
  );
  const rows = pages.flatMap((page) => {
    const values = key ? page[key] : page;
    requireCondition(
      Array.isArray(values),
      "Paginated API page is unreadable.",
    );
    return values;
  });
  if (key) {
    requireCondition(
      pages.every(
        (page) =>
          Number.isInteger(page.total_count) &&
          page.total_count === rows.length,
      ),
      "API pagination is incomplete; refusing to qualify partial evidence.",
    );
  }
  return rows;
}

function validSha(sha) {
  requireCondition(
    typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha),
    "API returned an invalid head SHA.",
  );
  return sha;
}

function openPullRequests(gh) {
  return listPages(gh, `${API_ROOT}/pulls?state=open&per_page=100`)
    .map((pr) => {
      requireCondition(
        Number.isSafeInteger(pr.number) && pr.number > 0,
        "API returned an invalid PR number.",
      );
      return {
        number: pr.number,
        head: validSha(pr.head?.sha),
        testedHead: pr.merge_commit_sha ? validSha(pr.merge_commit_sha) : null,
        base: pr.base?.ref,
      };
    })
    .sort((left, right) => left.number - right.number);
}

function recentHeads(gh, cutoff, now) {
  const heads = new Set();
  // GitHub caps a filtered Actions run search at 1,000 rows. Query each UTC
  // date independently and fail closed if any bucket cannot be fully read.
  const firstDay = new Date(cutoff);
  firstDay.setUTCHours(0, 0, 0, 0);
  for (let date = firstDay.getTime(); date <= now.getTime(); date += DAY_MS) {
    const day = new Date(date).toISOString().slice(0, 10);
    const query = new URLSearchParams({
      created: `${day}..${day}`,
      per_page: "100",
    });
    const runs = listPages(
      gh,
      `${API_ROOT}/actions/runs?${query}`,
      "workflow_runs",
    );
    requireCondition(
      runs.length < 1000,
      `Actions run search reached its 1,000-run limit on ${day}; evidence is incomplete.`,
    );
    for (const run of runs) heads.add(validSha(run.head_sha));
  }
  return heads;
}

function checkReader(gh) {
  const jobs = new Map();
  const runs = new Map();
  const observed = new Map();
  return {
    observed,
    checks(sha) {
      const rows = listPages(
        gh,
        `${API_ROOT}/commits/${validSha(sha)}/check-runs?filter=all&per_page=100`,
        "check_runs",
      );
      const checks = new Map();
      for (const check of rows) {
        requireCondition(
          Number.isSafeInteger(check.id) &&
            check.id > 0 &&
            typeof check.name === "string",
          "API returned an invalid check run.",
        );
        requireCondition(
          check.head_sha?.toLowerCase() === sha.toLowerCase(),
          "Check run does not match the requested head.",
        );
        requireCondition(
          !checks.has(check.id),
          "Repeated check run in API pagination; read the evidence again.",
        );
        checks.set(check.id, check);
      }
      return [...checks.values()];
    },
    producer(check) {
      let url;
      try {
        url = new URL(check.details_url);
      } catch {
        throw new Error(
          `Cannot identify the Actions job producing ${check.name}.`,
        );
      }
      const match =
        /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?\/job\/(\d+)$/.exec(
          url.pathname,
        );
      requireCondition(
        url.origin === "https://github.com" &&
          match?.[1].toLowerCase() === REPOSITORY.toLowerCase(),
        `Cannot identify the repository job producing ${check.name}.`,
      );
      const runId = Number(match[2]);
      const jobId = Number(match[3]);
      requireCondition(
        Number.isSafeInteger(runId) && Number.isSafeInteger(jobId),
        "Invalid Actions job identity.",
      );
      if (!jobs.has(jobId))
        jobs.set(jobId, gh.request("GET", `${API_ROOT}/actions/jobs/${jobId}`));
      if (!runs.has(runId))
        runs.set(runId, gh.request("GET", `${API_ROOT}/actions/runs/${runId}`));
      const job = jobs.get(jobId);
      const run = runs.get(runId);
      requireCondition(
        job.id === jobId &&
          job.run_id === runId &&
          job.name === check.name &&
          job.check_run_url ===
            `https://api.github.com/${API_ROOT}/check-runs/${check.id}` &&
          Number.isInteger(job.run_attempt) &&
          job.run_attempt > 0 &&
          run.id === runId &&
          typeof run.path === "string" &&
          run.path.startsWith(".github/workflows/"),
        `Actions job identity did not match ${check.name}.`,
      );
      const key = `${run.path}:${job.name}`;
      if (!observed.has(check.name)) observed.set(check.name, new Set());
      observed.get(check.name).add(key);
      return {
        key,
        attempt: `${runId}/${job.run_attempt}`,
        jobId,
      };
    },
  };
}

function inspectChecks(reader, checks, contexts, label, problems) {
  const groups = new Map(contexts.map((name) => [name, []]));
  for (const check of checks) {
    if (!groups.has(check.name)) continue;
    if (check.app?.id !== ACTIONS_INTEGRATION_ID) {
      problems.push(
        `${label}: ${check.name} reports from unexpected integration ${check.app?.id ?? "missing"}.`,
      );
      continue;
    }
    const producer = reader.producer(check);
    groups.get(check.name).push({ check, producer });
  }
  for (const [name, rows] of groups) {
    const producers = new Set(rows.map((row) => row.producer.key));
    const attempts = new Map();
    for (const row of rows) {
      const key = `${row.producer.key}/${row.producer.attempt}`;
      if (!attempts.has(key)) attempts.set(key, new Set());
      attempts.get(key).add(row.producer.jobId);
    }
    if (
      producers.size > 1 ||
      [...attempts.values()].some((ids) => ids.size > 1)
    ) {
      problems.push(
        `${label}: ${name} is produced by two different jobs (${[...producers].join(", ")}).`,
      );
    }
  }
  return groups;
}

function inspectPullRequests(reader, prs, plan, problems, log, recent) {
  for (const pr of prs) {
    const label = `PR #${pr.number} head ${pr.head}`;
    const groups = inspectChecks(
      reader,
      reader.checks(pr.head),
      plan.verifyContexts,
      label,
      problems,
    );
    for (const [name, rows] of groups) {
      for (const { check } of rows) recent?.get(name).push(check);
      const latest = rows.sort(
        (left, right) => right.check.id - left.check.id,
      )[0]?.check;
      if (!latest) {
        problems.push(`${label}: missing ${name}.`);
      } else {
        // The legacy composer placeholder intentionally skips on PRs. Its
        // repository success must still come from the real post-merge suite.
        const legacyComposer =
          plan.stage === "rollback" &&
          name === "ui-smoke (composer)" &&
          latest.conclusion === "skipped";
        if (
          latest.status !== "completed" ||
          (latest.conclusion !== "success" && !legacyComposer)
        ) {
          problems.push(
            `${label}: ${name} is ${latest.status}/${latest.conclusion ?? "pending"}, not green.`,
          );
        }
      }
    }
    log(
      `Checked PR #${pr.number} source ${pr.head} (tested merge ${pr.testedHead ?? "unavailable"}).`,
    );
  }
}

export function verifyPlan(
  gh,
  plan,
  { now = new Date(), log = console.log } = {},
) {
  requireCondition(
    Number.isFinite(now.getTime()),
    "Invalid verification time.",
  );
  const cutoff = new Date(now.getTime() - 7 * DAY_MS);
  const problems = [];
  const prs = openPullRequests(gh);
  const reader = checkReader(gh);
  const recent = new Map(plan.verifyContexts.map((name) => [name, []]));
  log(
    `Verifying ${plan.verifyContexts.join(", ")} since ${cutoff.toISOString()} on ${prs.length} open PR heads.`,
  );
  inspectPullRequests(reader, prs, plan, problems, log, recent);
  const heads = recentHeads(gh, cutoff, now);
  for (const pr of prs) heads.delete(pr.head);
  let read = 0;
  for (const sha of heads) {
    const checks = reader.checks(sha).filter((check) => {
      const timestamp = Date.parse(check.completed_at ?? check.started_at);
      return timestamp >= cutoff.getTime() && timestamp <= now.getTime();
    });
    const groups = inspectChecks(
      reader,
      checks,
      plan.verifyContexts,
      `Repository head ${sha}`,
      problems,
    );
    for (const [name, rows] of groups)
      recent.get(name).push(...rows.map((row) => row.check));
    read += 1;
    if (read % 25 === 0)
      log(`Read recent checks on ${read}/${heads.size} repository heads.`);
  }
  for (const [name, checks] of recent) {
    const success = checks.find((check) => {
      const completed = Date.parse(check.completed_at);
      return (
        check.status === "completed" &&
        check.conclusion === "success" &&
        completed >= cutoff.getTime() &&
        completed <= now.getTime()
      );
    });
    if (!success)
      problems.push(
        `${name}: no recent success in the last 7 days from Actions integration ${ACTIONS_INTEGRATION_ID}.`,
      );
    else
      log(
        `${name}: recent success at ${success.completed_at} (check ${success.id}).`,
      );
  }
  for (const [name, producers] of reader.observed) {
    // Legacy families intentionally have separate PR and push definitions.
    // Their exact-head collision checks still apply. Final names must have
    // one canonical workflow producer throughout the evidence window.
    const legacyFamily =
      plan.stage === "rollback" &&
      LEGACY_CONTEXTS.includes(name) &&
      !FINAL_CONTEXTS.includes(name);
    if (!legacyFamily && producers.size > 1) {
      problems.push(
        `Repository: ${name} is produced by two different jobs (${[...producers].join(", ")}).`,
      );
    }
  }
  for (const problem of problems) log(`GAP: ${problem}`);
  log(
    problems.length
      ? `Verification failed with ${problems.length} gap(s); no PUT is permitted.`
      : "Verification passed.",
  );
  return { passed: problems.length === 0, problems, prs };
}

function writePlan(plan, live, cwd, log) {
  const directory = path.join(cwd, ".context/ci-rollout");
  mkdirSync(directory, { recursive: true });
  const payloadFile = path.join(directory, `${plan.stage}.json`);
  for (const [file, value] of [
    [payloadFile, plan.payload],
    [path.join(directory, `${plan.stage}.diff.json`), plan.diff],
    [path.join(directory, `${plan.stage}.before.json`), live],
  ])
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  log(
    `${REPOSITORY} ruleset ${RULESET_ID}: ${plan.stage}${plan.stage === "rollback" ? ` (${plan.rollbackPhase})` : ""}`,
  );
  log(`Before required checks: ${JSON.stringify(plan.before)}`);
  log(`After required checks: ${JSON.stringify(plan.after)}`);
  log(`Exact JSON diff:\n${JSON.stringify(plan.diff, null, 2)}`);
  log(`PUT payload: ${payloadFile}\n${JSON.stringify(plan.payload, null, 2)}`);
  return payloadFile;
}

export function parseArgs(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]))
    return { help: true };
  const [command, ...flags] = argv;
  requireCondition(
    ["plan", "verify", "apply"].includes(command),
    "Command must be plan, verify, or apply.",
  );
  const options = { command, yes: false, rollbackPhase: "restore" };
  const seen = new Set();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    requireCondition(!seen.has(flag), `Duplicate option: ${flag}.`);
    seen.add(flag);
    if (flag === "--yes") options.yes = true;
    else if (flag === "--stage" || flag === "--rollback-phase") {
      const value = flags[++index];
      requireCondition(
        value && !value.startsWith("--"),
        `Missing value for ${flag}.`,
      );
      options[flag === "--stage" ? "stage" : "rollbackPhase"] = value;
    } else throw new Error(`Unknown option: ${flag}.`);
  }
  requireCondition(
    STAGES.includes(options.stage),
    `--stage must be ${STAGES.join("|")}.`,
  );
  requireCondition(
    !options.yes || command === "apply",
    "--yes is only valid with apply.",
  );
  requireCondition(
    !seen.has("--rollback-phase") || options.stage === "rollback",
    "--rollback-phase is only valid for rollback.",
  );
  requireCondition(
    ["restore", "retire"].includes(options.rollbackPhase),
    "--rollback-phase must be restore or retire.",
  );
  return options;
}

export function runMigration(
  argv,
  {
    gh = createGhClient(),
    cwd = process.cwd(),
    now = new Date(),
    log = console.log,
  } = {},
) {
  const options = parseArgs(argv);
  if (options.help) {
    log(
      "Usage: node scripts/ci/ruleset-migration.mjs plan|verify|apply --stage add-gate|add-secret-scan|finalize|rollback [--rollback-phase restore|retire] [--yes]\nApply is a dry run unless --yes is supplied. Rollback defaults to restore; retire requires the full legacy set already required.",
    );
    return 0;
  }
  const live = gh.request("GET", RULESET_ENDPOINT);
  requireCondition(
    !options.yes || live.enforcement === "active",
    "Live ruleset enforcement must be active before any write.",
  );
  const plan = createPlan(live, options.stage, options.rollbackPhase);
  const payloadFile =
    options.command === "verify" ? undefined : writePlan(plan, live, cwd, log);
  if (options.command === "plan") return 0;
  const verification = verifyPlan(gh, plan, { now, log });
  if (!verification.passed) return 1;
  if (options.command === "verify") return 0;
  if (!options.yes) {
    log(
      "Dry run passed; apply --yes must verify again in the same invocation before any PUT.",
    );
    return 0;
  }
  // A saved payload or an earlier verify is never authority for a later PUT.
  // Recheck the live ruleset and the current PR population immediately before
  // writing. GitHub has no compare-and-swap ruleset API; the owner must serialize
  // administrative changes and hold auto-merge during this operation.
  requireCondition(
    isDeepStrictEqual(
      writableRuleset(gh.request("GET", RULESET_ENDPOINT)),
      plan.beforePayload,
    ),
    "The ruleset changed during verification; plan and verify again.",
  );
  const currentPrs = openPullRequests(gh);
  requireCondition(
    isDeepStrictEqual(currentPrs, verification.prs),
    "Open PR heads changed during verification; plan and verify again.",
  );
  const problems = [];
  inspectPullRequests(checkReader(gh), currentPrs, plan, problems, log);
  requireCondition(
    problems.length === 0,
    `PR checks changed during verification: ${problems.join(" ")}`,
  );
  requireCondition(
    isDeepStrictEqual(
      JSON.parse(readFileSync(payloadFile, "utf8")),
      plan.payload,
    ),
    "The planned payload file changed; refusing PUT.",
  );
  if (plan.diff.length === 0) {
    log("Already at the planned state; no PUT needed.");
    return 0;
  }
  log(`Applying; before required checks: ${JSON.stringify(plan.before)}`);
  gh.request("PUT", RULESET_ENDPOINT, { input: payloadFile });
  const after = gh.request("GET", RULESET_ENDPOINT);
  writeFileSync(
    path.join(cwd, ".context/ci-rollout", `${plan.stage}.after.json`),
    `${JSON.stringify(after, null, 2)}\n`,
    { mode: 0o600 },
  );
  const afterPayload = writableRuleset(after);
  log(
    `Live after required checks: ${JSON.stringify(requiredRule(afterPayload).checks)}`,
  );
  requireCondition(
    isDeepStrictEqual(afterPayload, plan.payload),
    "Live ruleset differs from the planned payload; inspect the before/after snapshots before any further change.",
  );
  log("Applied and confirmed. Protection was never disabled.");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    process.exitCode = runMigration(process.argv.slice(2));
  } catch (error) {
    console.error(`Ruleset migration refused: ${error.message}`);
    process.exitCode = 1;
  }
}

import { readFileSync } from "node:fs";
import {
  canonicalJson,
  digest,
  failureSignature,
  MAIN_REF,
  MAX_OCCURRENCES,
  PREFLIGHT_PATH,
  REPOSITORY,
  reproductionFor,
  REQUEST_LABELS,
} from "./recovery-policy.mjs";

export const START = "<!-- zeros-ci-failure:v1:start -->";
export const END = "<!-- zeros-ci-failure:v1:end -->";
export const INCIDENT_SCHEMA = JSON.parse(
  readFileSync(new URL("./incident.schema.json", import.meta.url), "utf8"),
);
const FENCE = String.fromCharCode(96).repeat(3);
const unique = (values) => [...new Set(values)].sort();

// This schema deliberately uses a small JSON Schema vocabulary so the
// privileged controller needs only Node. Tests independently validate with AJV.
export function validateSchema(value, rule = INCIDENT_SCHEMA, path = "$") {
  if (rule.$ref) {
    rule = rule.$ref
      .slice(2)
      .split("/")
      .reduce((node, key) => node[key], INCIDENT_SCHEMA);
  }
  if (rule.anyOf) {
    if (
      !rule.anyOf.some((candidate) => {
        try {
          validateSchema(value, candidate, path);
          return true;
        } catch {
          return false;
        }
      })
    )
      throw new Error("Invalid schema value at " + path);
    return true;
  }
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    rule.type &&
    !(rule.type === "integer" ? Number.isInteger(value) : type === rule.type)
  ) {
    throw new Error("Invalid schema type at " + path);
  }
  if ("const" in rule && canonicalJson(value) !== canonicalJson(rule.const))
    throw new Error("Invalid constant at " + path);
  if (rule.enum && !rule.enum.includes(value))
    throw new Error("Invalid enum at " + path);
  if (type === "string") {
    if (
      (rule.pattern && !new RegExp(rule.pattern).test(value)) ||
      value.length < (rule.minLength ?? 0) ||
      value.length > (rule.maxLength ?? Infinity)
    ) {
      throw new Error("Invalid schema string at " + path);
    }
  }
  if (
    type === "number" &&
    (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))
  ) {
    throw new Error("Invalid schema number at " + path);
  }
  if (type === "object") {
    if (
      (rule.required ?? []).some((key) => !Object.hasOwn(value, key)) ||
      (rule.additionalProperties === false &&
        Object.keys(value).some((key) => !Object.hasOwn(rule.properties, key)))
    ) {
      throw new Error("Invalid schema properties at " + path);
    }
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (Object.hasOwn(value, key))
        validateSchema(value[key], child, path + "." + key);
    }
  }
  if (type === "array") {
    if (
      value.length < (rule.minItems ?? 0) ||
      value.length > (rule.maxItems ?? Infinity) ||
      (rule.uniqueItems &&
        new Set(value.map(canonicalJson)).size !== value.length)
    ) {
      throw new Error("Invalid schema array at " + path);
    }
    value.forEach((entry, i) =>
      validateSchema(entry, rule.items, path + "[" + i + "]"),
    );
  }
  return true;
}

export function contractDigest(contract) {
  const { controller_evidence: _evidence, ...payload } = contract;
  return digest(canonicalJson(payload));
}

export function validateContract(contract) {
  if (Buffer.byteLength(JSON.stringify(contract)) > 64 * 1024)
    throw new Error("Incident contract exceeds 64 KiB");
  validateSchema(contract);
  const roots = contract.latest_failure.failing_jobs.flatMap((job) =>
    job.steps.map((step) => ({
      lane: job.lane,
      shard: job.matrix.shard ?? null,
      step: step.key,
    })),
  );
  if (
    failureSignature(
      contract.repository,
      contract.latest_failure.workflow_id,
      roots,
    ) !== contract.signature ||
    contract.branch !== "ci-fix/" + contract.signature ||
    contract.marker_path !==
      ".github/ci-incidents/" + contract.signature + ".json" ||
    contract.latest_failure.run_url !==
      "https://github.com/" +
        REPOSITORY +
        "/actions/runs/" +
        contract.latest_failure.run_id ||
    contract.controller_evidence.payload_sha256 !== contractDigest(contract)
  ) {
    throw new Error("Invalid incident linkage");
  }
  const lanes = unique(roots.map((root) => root.lane));
  const additions = unique(
    lanes.map((lane) => REQUEST_LABELS[lane]).filter(Boolean),
  );
  if (
    canonicalJson(lanes) !== canonicalJson(contract.required_lanes) ||
    canonicalJson(additions) !== canonicalJson(contract.required_ci_additions)
  ) {
    throw new Error("Invalid compulsory incident lanes");
  }
  for (const job of contract.latest_failure.failing_jobs) {
    if (
      canonicalJson(job.reproduction) !==
      canonicalJson(
        reproductionFor({ lane: job.lane, shard: job.matrix.shard }),
      )
    ) {
      throw new Error("Unregistered reproduction command");
    }
  }
  return contract;
}

export function buildContract({
  run,
  roots,
  previous = null,
  associatedPrs = [],
  lastGreenSha = null,
  retried = false,
  evidence = null,
}) {
  const signature = failureSignature(REPOSITORY, run.workflow_id, roots);
  const occurrence = {
    sha: run.head_sha,
    run_id: String(run.id),
    attempt: run.run_attempt,
  };
  const byJob = new Map();
  for (const root of roots) {
    const group = root.jobId + ":" + root.lane;
    if (!byJob.has(group))
      byJob.set(group, {
        id: root.jobId,
        lane: root.lane,
        name: root.jobName,
        matrix: root.shard ? { shard: root.shard } : {},
        conclusion: root.conclusion,
        steps: [],
        diagnostic_key: null,
        redacted_excerpt: null,
        excerpt_omission_reason: "no_safe_allowlisted_excerpt",
        reproduction: reproductionFor(root),
      });
    byJob.get(group).steps.push({
      number: root.number,
      key: root.step,
      name: root.stepName,
      conclusion: root.conclusion,
    });
  }
  const occurrences = [...(previous?.occurrences ?? []), occurrence];
  const keys = new Set();
  const bounded = occurrences
    .filter((entry) => {
      const key = entry.run_id + ":" + entry.attempt;
      if (keys.has(key)) return false;
      keys.add(key);
      return true;
    })
    .slice(-MAX_OCCURRENCES);
  const lanes = unique(roots.map((root) => root.lane));
  const contract = {
    schema: "zeros.ci-failure/v1",
    signature,
    signature_version: 1,
    repository: REPOSITORY,
    incident_kind: "postmerge_full_ci",
    state: "awaiting_agent",
    claimed_by: null,
    base_branch: "main",
    branch: "ci-fix/" + signature,
    first_failure: previous?.first_failure ?? occurrence,
    latest_failure: {
      sha: run.head_sha,
      ref: MAIN_REF,
      workflow_id: String(run.workflow_id),
      workflow_path: PREFLIGHT_PATH,
      workflow_name: "Preflight",
      event: "push",
      run_id: String(run.id),
      attempt: run.run_attempt,
      run_url: "https://github.com/" + REPOSITORY + "/actions/runs/" + run.id,
      retry: {
        automatic_budget: 1,
        used: retried ? 1 : 0,
        attempts: Array.from({ length: run.run_attempt }, (_, i) => i + 1),
        result:
          run.run_attempt > 1
            ? "persistent_failure"
            : roots.every((root) => root.retryEligible)
              ? "not_attempted"
              : "not_eligible",
      },
      failing_jobs: [...byJob.values()],
      suspected_culprit_prs: associatedPrs
        .filter(
          (pr) =>
            Number.isSafeInteger(pr.number) &&
            pr.number > 0 &&
            pr.base?.ref === "main" &&
            pr.base?.repo?.full_name?.toLowerCase() ===
              REPOSITORY.toLowerCase(),
        )
        .slice(0, 10)
        .map((pr) => ({
          number: pr.number,
          url: "https://github.com/" + REPOSITORY + "/pull/" + pr.number,
          evidence_kind: "commit_association",
          confidence: "possible",
        })),
      culprit_confidence: "unknown",
      last_green_sha: lastGreenSha,
    },
    occurrences: bounded,
    required_lanes: lanes,
    required_ci_additions: unique(
      lanes.map((lane) => REQUEST_LABELS[lane]).filter(Boolean),
    ),
    marker_path: ".github/ci-incidents/" + signature + ".json",
    repair_generation: 1,
    resolved_by: null,
    controller_evidence: evidence,
  };
  if (evidence)
    contract.controller_evidence = {
      ...evidence,
      payload_sha256: contractDigest(contract),
    };
  return contract;
}

export function resolveContract(previous, greenRun, evidence = null) {
  const contract = structuredClone(previous);
  contract.state = "resolved";
  contract.resolved_by = {
    sha: greenRun.head_sha,
    run_id: String(greenRun.id),
    attempt: greenRun.run_attempt,
    reason: "current_main_full_preflight_green",
  };
  contract.controller_evidence = evidence;
  if (evidence)
    contract.controller_evidence = {
      ...evidence,
      payload_sha256: contractDigest(contract),
    };
  return contract;
}

export function renderJsonBlock(contract) {
  validateContract(contract);
  return (
    START +
    "\n" +
    FENCE +
    "json\n" +
    JSON.stringify(contract, null, 2) +
    "\n" +
    FENCE +
    "\n" +
    END
  );
}

export function parseContractBody(body) {
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body) > 64 * 1024 ||
    body.split(START).length !== 2 ||
    body.split(END).length !== 2
  )
    throw new Error("Invalid incident framing");
  const block = body.split(START)[1].split(END)[0].trim();
  const prefix = FENCE + "json\n";
  if (!block.startsWith(prefix) || !block.endsWith("\n" + FENCE))
    throw new Error("Invalid incident JSON fence");
  return validateContract(
    JSON.parse(block.slice(prefix.length, -FENCE.length).trim()),
  );
}

export function incidentTitle(contract) {
  const lane =
    contract.required_lanes.length === 1
      ? contract.required_lanes[0]
      : "full suite";
  return "fix(ci): restore " + lane + " on main";
}

export function renderBody(contract) {
  const failure = contract.latest_failure;
  const lines = [
    "The full Preflight suite failed on main at " + failure.sha + ".",
    "",
    "Source: " + failure.run_url + ", attempt " + failure.attempt + ".",
    // Main Preflight coalesces bursts, so one run tests every merge since the
    // last green run; the culprit can be any commit in this range.
    failure.last_green_sha
      ? "Commits under test: [" +
        failure.last_green_sha.slice(0, 12) +
        "..." +
        failure.sha.slice(0, 12) +
        "](https://github.com/" +
        REPOSITORY +
        "/compare/" +
        failure.last_green_sha +
        "..." +
        failure.sha +
        "), every merge since the last green main run."
      : "Commits under test: unknown; no earlier green main run is recorded.",
    "Retry: " +
      failure.retry.result +
      "; automatic retries recorded: " +
      failure.retry.used +
      "/1.",
    "",
    "Failed jobs and steps:",
    "",
  ];
  for (const job of failure.failing_jobs) {
    const url = failure.run_url + "/job/" + job.id;
    lines.push(
      "- [" +
        job.name +
        "](" +
        url +
        "): " +
        job.steps.map((step) => step.name).join(", ") +
        ".",
    );
    lines.push(
      "  Reproduce (" +
        job.reproduction.platform +
        ", " +
        job.reproduction.command_id +
        "): " +
        job.reproduction.display_command,
    );
  }
  const suspects = failure.suspected_culprit_prs;
  lines.push(
    "",
    "Suspected PRs (commit association only; confidence unknown): " +
      (suspects.length
        ? suspects
            .map((pr) => "[#" + pr.number + "](" + pr.url + ")")
            .join(", ")
        : "unknown") +
      ".",
  );
  lines.push(
    "Required CI additions: " +
      (contract.required_ci_additions.join(", ") || "none") +
      ".",
  );
  lines.push(
    "",
    "Reproduce at the failing SHA, add a failing regression test, implement the repair, and remove the incident marker together with the real fix. Keep the requested CI labels.",
  );
  lines.push(
    "Diagnostics and raw logs are omitted. Use SECURITY.md for any sensitive finding.",
    "",
    renderJsonBlock(contract),
  );
  const body = lines.join("\n");
  if (Buffer.byteLength(body) > 64 * 1024)
    throw new Error("Incident body exceeds 64 KiB");
  return body;
}

export function renderMarker(contract) {
  validateContract(contract);
  const marker = {
    schema: contract.schema,
    signature: contract.signature,
    signature_version: 1,
    repository: REPOSITORY,
    incident_kind: contract.incident_kind,
    base_branch: "main",
    branch: contract.branch,
    first_failure: contract.first_failure,
    source: {
      sha: contract.latest_failure.sha,
      run_id: contract.latest_failure.run_id,
      attempt: contract.latest_failure.attempt,
    },
    required_lanes: contract.required_lanes,
    required_ci_additions: contract.required_ci_additions,
    controller_evidence: contract.controller_evidence,
  };
  validateSchema(marker, INCIDENT_SCHEMA.$defs.marker);
  const content = JSON.stringify(marker, null, 2) + "\n";
  if (Buffer.byteLength(content) > 4096)
    throw new Error("Incident marker exceeds 4 KiB");
  return content;
}

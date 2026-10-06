#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// scope — deterministic, fail-closed CI lane selection
// ──────────────────────────────────────────────────────────
//
// Path owners and check predicates live in scope-rules.json. The database
// import closure remains owned by control-plane-scope.mjs and its tests.
// Uncertain Git evidence selects every PR lane except full composer smoke;
// only ci:ui-smoke, ci:full or full mode selects that expensive browser suite.
// An invalid policy or an internal error fails instead of emitting skip claims.
//
// Usage: node scripts/ci/scope.mjs --mode pr|full|local
// PR/full stdout is suitable for >> "$GITHUB_OUTPUT". Local prints a table.
// This seed does not change any workflow or required status check.
// ──────────────────────────────────────────────────────────

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import {
  CONTROL_PLANE_DATABASE_INPUTS,
  comparisonBase,
  isControlPlaneDatabaseInput,
} from "./control-plane-scope.mjs";

const DEFAULT_POLICY = new URL("./scope-rules.json", import.meta.url);
const MAX_LEDGER_BYTES = 64 * 1024;
const MODES = ["pr", "full", "local"];
const EVENTS = ["pull_request", "merge_group", "push"];
const STATUSES = { A: "added", M: "modified", D: "removed", T: "type-changed" };
const REQUEST_LANES = Object.freeze({
  "ci:full": null,
  "ci:ui-smoke": ["ui-smoke"],
  "ci:macos": ["macos"],
  "ci:control-plane-db": ["control-plane", "control-plane-db"],
  "ci:packaging": ["packaging"],
  "ci:web": ["web"],
});
export const CI_LABELS = Object.freeze(Object.keys(REQUEST_LANES).sort());

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sortedUnique = (values) => [...new Set(values)].sort();
const validSha = (value) =>
  typeof value === "string" &&
  /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value) &&
  !/^0+$/.test(value)
    ? value.toLowerCase()
    : null;

class DiffEvidenceError extends Error {}
class GitEvidenceError extends Error {}

/** Anchored, case-sensitive POSIX globs, with no expansion or negation. */
export function globToRegExp(glob) {
  if (typeof glob !== "string" || !glob || glob.includes("\0")) {
    throw new Error("Invalid CI policy: glob must be a nonempty string.");
  }
  let pattern = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        pattern += "(?:[^/]+/)*";
        index++;
      } else pattern += "[\\s\\S]*";
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`, "u");
}

export function matchesGlob(file, glob) {
  return globToRegExp(glob).test(file);
}

function policyAssert(condition, message) {
  if (!condition) throw new Error(`Invalid CI policy: ${message}`);
}

function fields(value, required, optional = []) {
  policyAssert(isRecord(value), "expected an object.");
  policyAssert(
    required.every((key) => Object.hasOwn(value, key)),
    `missing a field (${required.join(", ")}).`,
  );
  policyAssert(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    "unrecognized field.",
  );
}

function strings(value, name, { empty = false } = {}) {
  policyAssert(
    Array.isArray(value) && (empty || value.length > 0),
    `${name} must be an array.`,
  );
  policyAssert(
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && !item.includes("\0"),
    ),
    `${name} contains an invalid string.`,
  );
  policyAssert(
    new Set(value).size === value.length,
    `${name} contains duplicates.`,
  );
}

function patterns(value, name) {
  strings(value, name);
  for (const glob of value) globToRegExp(glob);
}

/** Validate the entire registry before making any selection or skip claim. */
export function validatePolicy(policy) {
  fields(policy, [
    "schema_version",
    "max_paths",
    "global_invalidators",
    "documentation",
    "lane_names",
    "path_rules",
    "checks",
  ]);
  policyAssert(
    policy.schema_version === 1,
    "unsupported schema_version; expected 1.",
  );
  policyAssert(policy.max_paths === 300, "max_paths must be 300.");
  strings(policy.lane_names, "lane_names");
  policyAssert(
    policy.lane_names.every((lane) =>
      /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(lane),
    ),
    "lane IDs must be lower-kebab-case.",
  );
  for (const lane of [
    "docs-only",
    "repository-contracts",
    "control-plane",
    "control-plane-db",
    "macos",
    "runtime-bundle",
    "packaging",
    "web",
    "ui-smoke",
  ]) {
    policyAssert(
      policy.lane_names.includes(lane),
      `missing required lane ${lane}.`,
    );
  }
  const lanes = (value) => {
    strings(value, "lanes", { empty: true });
    policyAssert(
      value.every((lane) => policy.lane_names.includes(lane)),
      "predicate references an unknown lane.",
    );
  };
  fields(policy.global_invalidators, ["include"]);
  patterns(policy.global_invalidators.include, "global_invalidators.include");
  fields(policy.documentation, [
    "include",
    "exclude",
    "allowed_paths",
    "allowed_statuses",
  ]);
  patterns(policy.documentation.include, "documentation.include");
  patterns(policy.documentation.exclude, "documentation.exclude");
  strings(policy.documentation.allowed_paths, "documentation.allowed_paths");
  strings(
    policy.documentation.allowed_statuses,
    "documentation.allowed_statuses",
  );
  policyAssert(
    policy.documentation.allowed_statuses.length === 1 &&
      policy.documentation.allowed_statuses[0] === "modified",
    "only audited modified documentation may use docs-only.",
  );
  for (const file of policy.documentation.allowed_paths) {
    policyAssert(
      isRepositoryPath(file),
      "documentation contains an unsafe path.",
    );
    policyAssert(
      policy.documentation.include.some((glob) => matchesGlob(file, glob)) &&
        !policy.documentation.exclude.some((glob) => matchesGlob(file, glob)),
      "documentation allowlist conflicts with its patterns.",
    );
  }
  policyAssert(
    Array.isArray(policy.path_rules) && policy.path_rules.length > 0,
    "path_rules must be a nonempty array.",
  );
  const ruleIds = new Set();
  for (const rule of policy.path_rules) {
    fields(
      rule,
      ["id", "include", "lanes"],
      ["exclude", "statuses", "input_source"],
    );
    policyAssert(
      typeof rule.id === "string" &&
        /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(rule.id) &&
        !ruleIds.has(rule.id),
      "path rule IDs must be unique lower-kebab-case names.",
    );
    ruleIds.add(rule.id);
    patterns(rule.include, `${rule.id}.include`);
    if (rule.exclude) patterns(rule.exclude, `${rule.id}.exclude`);
    if (rule.statuses) {
      strings(rule.statuses, `${rule.id}.statuses`);
      policyAssert(
        rule.statuses.every((status) =>
          Object.values(STATUSES).includes(status),
        ),
        "unknown path-rule status.",
      );
    }
    if (rule.input_source !== undefined)
      policyAssert(
        rule.input_source === "control-plane-database",
        "unknown input_source.",
      );
    lanes(rule.lanes);
    policyAssert(
      rule.lanes.length > 0 && !rule.lanes.includes("ui-smoke"),
      "path rules may not select ui-smoke.",
    );
    policyAssert(
      !rule.lanes.includes("control-plane-db") ||
        rule.input_source === "control-plane-database",
      "control-plane-db must use its imported input source.",
    );
  }
  policyAssert(
    isRecord(policy.checks) && Object.keys(policy.checks).length > 0,
    "checks must be a nonempty object.",
  );
  for (const [id, check] of Object.entries(policy.checks)) {
    policyAssert(
      /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(id),
      "check IDs must be lower-kebab-case.",
    );
    fields(check, ["when", "execution_group", "commands"], ["lane"]);
    fields(check.when, ["always", "full", "any_lanes"]);
    policyAssert(
      typeof check.when.always === "boolean" &&
        typeof check.when.full === "boolean",
      "check predicates must be booleans.",
    );
    lanes(check.when.any_lanes);
    policyAssert(
      typeof check.execution_group === "string" &&
        /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(check.execution_group),
      "invalid execution_group.",
    );
    strings(check.commands, `${id}.commands`, { empty: true });
    policyAssert(
      check.commands.every((command) => !command.includes("check:web-deploy")),
      "live web-deploy probes are excluded from CI selection.",
    );
    if (check.lane !== undefined)
      policyAssert(
        ["macos", "runtime-bundle"].includes(check.lane),
        "only macos and runtime-bundle may be derived check lanes.",
      );
    if (check.commands.some((command) => command.includes("test:ui-smoke"))) {
      policyAssert(
        !check.when.always &&
          !check.when.full &&
          check.when.any_lanes.length === 1 &&
          check.when.any_lanes[0] === "ui-smoke",
        "full composer smoke must require the ui-smoke lane.",
      );
    }
  }
  policyAssert(
    Object.hasOwn(policy.checks, "composer-full"),
    "missing composer-full check.",
  );
  policyAssert(
    policy.checks["composer-full"].commands.includes("pnpm test:ui-smoke"),
    "composer-full must register its command.",
  );
  return policy;
}

function decodeUtf8(bytes) {
  try {
    // Preserve a BOM if it is part of a filename; never replace invalid bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new DiffEvidenceError(
      "unsafe-path-encoding: Git output is not strict UTF-8.",
    );
  }
}

export function loadPolicy(file = DEFAULT_POLICY) {
  let policy;
  try {
    policy = JSON.parse(decodeUtf8(readFileSync(file)));
  } catch {
    throw new Error(
      "Invalid CI policy: cannot read valid UTF-8 JSON; restore scripts/ci/scope-rules.json.",
    );
  }
  return validatePolicy(policy);
}

function isRepositoryPath(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !file.includes("\0") &&
    file.split("/").every((part) => part && part !== "." && part !== "..") &&
    Buffer.from(file, "utf8").toString("utf8") === file
  );
}

function checkPath(file) {
  if (!isRepositoryPath(file))
    throw new DiffEvidenceError(
      "unsafe-path: Git reported an unsafe repository path.",
    );
  return file;
}

function isMove(status) {
  return typeof status === "string" && /^[RC](?:100|[1-9]?\d)$/.test(status);
}

function nulFields(bytes) {
  const text = decodeUtf8(bytes);
  if (!text) return [];
  if (!text.endsWith("\0"))
    throw new DiffEvidenceError(
      "malformed-diff: Git output is not NUL terminated.",
    );
  return text.slice(0, -1).split("\0");
}

/** Parse name-status -z without line splitting, quoting or lossy decoding. */
export function parseNameStatus(bytes) {
  const tokens = nulFields(bytes);
  const changes = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (isMove(status)) {
      const oldPath = checkPath(tokens[index++]);
      const file = checkPath(tokens[index++]);
      changes.push({ path: file, status, oldPath });
    } else if (Object.hasOwn(STATUSES, status)) {
      changes.push({ path: checkPath(tokens[index++]), status });
    } else
      throw new DiffEvidenceError(
        "unknown-status: Git reported an unsupported file status.",
      );
  }
  return changes;
}

function normalizedChanges(changes) {
  if (!Array.isArray(changes))
    throw new TypeError("Changes must be an array or null.");
  const owners = changes.flatMap((change) => {
    if (!isRecord(change))
      throw new DiffEvidenceError(
        "malformed-diff: expected a path and status.",
      );
    const file = checkPath(change.path);
    if (isMove(change.status))
      return [
        {
          path: checkPath(change.oldPath),
          status: change.status.startsWith("R") ? "D" : "M",
        },
        { path: file, status: "A" },
      ];
    if (!Object.hasOwn(STATUSES, change.status))
      throw new DiffEvidenceError(
        "unknown-status: Git reported an unsupported file status.",
      );
    return [{ path: file, status: change.status }];
  });
  return sortedUnique(owners.map((owner) => JSON.stringify(owner))).map(
    (owner) => JSON.parse(owner),
  );
}

/** Ignore ordinary labels, but a misspelled ci:* request must fail visibly. */
export function parseLabels(input = []) {
  let labels = input;
  if (typeof input === "string") {
    try {
      labels = input ? JSON.parse(input) : [];
    } catch {
      throw new Error(
        "LABELS_JSON must be a JSON array of label names or GitHub label objects.",
      );
    }
  }
  if (!Array.isArray(labels))
    throw new Error("LABELS_JSON must be a JSON array of labels.");
  const requests = [];
  for (const label of labels) {
    const name =
      typeof label === "string"
        ? label
        : isRecord(label)
          ? label.name
          : undefined;
    if (typeof name !== "string")
      throw new Error(
        "LABELS_JSON entries must be strings or objects with a string name.",
      );
    if (!name.startsWith("ci:")) continue;
    if (!Object.hasOwn(REQUEST_LANES, name)) {
      throw new Error(
        `Unknown CI label ${JSON.stringify(name)}. Remove it or use: ${CI_LABELS.join(", ")}.`,
      );
    }
    requests.push(name);
  }
  return sortedUnique(requests);
}

const printablePath = (file) =>
  JSON.stringify(file).replace(
    /[<>&`|]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Bound serialized bytes too: control characters expand in JSON strings. */
function boundText(text, maxBytes = 1024) {
  if (typeof text !== "string") throw new TypeError("Reasons must be strings.");
  if (Buffer.byteLength(JSON.stringify(text)) <= maxBytes) return text;
  let result = "";
  let bytes = 2 + Buffer.byteLength("…");
  for (const char of text) {
    const size = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return `${result}…`;
}

function summarizedReasons(reasons, limit = 40) {
  const unique = sortedUnique(reasons);
  // Keep fallback and request evidence even if hundreds of path owners match.
  const routine = (reason) =>
    /^(path-rule|documentation|documentation-layout|check-predicate):/.test(
      reason,
    );
  const ordered = [
    ...unique.filter((reason) => !routine(reason)),
    ...unique.filter(routine),
  ];
  const bounded = ordered.slice(0, limit).map((reason) => boundText(reason));
  if (unique.length > limit)
    bounded.push(
      `additional-reasons: ${unique.length - limit} more reasons omitted.`,
    );
  return sortedUnique(bounded);
}

function checkSelected(check, decision) {
  return (
    check.when.always ||
    (check.when.full && decision.full) ||
    check.when.any_lanes.some((lane) => decision.lanes[lane])
  );
}

export function selectChecks(policy, decision) {
  validatePolicy(policy);
  return Object.keys(policy.checks)
    .filter((id) => checkSelected(policy.checks[id], decision))
    .sort();
}

/** Pure selection: floors are a union; requests can only add lanes. */
export function decideScope({
  policy,
  changes,
  mode = "pr",
  labels = [],
  forceFull = false,
  fallbackReason = null,
}) {
  validatePolicy(policy);
  if (!MODES.includes(mode))
    throw new Error(`Unknown CI mode ${JSON.stringify(mode)}.`);
  if (typeof forceFull !== "boolean")
    throw new TypeError("forceFull must be a boolean.");
  const requests = parseLabels(labels);
  const lanes = Object.fromEntries(
    [...policy.lane_names].sort().map((lane) => [lane, false]),
  );
  const laneReasons = Object.fromEntries(
    Object.keys(lanes).map((lane) => [lane, new Set()]),
  );
  const reasons = new Set();
  let full = false;
  const addLane = (lane, reason) => {
    lanes[lane] = true;
    laneReasons[lane].add(reason);
    reasons.add(reason);
  };
  const allPr = (reason) => {
    full = true;
    for (const lane of Object.keys(lanes))
      if (lane !== "ui-smoke") addLane(lane, reason);
  };
  if (mode === "full") {
    full = true;
    for (const lane of Object.keys(lanes))
      addLane(
        lane,
        "full-mode: main/release selection runs every lane, including ui-smoke.",
      );
  } else if (forceFull)
    allPr("force-full: FORCE_FULL requests every PR lane except ui-smoke.");
  else if (fallbackReason) allPr(fallbackReason);
  else if (changes === null)
    allPr("diff-error: changed paths are unavailable.");
  else {
    let owners;
    try {
      owners = normalizedChanges(changes);
    } catch (error) {
      if (!(error instanceof DiffEvidenceError)) throw error;
      allPr(error.message);
    }
    if (owners) {
      const files = sortedUnique(owners.map((owner) => owner.path));
      if (files.length === 0)
        allPr(
          "empty-diff: no changed paths; select every PR lane except ui-smoke.",
        );
      else if (files.length > policy.max_paths)
        allPr(
          `path-limit: ${files.length} distinct paths exceed ${policy.max_paths}.`,
        );
      else {
        const compile = (globs) => globs.map(globToRegExp);
        const matches = (file, globs) => globs.some((glob) => glob.test(file));
        const invalidators = compile(policy.global_invalidators.include);
        const docInclude = compile(policy.documentation.include);
        const docExclude = compile(policy.documentation.exclude);
        const docAllowlist = new Set(policy.documentation.allowed_paths);
        const rules = policy.path_rules.map((rule) => ({
          ...rule,
          include: compile(rule.include),
          exclude: compile(rule.exclude ?? []),
        }));
        for (const owner of owners) {
          const file = owner.path;
          if (matches(file, invalidators)) {
            allPr(
              `global-invalidator: ${printablePath(file)} affects the shared CI contract.`,
            );
            continue;
          }
          let known = false;
          for (const rule of rules) {
            if (
              !matches(file, rule.include) ||
              matches(file, rule.exclude) ||
              (rule.statuses &&
                !rule.statuses.includes(STATUSES[owner.status])) ||
              (rule.input_source && !isControlPlaneDatabaseInput(file))
            )
              continue;
            known = true;
            const reason = `path-rule: ${rule.id} owns ${printablePath(file)}.`;
            for (const lane of rule.lanes) addLane(lane, reason);
          }
          if (
            docAllowlist.has(file) &&
            matches(file, docInclude) &&
            !matches(file, docExclude)
          ) {
            known = true;
            if (
              policy.documentation.allowed_statuses.includes(
                STATUSES[owner.status],
              )
            ) {
              addLane(
                "docs-only",
                `documentation: audited modification of ${printablePath(file)}.`,
              );
            } else
              addLane(
                "repository-contracts",
                `documentation-layout: addition, deletion or type change of ${printablePath(file)}.`,
              );
          }
          if (!known)
            allPr(
              `unknown-path: ${printablePath(file)} has no audited owner; register it in scripts/ci/scope-rules.json.`,
            );
        }
      }
    }
  }
  for (const request of requests) {
    const reason = `label-request: ${request} adds lanes without removing path floors.`;
    if (request === "ci:full") {
      allPr(reason);
      addLane("ui-smoke", reason);
    } else for (const lane of REQUEST_LANES[request]) addLane(lane, reason);
  }
  // Derived execution lanes use the same predicates as their check registry.
  // Iterate to a fixed point so registry order cannot change the selection.
  let added;
  do {
    added = false;
    for (const id of Object.keys(policy.checks).sort()) {
      const check = policy.checks[id];
      if (
        check.lane &&
        checkSelected(check, { full, lanes }) &&
        !lanes[check.lane]
      ) {
        addLane(check.lane, `check-predicate: ${id} selects ${check.lane}.`);
        added = true;
      }
    }
  } while (added);
  return {
    full,
    lanes,
    requests,
    reasons: summarizedReasons([...reasons]),
    laneReasons: Object.fromEntries(
      Object.keys(lanes).map((lane) => [
        lane,
        summarizedReasons([...laneReasons[lane]], 6),
      ]),
    ),
  };
}

/** Sort object keys recursively; never rely on input insertion order. */
export function canonicalJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (isRecord(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])]),
      );
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return item;
    throw new TypeError(
      "Canonical JSON cannot contain undefined or non-JSON values.",
    );
  };
  return JSON.stringify(canonical(value));
}

export function policyDigest(policy) {
  validatePolicy(policy);
  // Database input changes alter the effective policy even when JSON is stable.
  return createHash("sha256")
    .update(
      canonicalJson({
        rules: policy,
        control_plane_database_inputs: [
          ...CONTROL_PLANE_DATABASE_INPUTS,
        ].sort(),
      }),
    )
    .digest("hex");
}

export function createLedger({
  decision,
  policy,
  event,
  mode,
  baseSha = null,
  sourceSha = null,
  testedSha = null,
}) {
  validatePolicy(policy);
  if (
    !MODES.includes(mode) ||
    typeof event !== "string" ||
    !event ||
    event.length > 100
  )
    throw new TypeError("Invalid ledger event or mode.");
  if (typeof decision.full !== "boolean")
    throw new TypeError("Ledger full must be a boolean.");
  if (
    !isRecord(decision.lanes) ||
    canonicalJson(Object.keys(decision.lanes).sort()) !==
      canonicalJson([...policy.lane_names].sort()) ||
    !Object.values(decision.lanes).every((value) => typeof value === "boolean")
  )
    throw new TypeError(
      "Ledger lanes must contain exactly the registered boolean values.",
    );
  const sha = (value) => {
    if (value === null) return null;
    const valid = validSha(value);
    if (!valid)
      throw new TypeError(
        "Ledger identities must be full commit SHAs or null.",
      );
    return valid;
  };
  const ledger = JSON.parse(
    canonicalJson({
      schema: "zeros.ci-selection/v1",
      event,
      mode,
      base_sha: sha(baseSha),
      source_sha: sha(sourceSha),
      tested_sha: sha(testedSha),
      policy_digest: policyDigest(policy),
      full: decision.full,
      lanes: decision.lanes,
      requests: parseLabels(decision.requests),
      reasons: summarizedReasons(decision.reasons),
    }),
  );
  if (Buffer.byteLength(canonicalJson(ledger)) > MAX_LEDGER_BYTES)
    throw new Error("CI selection ledger exceeds 64 KiB.");
  return ledger;
}

function gitOutput(
  args,
  cwd,
  reason = "diff-error: Git could not provide complete change evidence.",
) {
  try {
    return execFileSync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Git stderr can contain arbitrary repository text. Only report our reason.
    throw new GitEvidenceError(reason);
  }
}

function gitSha(args, cwd, reason) {
  const sha = validSha(decodeUtf8(gitOutput(args, cwd, reason)).trim());
  if (!sha)
    throw new GitEvidenceError(
      "diff-error: Git did not return a full commit SHA.",
    );
  return sha;
}

function assertCompleteHistory(cwd) {
  const shallow = decodeUtf8(
    gitOutput(["rev-parse", "--is-shallow-repository"], cwd),
  ).trim();
  if (shallow === "true")
    throw new GitEvidenceError(
      "shallow-history: fetch complete history before selecting CI lanes.",
    );
  if (shallow !== "false")
    throw new GitEvidenceError(
      "diff-error: Git could not verify complete history.",
    );
}

function assertAncestor(base, head, cwd, identity) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new GitEvidenceError(
      error.status === 1
        ? `${identity}: the ${identity === "non-ancestor-base" ? "base" : "source"} commit is not an ancestor of the tested commit.`
        : "diff-error: Git could not verify commit ancestry.",
    );
  }
}

/** An event diff is useful only after base, source and tested identity agree. */
export function collectPrChanges({ env, cwd } = {}) {
  if (!env) throw new TypeError("Event environment is required.");
  let baseSha = validSha(comparisonBase(env));
  // Event identities describe the source; only Git can confirm the checkout.
  let testedSha = null;
  let sourceSha = validSha(
    env.EVENT_NAME === "pull_request"
      ? env.PULL_REQUEST_HEAD_SHA
      : env.GITHUB_SHA,
  );
  try {
    if (!EVENTS.includes(env.EVENT_NAME))
      throw new GitEvidenceError(
        "unsupported-event: use pr mode for pull_request, merge_group or push; otherwise request full mode.",
      );
    testedSha = gitSha(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
    if (env.GITHUB_SHA && validSha(env.GITHUB_SHA) !== testedSha)
      throw new GitEvidenceError(
        "tested-sha: GITHUB_SHA does not match checked-out HEAD.",
      );
    sourceSha =
      env.EVENT_NAME === "pull_request"
        ? validSha(env.PULL_REQUEST_HEAD_SHA)
        : (sourceSha ?? testedSha);
    if (!sourceSha)
      throw new GitEvidenceError(
        "source-sha: PULL_REQUEST_HEAD_SHA is missing or invalid.",
      );
    if (!baseSha)
      throw new GitEvidenceError(
        "missing-base: the event base is missing, invalid or zero.",
      );
    assertCompleteHistory(cwd);
    gitOutput(
      ["cat-file", "-e", `${baseSha}^{commit}`],
      cwd,
      "missing-base: the base commit is not available; fetch it before selecting CI lanes.",
    );
    gitOutput(
      ["cat-file", "-e", `${sourceSha}^{commit}`],
      cwd,
      "source-sha: the source commit is not available in this checkout.",
    );
    assertAncestor(baseSha, testedSha, cwd, "non-ancestor-base");
    assertAncestor(sourceSha, testedSha, cwd, "source-sha");
    const changes = parseNameStatus(
      gitOutput(
        [
          "diff",
          "--name-status",
          "--no-renames",
          "-z",
          `${baseSha}...HEAD`,
          "--",
        ],
        cwd,
      ),
    );
    return { changes, reason: null, baseSha, sourceSha, testedSha };
  } catch (error) {
    if (
      !(error instanceof GitEvidenceError) &&
      !(error instanceof DiffEvidenceError)
    )
      throw error;
    return {
      changes: null,
      reason: error.message,
      baseSha,
      sourceSha,
      testedSha,
    };
  }
}

/** Preview all local work, including index/worktree changes and untracked files. */
export function collectLocalChanges({ cwd } = {}) {
  let baseSha = null;
  let testedSha = null;
  try {
    testedSha = gitSha(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
    assertCompleteHistory(cwd);
    baseSha = gitSha(
      ["merge-base", "origin/main", "HEAD"],
      cwd,
      "missing-base: cannot find a merge base with origin/main; fetch origin/main before running pnpm ci:plan.",
    );
    const diffArgs = ["--name-status", "--no-renames", "-z"];
    const changes = [
      ...parseNameStatus(
        gitOutput(["diff", ...diffArgs, `${baseSha}...HEAD`, "--"], cwd),
      ),
      ...parseNameStatus(
        gitOutput(["diff", "--cached", ...diffArgs, "HEAD", "--"], cwd),
      ),
      ...parseNameStatus(gitOutput(["diff", ...diffArgs, "--"], cwd)),
      ...nulFields(
        gitOutput(
          ["ls-files", "--others", "--exclude-standard", "-z", "--"],
          cwd,
        ),
      ).map((file) => ({ path: checkPath(file), status: "A" })),
    ];
    return { changes, reason: null, baseSha, sourceSha: testedSha, testedSha };
  } catch (error) {
    if (
      !(error instanceof GitEvidenceError) &&
      !(error instanceof DiffEvidenceError)
    )
      throw error;
    return {
      changes: null,
      reason: error.message,
      baseSha,
      sourceSha: testedSha,
      testedSha,
    };
  }
}

function fullIdentity(env, cwd) {
  let testedSha = null;
  try {
    testedSha = gitSha(["rev-parse", "--verify", "HEAD^{commit}"], cwd);
  } catch (error) {
    if (!(error instanceof GitEvidenceError)) throw error;
  }
  return {
    baseSha: validSha(comparisonBase(env)),
    sourceSha:
      env.EVENT_NAME === "pull_request"
        ? (validSha(env.PULL_REQUEST_HEAD_SHA) ?? testedSha)
        : (validSha(env.GITHUB_SHA) ?? testedSha),
    testedSha,
  };
}

function forceFullValue(value) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new Error(
    "FORCE_FULL must be true, false, 1 or 0; use ci:full to also request ui-smoke.",
  );
}

function parseMode(argv) {
  if (argv.length === 0) return "pr";
  if (argv.length === 2 && argv[0] === "--mode" && MODES.includes(argv[1]))
    return argv[1];
  throw new Error("Usage: node scripts/ci/scope.mjs --mode pr|full|local");
}

export function formatLocalPlan(decision, comparison) {
  const width = Math.max(
    4,
    ...Object.keys(decision.lanes).map((lane) => lane.length),
  );
  const lines = [
    `Base SHA: ${comparison.baseSha ?? "unknown"}`,
    `Tested SHA: ${comparison.testedSha ?? "unknown"}`,
    "",
    `${"Lane".padEnd(width)}  Selected  Reasons`,
    `${"-".repeat(width)}  --------  -------`,
  ];
  for (const [lane, run] of Object.entries(decision.lanes)) {
    const retained = decision.laneReasons[lane].filter(
      (reason) => !reason.startsWith("additional-reasons:"),
    );
    const omitted = decision.laneReasons[lane].find((reason) =>
      reason.startsWith("additional-reasons:"),
    );
    const more =
      retained.length - 1 + (omitted ? Number(/\d+/.exec(omitted)[0]) : 0);
    const reasons = run
      ? `${boundText(retained[0], 200)}${more > 0 ? ` (+${more} more reasons)` : ""}`
      : "No matching path or additive request.";
    lines.push(
      `${lane.padEnd(width)}  ${(run ? "yes" : "no").padEnd(8)}  ${boundText(reasons, 300)}`,
    );
  }
  lines.push(
    "",
    "Request extra lanes with PR labels before the final push:",
    `  ${CI_LABELS.join(", ")}`,
    "Preview labels locally with LABELS_JSON='[\"ci:web\"]' pnpm ci:plan.",
    "Path fallback and FORCE_FULL exclude ui-smoke; ci:full includes it.",
  );
  return `${lines.join("\n")}\n`;
}

function stepSummary(ledger) {
  const lines = [
    "### CI selection",
    "",
    `Mode: ${ledger.mode}. Base: ${ledger.base_sha ?? "unknown"}.`,
    "",
    "| Lane | Selected |",
    "| --- | --- |",
  ];
  for (const [lane, run] of Object.entries(ledger.lanes))
    lines.push(`| ${lane} | ${run} |`);
  lines.push(
    "",
    "Reasons:",
    ...ledger.reasons.map((reason) => `- ${reason}`),
    "",
  );
  return `${lines.join("\n")}\n`;
}

/** Write outputs only after validation, selection and ledger construction succeed. */
export function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  policyPath = DEFAULT_POLICY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    if (argv.length === 1 && argv[0] === "--help") {
      stdout.write(
        "Usage: node scripts/ci/scope.mjs --mode pr|full|local\nPreview: pnpm ci:plan\n",
      );
      return 0;
    }
    const mode = parseMode(argv);
    const policy = loadPolicy(policyPath);
    const labels = parseLabels(env.LABELS_JSON);
    const forceFull = forceFullValue(env.FORCE_FULL);
    const comparison =
      mode === "full"
        ? { ...fullIdentity(env, cwd), changes: null, reason: null }
        : mode === "local"
          ? collectLocalChanges({ cwd })
          : collectPrChanges({ env, cwd });
    const decision = decideScope({
      policy,
      changes: comparison.changes,
      mode,
      labels,
      forceFull,
      fallbackReason: comparison.reason,
    });
    const ledger = createLedger({
      decision,
      policy,
      event: mode === "local" ? "local" : env.EVENT_NAME || "unknown",
      mode,
      ...comparison,
    });
    if (env.GITHUB_STEP_SUMMARY)
      appendFileSync(env.GITHUB_STEP_SUMMARY, stepSummary(ledger));
    for (const reason of ledger.reasons) stderr.write(`${reason}\n`);
    stdout.write(
      mode === "local"
        ? formatLocalPlan(decision, comparison)
        : `ledger=${canonicalJson(ledger)}\n${Object.entries(ledger.lanes)
            .map(([lane, run]) => `${lane}=${run}\n`)
            .join("")}`,
    );
    return 0;
  } catch (error) {
    stderr.write(
      `CI selection failed: ${boundText(error.message ?? "internal error")}\n`,
    );
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runCli();
}

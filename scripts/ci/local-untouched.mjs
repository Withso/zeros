#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// local-untouched — cloud-program pull requests must not touch Local-only
// files without owner sign-off, and must keep the Local test lanes selected
// when they cross a shared seam.
//
// The seam classes live in docs/cloud-workspace/local-seams.json so a cloud
// slice can extend them without a CI-definition change. A pull request is a
// cloud-program PR when its diff touches `cloud_paths`; only then do the
// `local_only` and `shared_seams` rules apply. Local-only edits need the
// `sign_off_label` on the PR; shared-seam edits need every required lane
// selected by the trusted path classifier.
//
// Usage: node scripts/ci/local-untouched.mjs [--mode pr|local]
// pr mode reads the pull_request environment (PULL_REQUEST_BASE_SHA,
// PULL_REQUEST_HEAD_SHA, GITHUB_SHA, LABELS_JSON); local mode previews
// committed, staged, unstaged and untracked work against origin/main.
// Evidence failures fail closed.
// ──────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  collectLocalChanges,
  collectPrChanges,
  decideScope,
  loadPolicy,
  matchesGlob,
} from "./scope.mjs";

const DEFAULT_MANIFEST = new URL(
  "../../docs/cloud-workspace/local-seams.json",
  import.meta.url,
);

function fail(message) {
  throw new Error(`Invalid local-seams manifest: ${message}`);
}

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function globList(value, name) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (glob) =>
        typeof glob !== "string" || !glob || glob.includes("\0") ||
        glob.startsWith("/") || glob.split("/").includes(".."),
    )
  )
    fail(`${name} must be a non-empty array of repository-relative globs.`);
}

function globRule(value, name, { extra = [] } = {}) {
  if (!isRecord(value)) fail(`${name} entries must be objects.`);
  const keys = ["include", "exclude", ...extra];
  if (
    !Object.hasOwn(value, "include") ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail(`${name} entries have include and optional exclude only.`);
  globList(value.include, `${name}.include`);
  if (value.exclude !== undefined) globList(value.exclude, `${name}.exclude`);
}

export function validateLocalSeamsManifest(manifest) {
  if (!isRecord(manifest)) fail("expected an object.");
  const required = [
    "schema",
    "sign_off_label",
    "cloud_paths",
    "local_only",
    "shared_seams",
  ];
  for (const key of required)
    if (!Object.hasOwn(manifest, key)) fail(`missing ${key}.`);
  if (Object.keys(manifest).some((key) => !required.includes(key)))
    fail("unrecognized field.");
  if (manifest.schema !== "zeros.local-seams/v1")
    fail('schema must be "zeros.local-seams/v1".');
  if (
    typeof manifest.sign_off_label !== "string" ||
    !/^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(manifest.sign_off_label)
  )
    fail("sign_off_label must be a lower-kebab-case label name.");
  globList(manifest.cloud_paths, "cloud_paths");
  if (!Array.isArray(manifest.local_only) || manifest.local_only.length === 0)
    fail("local_only must be a non-empty array.");
  manifest.local_only.forEach((entry, index) =>
    globRule(entry, `local_only[${index}]`),
  );
  if (!Array.isArray(manifest.shared_seams))
    fail("shared_seams must be an array.");
  const ids = new Set();
  manifest.shared_seams.forEach((entry, index) => {
    globRule(entry, `shared_seams[${index}]`, {
      extra: ["id", "requires_lanes"],
    });
    if (
      typeof entry.id !== "string" ||
      !/^[a-z][a-z\d]*(?:-[a-z\d]+)*$/.test(entry.id)
    )
      fail(`shared_seams[${index}].id must be lower-kebab-case.`);
    if (ids.has(entry.id)) fail(`duplicate shared_seams id ${entry.id}.`);
    ids.add(entry.id);
    globList(
      entry.requires_lanes,
      `shared_seams[${index}].requires_lanes`,
    );
  });
  return manifest;
}

export function loadLocalSeamsManifest(file = DEFAULT_MANIFEST) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`The local-seams manifest is unreadable: ${error.message}`);
  }
  return validateLocalSeamsManifest(parsed);
}

function ruleHits(file, rules) {
  return rules.filter(
    (rule) =>
      rule.include.some((glob) => matchesGlob(file, glob)) &&
      !(rule.exclude ?? []).some((glob) => matchesGlob(file, glob)),
  );
}

const changePaths = (changes) =>
  [...new Set(changes.flatMap((change) => [change.path, change.oldPath]))]
    .filter(Boolean)
    .sort();

/**
 * Pure evaluation: which Local-seam rules does this change set break?
 * Returns hits separately from problems so callers can report sign-off
 * coverage without re-running the classification.
 */
export function evaluateLocalSeams({
  manifest,
  changes,
  labels = [],
  selectedLanes = [],
}) {
  validateLocalSeamsManifest(manifest);
  if (!Array.isArray(changes))
    throw new TypeError("changes must be an array of name-status records.");
  const paths = changePaths(changes);
  const cloud = paths.some((file) =>
    manifest.cloud_paths.some((glob) => matchesGlob(file, glob)),
  );
  const result = {
    cloud,
    localOnlyHits: [],
    sharedSeamHits: [],
    problems: [],
  };
  if (!cloud) return result;
  const signedOff = labels.includes(manifest.sign_off_label);
  result.localOnlyHits = paths.filter((file) =>
    ruleHits(file, manifest.local_only).length > 0,
  );
  if (result.localOnlyHits.length > 0 && !signedOff)
    for (const file of result.localOnlyHits)
      result.problems.push(
        `${file} is Local-only; a cloud-program change needs the ` +
          `${manifest.sign_off_label} label (owner sign-off) to touch it.`,
      );
  const lanes = new Set(selectedLanes);
  for (const seam of manifest.shared_seams) {
    const files = paths.filter((file) => ruleHits(file, [seam]).length > 0);
    if (files.length === 0) continue;
    const missing = seam.requires_lanes.filter((lane) => !lanes.has(lane));
    result.sharedSeamHits.push({ id: seam.id, files, missing });
    if (missing.length > 0)
      result.problems.push(
        `${files.join(", ")} cross the ${seam.id} shared seam; the Local ` +
          `test lanes must stay selected (missing: ${missing.join(", ")}).`,
      );
  }
  return result;
}

export function formatLocalSeamsReport({ manifest, result, laneSource }) {
  const lines = [];
  if (!result.cloud) {
    lines.push("local-untouched: not a cloud-program change; no seam rules apply.");
    return lines;
  }
  if (result.localOnlyHits.length > 0)
    lines.push(
      `Local-only files touched: ${result.localOnlyHits.join(", ")} ` +
        `(sign-off label: ${manifest.sign_off_label}).`,
    );
  for (const hit of result.sharedSeamHits)
    lines.push(
      `Shared seam ${hit.id}: ${hit.files.join(", ")}` +
        (hit.missing.length > 0
          ? ` — missing lanes ${hit.missing.join(", ")} (${laneSource}).`
          : " — required Local lanes selected."),
    );
  lines.push(
    result.problems.length === 0
      ? "local-untouched: all Local seam rules satisfied."
      : `local-untouched: ${result.problems.length} problem(s).`,
  );
  return lines;
}

function parseLabelNames(input) {
  if (!input) return [];
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("LABELS_JSON must be a JSON array of label names.");
  }
  if (!Array.isArray(parsed))
    throw new Error("LABELS_JSON must be a JSON array of label names.");
  return parsed.map((label) => {
    if (typeof label === "string") return label;
    if (isRecord(label) && typeof label.name === "string") return label.name;
    throw new Error("LABELS_JSON entries must be strings or label objects.");
  });
}

function parseMode(argv) {
  if (argv.length === 0) return "pr";
  if (argv.length === 2 && argv[0] === "--mode" && ["pr", "local"].includes(argv[1]))
    return argv[1];
  throw new Error(
    "Usage: node scripts/ci/local-untouched.mjs [--mode pr|local]",
  );
}

export function runLocalUntouched({ argv = [], env = process.env, cwd } = {}) {
  const mode = parseMode(argv);
  const manifest = loadLocalSeamsManifest();
  const collected =
    mode === "local" ? collectLocalChanges({ cwd }) : collectPrChanges({ env, cwd });
  if (collected.changes === null)
    throw new Error(
      `local-untouched cannot prove the changed paths (${collected.reason}); failing closed.`,
    );
  const labels = mode === "local" ? [] : parseLabelNames(env.LABELS_JSON);
  // The lane floor comes from the same trusted policy CI uses, so a policy
  // regression that drops a Local lane from a shared seam is caught here.
  const decision = decideScope({
    policy: loadPolicy(),
    changes: collected.changes,
    mode: "pr",
    labels,
  });
  const selectedLanes = Object.keys(decision.lanes).filter(
    (lane) => decision.lanes[lane],
  );
  const result = evaluateLocalSeams({
    manifest,
    changes: collected.changes,
    labels,
    selectedLanes,
  });
  const lines = formatLocalSeamsReport({
    manifest,
    result,
    laneSource: "scripts/ci/scope-rules.json",
  });
  for (const line of lines) console.log(line);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`::error::${problem}`);
    process.exitCode = 1;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runLocalUntouched({ argv: process.argv.slice(2) });

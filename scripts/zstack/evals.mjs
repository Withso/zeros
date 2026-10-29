// ============================================================
// zstack/evals.mjs
// ------------------------------------------------------------
// Validates and lists agents/zstack/evals/cases.json.
//
//   node scripts/zstack/evals.mjs --validate   exit 1 on any invalid case
//   node scripts/zstack/evals.mjs --validate --allow-pending
//                                               also accept fixedBy "pending" (unopened PR)
//   node scripts/zstack/evals.mjs --list       one line per case
// ============================================================
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ZSTACK_EVALS_FILE = "agents/zstack/evals/cases.json";
/** One case per file, so parallel PRs never edit the same file. */
export const ZSTACK_EVAL_CASES_DIR = "agents/zstack/evals/cases";
const KINDS = new Set(["replay", "seeded", "scenario"]);
// RULES.md §2 owns the boundaries; evals/README.md maps these stable subsystem names to them.
export const EVAL_AREAS = Object.freeze([
  "desktop-native", "desktop-engine", "desktop-agents", "desktop-git", "desktop-design",
  "renderer-state", "renderer-ui", "renderer-agents", "renderer-settings",
  "control-plane", "control-plane-data", "control-plane-workers", "cloud-worker",
  "web", "marketing", "protocol", "logo-particles", "catalogs", "styles", "third-party", "docs",
  "scripts", "scripts-ci", "scripts-release", "scripts-dev", "zstack",
]);
const AREAS = new Set(EVAL_AREAS);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIXED_BY = /^(?:[0-9a-f]{40}|pr:[1-9][0-9]*)$/;

export function validateEvalCases(value, { allowPending = false } = {}) {
  const problems = [];
  if (value?.schema !== "zeros.zstack-evals/v1") problems.push("schema must be zeros.zstack-evals/v1");
  if (!Array.isArray(value?.cases) || value.cases.length === 0) return [...problems, "cases must be a non-empty array"];
  const seen = new Set();
  value.cases.forEach((entry, index) => {
    const at = `cases[${index}]${typeof entry?.id === "string" ? ` (${entry.id})` : ""}`;
    if (!ID.test(entry?.id ?? "")) problems.push(`${at}: id must be kebab-case`);
    else if (seen.has(entry.id)) problems.push(`${at}: duplicate id`);
    else seen.add(entry.id);
    if (!KINDS.has(entry?.kind)) problems.push(`${at}: kind must be replay, seeded or scenario`);
    // "pending" lets a subagent add a case before the integrator opens its PR.
    // CI validates strictly, so a placeholder can never reach main.
    if (!(FIXED_BY.test(entry?.fixedBy ?? "") || allowPending && entry?.fixedBy === "pending"))
      problems.push(`${at}: fixedBy must be a full commit SHA or pr:<number>${allowPending ? " or pending" : ""}`);
    for (const field of ["area", "symptom", "rule", "check"]) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) problems.push(`${at}: ${field} is required`);
    }
    if (typeof entry?.area === "string" && entry.area.trim() && !AREAS.has(entry.area))
      problems.push(`${at}: area must be one of ${EVAL_AREAS.join(", ")}`);
    const extra = Object.keys(entry ?? {}).filter((key) => !["id", "kind", "area", "fixedBy", "symptom", "rule", "check"].includes(key));
    if (extra.length) problems.push(`${at}: unknown fields ${extra.join(", ")}`);
  });
  return problems;
}

export function readEvalCases(root) {
  const legacy = JSON.parse(readFileSync(join(root, ZSTACK_EVALS_FILE), "utf8"));
  const dir = join(root, ZSTACK_EVAL_CASES_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : [];
  const cases = [...legacy.cases];
  for (const name of files) {
    const entry = JSON.parse(readFileSync(join(dir, name), "utf8"));
    // The file name is the case id, which keeps one-case-per-file honest.
    cases.push(entry?.id === name.slice(0, -5) ? entry : { ...entry, id: `file-name-mismatch:${name}` });
  }
  return { ...legacy, cases };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const value = readEvalCases(process.cwd());
  if (process.argv.includes("--list")) {
    for (const entry of value.cases) console.log(`${entry.id}\t${entry.kind}\t${entry.area}\t${entry.fixedBy.slice(0, 12)}`);
  }
  const problems = validateEvalCases(value, { allowPending: process.argv.includes("--allow-pending") });
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  if (!process.argv.includes("--list")) console.log(`${value.cases.length} zstack eval cases valid`);
}

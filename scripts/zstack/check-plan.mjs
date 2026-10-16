// Local recipes complement the CI registry; they never execute its prose.
import path from "node:path";
import { decideScope, selectChecks, policyDigest } from "../ci/scope.mjs";

const issued = new WeakSet();
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const testFile = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const sourceFile = /\.[cm]?[jt]sx?$/;
const staticScripts = new Set([
  "check:actions", "check:preload", "check:migrations", "check:control-plane-migrations",
  "check:migration-phases", "check:protocol", "check:licenses", "check:audit", "check:vite-env",
  "check:electron-hardening", "check:packaging-paths", "check:deep-link-schemes",
  "check:codex-pin", "check:codex-coverage", "check:runtime-pins", "check:runtime-skew",
]);

export function repositoryPath(file) {
  return typeof file === "string" && file.length <= 1024 && /^[a-zA-Z0-9_.][a-zA-Z0-9_./@-]*$/.test(file) &&
    file.split("/").every(part => part && part !== "." && part !== ".." && (!part.startsWith(".env") || part.endsWith(".example"))) &&
    !/^(?:\.git|\.context|node_modules)(?:\/|$)/.test(file) && !file.includes("/node_modules/");
}

export function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function adjacent(file, files) {
  if (testFile.test(file)) return files.has(file) ? [file] : [];
  const stem = file.replace(sourceFile, ""), dir = path.posix.dirname(stem), name = path.posix.basename(stem);
  const scriptName = file.startsWith("scripts/") ? stem.slice(8).replaceAll("/", "-") : null;
  return [...files].filter(candidate => testFile.test(candidate) && [stem, `${dir}/__tests__/${name}`,
    ...(scriptName ? [`scripts/__tests__/${scriptName}`, `scripts/__tests__/${name}`] : [])]
    .some(prefix => candidate.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "") === prefix));
}

export function planVerification({ policy, evidence, files, tests = [], platform = process.platform, labels = [] }) {
  const blocked = [], available = new Set(files.filter(repositoryPath));
  if (tests.length > 256 || tests.some(file => !repositoryPath(file) || !testFile.test(file) || !available.has(file)))
    throw new Error("zstack_test_invalid");
  if (!evidence?.complete) blocked.push("diff_incomplete");
  if (!sha.test(evidence?.baseSha ?? "") || !sha.test(evidence?.sourceSha ?? "") ||
    !/^[a-f0-9]{64}$/.test(evidence?.fingerprint ?? "")) blocked.push("identity_unavailable");
  const scope = decideScope({ policy, changes: evidence?.complete ? evidence.changes : null, labels });
  const paths = [...new Set((evidence?.changes ?? []).flatMap(change => [change.path, change.oldPath].filter(Boolean)))].sort();
  if (paths.some(file => !repositoryPath(file))) blocked.push("path_invalid");
  const suites = new Set(tests);
  for (const file of paths.filter(file => sourceFile.test(file))) {
    const matches = adjacent(file, available);
    matches.forEach(match => suites.add(match));
    if (!matches.length && !tests.length) blocked.push("adjacent_tests_required");
  }
  const local = [], commandKeys = new Set();
  const add = (id, argv, kind = "check") => {
    const key = JSON.stringify(argv);
    if (!commandKeys.has(key)) { local.push({ id, argv, kind }); commandKeys.add(key); }
  };
  const rootTests = [...suites].filter(file => !file.startsWith("apps/control-plane/")).sort();
  const cpTests = [...suites].filter(file => file.startsWith("apps/control-plane/")).sort();
  if (rootTests.length) add("adjacent-root", ["pnpm", "test:git", ...rootTests], "vitest");
  if (cpTests.length) add("adjacent-control-plane", ["pnpm", "--dir", "apps/control-plane", "exec", "vitest", "run",
    ...cpTests.map(file => file.slice("apps/control-plane/".length))], "vitest");
  for (const script of ["typecheck", "lint", "check:ui", "check:secrets"]) add(script.replace(":", "-"), ["pnpm", script]);
  const lint = paths.filter(file => sourceFile.test(file) && available.has(file));
  if (lint.length) add("changed-lint", ["pnpm", "exec", "eslint", ...lint]);
  if (scope.lanes["control-plane"]) add("control-plane-types", ["pnpm", "--dir", "apps/control-plane", "typecheck"]);
  if (paths.some(file => file.startsWith(".github/workflows/"))) add("actions", ["pnpm", "check:actions"]);
  const ci = selectChecks(policy, scope).map(id => {
    const check = policy.checks[id];
    const reason = check.lane === "macos" && platform !== "darwin" ? "requires_macos" : "ci_required";
    if (reason !== "requires_macos") for (const command of check.commands) {
      const match = /^pnpm (check:[a-z-]+)$/.exec(command);
      if (match && staticScripts.has(match[1])) add(match[1].replace(":", "-"), ["pnpm", match[1]]);
      if (command === "pnpm smoke:engine" && platform === "darwin") add("engine-smoke", ["pnpm", "smoke:engine"]);
    }
    return { id, commands: [...check.commands], reason };
  });
  if (paths.some(file => file.startsWith("agents/zstack/") || file.startsWith("scripts/zstack/")))
    add("zstack-evals", ["node", "scripts/zstack/evals.mjs", "--validate"]);
  const plan = freeze({ schema: "zeros.zstack-plan/v1", identity: { baseSha: evidence?.baseSha ?? null,
    sourceSha: evidence?.sourceSha ?? null, fingerprint: evidence?.fingerprint ?? null, policySha256: policyDigest(policy) },
  platform, scope, paths, local, ci, blocked: [...new Set(blocked)].sort() });
  issued.add(plan);
  return plan;
}

export function assertExecutablePlan(plan) {
  if (!issued.has(plan)) throw new Error("zstack_plan_invalid");
  if (plan.blocked.length) throw new Error("zstack_plan_blocked");
}

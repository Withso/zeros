#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEvalCases, validateEvalCases } from "./evals.mjs";
import { runCli as replayCli } from "./eval-replay.mjs";
import { fingerprintFiles, gitRead, sourceBytes } from "./source.mjs";
import { writeReceipt } from "./runner.mjs";

const MAX_CASES = 2048;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNKNOWN_CODES = new Set([
  "explicit_scenario_required", "seed_definition_required", "fixed_failed", "assertions_changed",
  "test_report_invalid", "test_environment_failed", "spawn_failed", "deadline", "output_limit", "cancelled",
  "zstack_check_unsupported", "zstack_revision_unavailable", "zstack_revision_ambiguous",
  "zstack_dependencies_unavailable", "zstack_dependency_cache_unsafe", "zstack_dependency_cache_busy",
  "zstack_dependency_cache_limit", "zstack_git_unavailable", "zstack_projection_invalid",
  "zstack_projection_unsupported", "zstack_source_limit", "zstack_source_unsafe",
  "zstack_seed_invalid", "zstack_seed_not_applicable", "zstack_replay_failed",
]);
const FAILURES = new Set(["zstack_corpus_invalid", "zstack_corpus_batch_invalid", "zstack_corpus_receipt_missing",
  "zstack_corpus_output_exists", "zstack_receipt_unsafe", "source_changed", "cancelled", "deadline"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw new Error(code); };
const failureCode = error => FAILURES.has(error?.message) ? error.message : "zstack_corpus_failed";
const validSize = size => Number.isSafeInteger(size) && size > 0 && size <= 32;
const sourceSignature = data => hash(JSON.stringify([data.inputs, data.toolSha256]));

export const HELP = `node scripts/zstack/eval-corpus.mjs [--execute --output DIRECTORY]
  [--baseline agents/zstack/evals/baseline.json] [--revision FULL_SHA]
  [--batch-size 1..32] [--timeout-minutes 1..180] [--dependency-cache DIRECTORY]
  [--mode single-session|master-subagents|co-masters --agent MODEL --master MODEL]
Default is an offline plan of the entire corpus. Execution creates a new evidence
directory with every batch, progress checkpoint and a final receipt. Existing
attempts are never overwritten. Known gaps remain in the catch-rate denominator;
the rate floor compares the baseline case set. New cases are reported separately,
and dropped/changed recipes or lost baseline catches fail the gate.`;

export function splitCorpus(cases, size = 32) {
  if (!validSize(size) || !Array.isArray(cases) || !cases.length || cases.length > MAX_CASES ||
    cases.some(row => !ID.test(row?.id ?? "")) || new Set(cases.map(row => row.id)).size !== cases.length)
    fail("zstack_corpus_invalid");
  const sorted = [...cases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), batches = [];
  for (let offset = 0; offset < sorted.length; offset += size) batches.push(sorted.slice(offset, offset + size));
  return batches;
}

export async function loadCorpus(cwd) {
  const value = readEvalCases(cwd);
  if (validateEvalCases(value).length) fail("zstack_corpus_invalid");
  const cases = splitCorpus(value.cases).flat(), inputs = [];
  for (const entry of cases) {
    let mutationSha256 = null;
    if (entry.kind === "seeded") {
      const source = await sourceBytes(cwd, `agents/zstack/evals/seeds/${entry.id}.json`);
      if (source) {
        if (source.mode === 0o120000 || source.bytes.length > 64 * 1024) fail("zstack_corpus_invalid");
        mutationSha256 = hash(JSON.stringify(JSON.parse(source.bytes.toString("utf8"))));
      }
    }
    inputs.push({ id: entry.id, kind: entry.kind, fixedBy: entry.fixedBy, checkSha256: hash(entry.check), mutationSha256 });
  }
  const toolSha256 = await fingerprintFiles(cwd,
    ["eval-corpus", "eval-replay", "evals", "replay", "source", "runner", "check-plan"].map(name => `scripts/zstack/${name}.mjs`));
  const changelog = await sourceBytes(cwd, "agents/zstack/CHANGELOG.md");
  const packVersion = changelog?.bytes.toString("utf8").match(/^##\s+(?:\[)?(\d+\.\d+\.\d+)/m)?.[1] ?? "unknown";
  return { value: { ...value, cases }, inputs, toolSha256, packVersion };
}

export function summarizeCases(cases, selected = cases.length) {
  const count = status => cases.filter(row => row.status === status).length;
  return { selected, executed: cases.length, caught: count("caught"), missed: count("missed"), unverified: count("unverified"),
    notRun: selected - cases.length, catchRate: selected ? count("caught") / selected : 0 };
}

function validResult(row) {
  return row?.status === "caught" ? row.code === "regression_detected"
    : row?.status === "missed" ? row.code === "parent_passed"
      : row?.status === "unverified" && UNKNOWN_CODES.has(row.code);
}

function validRows(cases) {
  return Array.isArray(cases) && cases.length > 0 && cases.length <= MAX_CASES &&
    new Set(cases.map(row => row?.id)).size === cases.length && cases.every(row =>
      ID.test(row?.id ?? "") && ["replay", "seeded", "scenario"].includes(row.kind) &&
      /^(?:[a-f0-9]{40}|pr:[1-9][0-9]*)$/.test(row.fixedBy ?? "") && HASH.test(row.checkSha256 ?? "") &&
      (row.mutationSha256 === null || HASH.test(row.mutationSha256 ?? "")) &&
      (row.fixed === null || SHA.test(row.fixed ?? "")) && (row.parent === null || SHA.test(row.parent ?? "")) &&
      validResult(row) && (row.status === "unverified" || SHA.test(row.fixed ?? "") && SHA.test(row.parent ?? "")));
}

function sameSummary(summary, cases) {
  return Object.entries(summarizeCases(cases)).every(([key, value]) => summary?.[key] === value);
}

export function compareCorpusBaseline(before, after) {
  const invalid = { allowed: false, code: "zstack_corpus_invalid", regressions: [], caughtDelta: null, rateDelta: null,
    covered: null, newCases: [] };
  if (before?.schema !== "zeros.zstack-eval-baseline/v1" || after?.schema !== "zeros.zstack-corpus-receipt/v1" ||
    after.complete !== true || !validRows(before.cases) || !validRows(after.cases) ||
    !sameSummary(before.summary, before.cases) || !sameSummary(after.summary, after.cases) ||
    !Array.isArray(after.planned) || new Set(after.planned).size !== after.planned.length ||
    after.planned.length !== after.cases.length || after.cases.some(row => !after.planned.includes(row.id))) return invalid;
  const next = new Map(after.cases.map(row => [row.id, row])), regressions = [];
  for (const row of before.cases) {
    const candidate = next.get(row.id);
    const reason = !candidate ? "dropped"
      : ["kind", "fixedBy", "checkSha256", "mutationSha256"].some(key => row[key] !== candidate[key]) ? "input_changed"
        : row.kind === "replay" && ["fixed", "parent"].some(key => row[key] !== null && row[key] !== candidate[key]) ? "resolution_changed"
          : row.status === "caught" && candidate.status !== "caught" ? "catch_lost" : null;
    if (reason) regressions.push({ id: row.id, reason });
  }
  const baselineIds = new Set(before.cases.map(row => row.id));
  const covered = summarizeCases(after.cases.filter(row => baselineIds.has(row.id)), before.cases.length);
  const newCases = after.cases.filter(row => !baselineIds.has(row.id))
    .map(({ id, kind, status, code }) => ({ id, kind, status, code }));
  const caughtDelta = covered.caught - before.summary.caught;
  const rateDelta = covered.catchRate - before.summary.catchRate;
  const allowed = !regressions.length && caughtDelta >= 0;
  return { allowed, code: allowed ? "ok" : "zstack_corpus_regression", regressions, caughtDelta, rateDelta, covered, newCases };
}

function compactBatch(receipt, batch, inputs) {
  if (receipt?.schema !== "zeros.zstack-eval-receipt/v1" || !Array.isArray(receipt.cases) || receipt.cases.length !== batch.length ||
    new Set(receipt.cases.map(row => row?.id)).size !== batch.length) fail("zstack_corpus_batch_invalid");
  const expected = new Map(batch.map(row => [row.id, inputs.get(row.id)]));
  const cases = receipt.cases.map(row => {
    const input = expected.get(row?.id);
    if (!input || !validResult(row)) fail("zstack_corpus_batch_invalid");
    const minimal = row.status === "unverified" && (row.code === "cancelled" || row.code === "seed_definition_required" && input.kind === "seeded" && input.mutationSha256 === null);
    if (!minimal && (row.kind !== input.kind || row.checkSha256 !== input.checkSha256 ||
      (row.mutationSha256 ?? null) !== input.mutationSha256)) fail("zstack_corpus_batch_invalid");
    return { ...input, status: row.status, code: row.code, fixed: row.fixed ?? null, parent: row.parent ?? null };
  });
  const counts = summarizeCases(cases);
  if (!validRows(cases) || ["selected", "caught", "missed", "unverified"].some(key => receipt.summary?.[key] !== counts[key]))
    fail("zstack_corpus_batch_invalid");
  return cases.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export async function runCorpus({ cwd = process.cwd(), execute = false, outputDir, revision,
  baseline, batchSize = 32, timeoutMs = 150 * 60_000, dependencyCache,
  mode = "single-session", agent = "unspecified", master = null },
{ load = loadCorpus, runBatch = replayCli, save = writeReceipt, signal, emit = () => {} } = {}) {
  if (!validSize(batchSize) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180 * 60_000 ||
    !["single-session", "master-subagents", "co-masters"].includes(mode) || typeof agent !== "string" || !agent || agent.length > 100 ||
    master !== null && (typeof master !== "string" || !master || master.length > 100) ||
    mode !== "single-session" && (!master || agent === "unspecified")) fail("zstack_corpus_invalid");
  const data = await load(cwd), batches = splitCorpus(data.value.cases, batchSize);
  const inputs = new Map(data.inputs.map(row => [row.id, row]));
  const planned = batches.flat().map(row => row.id), signature = sourceSignature(data);
  const fingerprint = hash(JSON.stringify(data.inputs));
  const plan = { schema: "zeros.zstack-corpus-plan/v1", execute, revision: revision ?? null, mode, agent, master,
    toolSha256: data.toolSha256 ?? null, packVersion: data.packVersion ?? "unknown",
    inputsSha256: fingerprint, selected: planned.length, batchSize, batches: batches.map(batch => batch.map(row => row.id)) };
  if (!execute) return plan;
  if (!SHA.test(revision ?? "") || !outputDir || baseline?.schema !== "zeros.zstack-eval-baseline/v1" ||
    !validRows(baseline.cases) || !sameSummary(baseline.summary, baseline.cases)) fail("zstack_corpus_invalid");
  outputDir = path.resolve(cwd, outputDir);
  try { await mkdir(outputDir, { mode: 0o700 }); }
  catch (error) { fail(error.code === "EEXIST" ? "zstack_corpus_output_exists" : "zstack_receipt_unsafe"); }
  await save(path.join(outputDir, "plan.json"), plan);
  const startedAt = new Date().toISOString(), cases = [], evidence = [];
  const controller = new AbortController(); let timedOut = false, code = "ok";
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const active = signal ? globalThis.AbortSignal.any([signal, controller.signal]) : controller.signal;
  const snapshot = complete => ({ schema: "zeros.zstack-corpus-receipt/v1", mode, agent, master, revision,
    toolSha256: data.toolSha256 ?? null, packVersion: data.packVersion ?? "unknown",
    inputsSha256: fingerprint, baselineSha256: hash(JSON.stringify(baseline)), startedAt, completedAt: new Date().toISOString(),
    complete, planned, cases: [...cases], summary: summarizeCases(cases, planned.length), evidence: [...evidence],
    codes: Object.fromEntries([...new Set(cases.map(row => row.code))].sort().map(code => [code, cases.filter(row => row.code === code).length])),
    remaining: planned.filter(id => !cases.some(row => row.id === id)) });
  try {
    for (let index = 0; index < batches.length; index++) {
      if (active.aborted) break;
      if (sourceSignature(await load(cwd)) !== signature) fail("source_changed");
      const number = String(index + 1).padStart(3, "0"), name = `batch-${number}.json`, target = path.join(outputDir, name);
      let received = null, calls = 0, receiptError = null;
      const argv = batches[index].flatMap(row => ["--case", row.id]);
      argv.push("--execute", "--receipt", target, "--revision", revision, "--mode", mode, "--agent", agent);
      if (master) argv.push("--master", master);
      if (dependencyCache) argv.push("--dependency-cache", path.resolve(cwd, dependencyCache));
      const exitCode = await runBatch(argv, { cwd, signal: active, read: () => data.value, write: () => {},
        receipt: async (file, value) => {
          try {
            if (++calls !== 1 || file !== target) fail("zstack_corpus_batch_invalid");
            const rows = compactBatch(value, batches[index], inputs);
            await save(target, value); received = rows;
          } catch (error) { receiptError = error; throw error; }
        } });
      if (receiptError) throw receiptError;
      if (!received) fail("zstack_corpus_receipt_missing");
      if (exitCode !== (received.every(row => row.status === "caught") ? 0 : 1)) fail("zstack_corpus_batch_invalid");
      cases.push(...received); evidence.push(name);
      const progress = { ...snapshot(false), status: "running", code: "running" };
      await save(path.join(outputDir, `progress-${number}.json`), progress);
      emit({ schema: "zeros.zstack-corpus-progress/v1", batch: index + 1, batches: batches.length, summary: progress.summary });
    }
    if (active.aborted) code = timedOut ? "deadline" : "cancelled";
    else if (sourceSignature(await load(cwd)) !== signature) code = "source_changed";
  } catch (error) { code = failureCode(error); }
  finally { clearTimeout(timeout); }
  const receipt = snapshot(code === "ok" && cases.length === planned.length);
  receipt.comparison = receipt.complete ? compareCorpusBaseline(baseline, receipt) : null;
  if (code === "ok" && !receipt.comparison?.allowed) code = receipt.comparison?.code ?? "zstack_corpus_failed";
  receipt.status = code === "ok" ? "passed" : "failed"; receipt.code = code;
  await save(path.join(outputDir, "receipt.json"), receipt);
  return receipt;
}

export async function runCli(argv, { cwd = process.cwd(), write = value => process.stdout.write(`${JSON.stringify(value)}\n`), signal } = {}) {
  try {
    if (argv[0] === "--help") { write({ schema: "zeros.zstack-help/v1", help: HELP }); return 0; }
    const options = {}, seen = new Set(), values = new Set(["--output", "--baseline", "--revision", "--batch-size",
      "--timeout-minutes", "--dependency-cache", "--mode", "--agent", "--master"]);
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (seen.has(flag)) fail("zstack_corpus_invalid"); seen.add(flag);
      if (flag === "--execute") options.execute = true;
      else if (values.has(flag) && argv[index + 1] && !argv[index + 1].startsWith("--") && !/[\0\r\n]/.test(argv[index + 1]))
        options[flag.slice(2)] = argv[++index];
      else fail("zstack_corpus_invalid");
    }
    const batchSize = Number(options["batch-size"] ?? 32), minutes = Number(options["timeout-minutes"] ?? 150);
    if (!validSize(batchSize) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 180) fail("zstack_corpus_invalid");
    let baseline;
    if (options.execute) {
      const file = path.resolve(cwd, options.baseline ?? "agents/zstack/evals/baseline.json");
      const source = await sourceBytes(path.dirname(file), path.basename(file));
      if (!source || source.mode === 0o120000 || source.bytes.length > 2 * 1024 * 1024) fail("zstack_corpus_invalid");
      baseline = JSON.parse(source.bytes.toString("utf8"));
    }
    const revision = options.revision ?? gitRead(["rev-parse", "HEAD"], cwd).toString("utf8").trim();
    const result = await runCorpus({ cwd, ...options, revision, baseline, batchSize, timeoutMs: minutes * 60_000,
      outputDir: options.output, dependencyCache: options["dependency-cache"] }, { signal, emit: write });
    write(result.schema === "zeros.zstack-corpus-plan/v1" ? result : { ...result, cases: undefined, planned: undefined, remaining: undefined });
    return result.status === "failed" ? 1 : 0;
  } catch (error) { write({ schema: "zeros.zstack-error/v1", code: failureCode(error) }); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  runCli(process.argv.slice(2), { signal: controller.signal }).then(code => { process.exitCode = code; })
    .finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}

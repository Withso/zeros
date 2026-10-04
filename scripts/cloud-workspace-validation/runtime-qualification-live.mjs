#!/usr/bin/env node
// Operator-only Alpha runbook. No provider credentials or model sessions are
// needed here; the control-plane worker owns allocation and verified cleanup.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseAgentEnv } from "../agent-env-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALPHA = "https://api-alpha.zeros.build";
const STATUS = "/v1/internal/cloud-runtime/status";
const RUNTIME = /^r1-[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KINDS = ["claude-setup-token", "codex-chatgpt", "cursor-api-key", "claude-api-key", "codex-api-key"];
const CHECKS = new Set(["input_schema", "operator_auth", "alpha_only", "http_status", "response_schema",
  "run_unavailable", "timeout", "qualification_failed", "cleanup_unconfirmed", "approval_missing", "report_write"]);

class RunbookFailure extends Error {
  constructor(check) { super("Runtime qualification verification failed"); this.check = check; }
}
const fail = check => { throw new RunbookFailure(check); };
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function parseRunbookSelection(args) {
  if (args.length !== 2) return fail("input_schema");
  if (args[0] === "--runtime" && RUNTIME.test(args[1])) return { runtimeId: args[1] };
  if (args[0] === "--run" && UUID.test(args[1])) return { runId: args[1] };
  return fail("input_schema");
}

function alphaStatus(value) {
  if (value?.channel !== "alpha") fail("alpha_only");
  if (!Array.isArray(value.qualificationRuns) || !Array.isArray(value.qualifications)) fail("response_schema");
  return value;
}

/** Copy only validated resource identities and closed state, never raw API
 * output, error messages, artifact locations or even diagnostic free text. */
export function qualificationEvidence(status, runId) {
  alphaStatus(status);
  if (!UUID.test(runId)) fail("input_schema");
  const run = status.qualificationRuns.find(value => value.runId === runId);
  if (!run) fail("run_unavailable");
  if (!RUNTIME.test(run.runtimeId) || !["queued", "running", "succeeded", "failed"].includes(run.state) ||
      run.baseImageId !== null && !ID.test(run.baseImageId) ||
      run.baseCompatibilityId !== null && !/^bc1-[a-f0-9]{64}$/.test(run.baseCompatibilityId) ||
      run.sandboxId !== null && !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(run.sandboxId)) fail("response_schema");
  const rows = status.qualifications.filter(row => row.runtimeId === run.runtimeId &&
    row.baseCompatibilityId === run.baseCompatibilityId && row.profile === "zeros-cloud-worker-v4");
  const approvedKinds = KINDS.filter(kind => rows.filter(row => row.credentialKind === kind && row.enabled === true &&
    row.revokedAt === null && row.evidenceMode === "smoke" && row.mcpQualified === false).length === 1);
  return { schema: "zeros.runtime-qualification-verification/v1", channel: "alpha", runId,
    runtimeId: run.runtimeId, baseImageId: run.baseImageId, baseCompatibilityId: run.baseCompatibilityId,
    sandboxId: run.sandboxId, state: run.state, cleanupConfirmedAt: date(run.cleanupConfirmedAt),
    finishedAt: date(run.finishedAt), diagnosticOk: run.diagnostic?.ok === true, approvedKinds };
}

/** Injected dependencies keep the runbook locally testable without network. */
export async function verifyLiveQualification(selection, { request, save, wait = delay, now = Date.now, timeoutMs = 35 * 60_000 }) {
  let status = alphaStatus(await request(STATUS));
  let runId = selection.runId;
  if (!runId) {
    if (!RUNTIME.test(selection.runtimeId)) fail("input_schema");
    const scheduled = await request("/v1/internal/cloud-runtime/runtimes/" + selection.runtimeId + "/requalify", "POST");
    if (scheduled?.runtimeId !== selection.runtimeId || !UUID.test(scheduled?.runId) ||
        !["queued", "running"].includes(scheduled?.status)) fail("response_schema");
    runId = scheduled.runId;
    // Preserve the receipt before the next network call, even if observation
    // immediately loses its staff session. --run resumes without another POST.
    await save({ schema: "zeros.runtime-qualification-verification/v1", channel: "alpha",
      runId, runtimeId: selection.runtimeId, state: scheduled.status, cleanupConfirmedAt: null });
    status = alphaStatus(await request(STATUS));
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    const evidence = qualificationEvidence(status, runId);
    if (selection.runtimeId && evidence.runtimeId !== selection.runtimeId) fail("response_schema");
    await save(evidence);
    if (["succeeded", "failed"].includes(evidence.state)) {
      if (!evidence.cleanupConfirmedAt) fail("cleanup_unconfirmed");
      if (evidence.state !== "succeeded" || !evidence.diagnosticOk) fail("qualification_failed");
      if (evidence.approvedKinds.length !== KINDS.length) fail("approval_missing");
      return evidence;
    }
    if (now() >= deadline) fail("timeout");
    await wait(Math.min(5000, deadline - now()));
    status = alphaStatus(await request(STATUS));
  }
}

export function runbookDiagnostic(error) {
  const check = error instanceof RunbookFailure && CHECKS.has(error.check) ? error.check : "http_status";
  return { schema: "zeros.diagnostic/v1", component: "qualification", stage: "live_verification",
    ok: !error, exitCode: error ? 1 : 0, timedOut: !!error && check === "timeout", failedChecks: error ? [check] : [] };
}

function staffToken() {
  try {
    const file = path.join(ROOT, ".env.agent");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 128 * 1024) fail("operator_auth");
    const parsed = parseAgentEnv(readFileSync(file, "utf8"));
    const token = parsed.values.get("ZEROS_ACCOUNT_ACCESS_TOKEN");
    if (parsed.malformedLines.length || parsed.duplicateKeys.length || !token || !/^[A-Za-z0-9._-]{20,16384}$/.test(token)) fail("operator_auth");
    return token;
  } catch { return fail("operator_auth"); }
}

async function request(route, method = "GET") {
  const token = staffToken(); // Refresh the private file when the staff session expires.
  let response;
  try {
    response = await fetch(ALPHA + route, { method, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: "Bearer " + token, accept: "application/json" } });
    if (!response.ok || !response.body) fail("http_status");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) fail("response_schema");
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    if (error instanceof RunbookFailure) throw error;
    return fail("http_status");
  } finally { await response?.body?.cancel().catch(() => {}); }
}

function save(evidence) {
  if (!UUID.test(evidence.runId)) fail("report_write");
  try {
    const directory = path.join(ROOT, ".context");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(directory, "runtime-qualification-" + evidence.runId + ".json"),
      JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  } catch { fail("report_write"); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let error;
  try { await verifyLiveQualification(parseRunbookSelection(process.argv.slice(2)), { request, save }); }
  catch (caught) { error = caught; }
  const diagnostic = runbookDiagnostic(error);
  process.stdout.write(JSON.stringify(diagnostic) + "\n");
  process.exitCode = diagnostic.exitCode;
}

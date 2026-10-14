import { spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { assertExecutablePlan } from "./check-plan.mjs";

export function childEnvironment(env = process.env) {
  // No credentials, loader hooks or arbitrary runtime flags inherited by checks.
  const keys = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "TERM", "CI", "SYSTEMROOT"];
  return { ...Object.fromEntries(keys.filter(key => typeof env[key] === "string").map(key => [key, env[key]])),
    NO_COLOR: "1", FORCE_COLOR: "0", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
}

function prerequisiteFailure(message) {
  // A product race can itself throw ENOENT/EACCES, and assertions may quote
  // those strings. Only explicit primary host/tool or runner failures qualify.
  const primary = typeof message === "string" ? message.trimStart().split(/\r?\n/, 1)[0].replace(/^Error: /, "") : "";
  return /^spawn(?:Sync)? (?:\/(?:usr\/(?:local\/)?)?bin\/)?(?:bash|sh|node|pnpm|git|sudo|dpkg-deb|python3) (?:ENOENT|EACCES)$/.test(primary) ||
    /^ENOSPC: no space left on device(?:,|$)/.test(primary) ||
    /^(?:Test|Hook) timed out in [0-9]+ms\./.test(primary);
}

function testSummary(bytes, cwd) {
  try {
    // pnpm prints a script banner before Vitest's one JSON document.
    const start = bytes.indexOf('{"numTotalTestSuites"');
    const data = JSON.parse(start < 0 ? bytes : bytes.slice(start));
    const assertions = data.testResults.flatMap(suite => suite.assertionResults);
    const { numTotalTests: total, numPassedTests: passed, numFailedTests: failed, numPendingTests: pending } = data;
    if (![total, passed, failed, pending].every(value => Number.isSafeInteger(value) && value >= 0) || total === 0 ||
      passed + failed + pending > total || assertions.length !== total ||
      assertions.filter(test => test.status === "failed").length !== failed ||
      assertions.filter(test => test.status === "passed").length !== passed ||
      data.testResults.some(suite => !suite.assertionResults.length || (suite.status === "failed" && !suite.assertionResults.some(test => test.status === "failed"))))
      return null;
    const occurrences = new Map();
    const identities = data.testResults.flatMap(suite => suite.assertionResults.map((test, index) => {
      const identity = [path.relative(cwd, suite.name ?? cwd), test.fullName ?? index], key = JSON.stringify(identity);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return { id: createHash("sha256").update(JSON.stringify([...identity, occurrence])).digest("hex"), status: test.status };
    }));
    const environmentFailed = assertions.some(test => test.status === "failed" && (test.failureMessages ?? []).some(prerequisiteFailure));
    return { total, passed, failed, pending, success: data.success === true, environmentFailed, identities };
  } catch { return null; }
}

export async function runCommand(command, { cwd, spawn = spawnProcess, kill, signal, timeoutMs = 10 * 60_000,
  maxOutputBytes = 8 * 1024 * 1024, env = process.env } = {}) {
  if (!Array.isArray(command.argv) || !command.argv.length || command.argv.some(part => typeof part !== "string" || /[\0\r\n]/.test(part)) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60_000 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 32 * 1024 * 1024)
    throw new Error("zstack_command_invalid");
  const started = performance.now(), hash = createHash("sha256"), stdout = [];
  let outputBytes = 0, stopped = signal?.aborted ? "cancelled" : null;
  const result = (exitCode, code, tests = null) => ({ status: code === "ok" ? "passed" : "failed", code, exitCode,
    durationMs: Math.round(performance.now() - started), outputBytes, outputSha256: hash.digest("hex"), tests });
  if (stopped) return result(null, stopped);
  const argv = command.kind === "vitest" ? [...command.argv, "--reporter=json"] : command.argv;
  return new Promise(resolve => {
    let child, timer, escalation, done = false;
    const stop = code => {
      if (stopped || done) return;
      stopped = code;
      const send = sig => {
        try {
          if (kill) kill(child.pid, sig);
          else if (process.platform === "win32") child.kill(sig);
          else process.kill(-child.pid, sig);
        } catch { /* Already exited. Wait for close to reap the child. */ }
      };
      send("SIGTERM");
      escalation = setTimeout(() => send("SIGKILL"), 1000);
    };
    const abort = () => stop("cancelled");
    const finish = (exitCode, code) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener("abort", abort);
      const tests = command.kind === "vitest" && !stopped ? testSummary(Buffer.concat(stdout).toString("utf8"), cwd) : null;
      if (!code && command.kind === "vitest") code = !tests ? "test_report_invalid" : tests.environmentFailed ? "test_environment_failed" : tests.failed > 0 ? "tests_failed" :
        exitCode === 0 && tests.success && tests.passed > 0 ? "ok" : "test_report_invalid";
      resolve(result(exitCode, stopped ?? code ?? (exitCode === 0 ? "ok" : "check_failed"), tests));
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: childEnvironment(env), shell: false,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const consume = (chunk, isStdout) => {
        if (done || stopped) return;
        const bytes = Buffer.from(chunk); outputBytes += bytes.length;
        hash.update(bytes.subarray(0, Math.max(0, maxOutputBytes - (outputBytes - bytes.length))));
        if (outputBytes > maxOutputBytes) { stop("output_limit"); return; }
        if (isStdout && command.kind === "vitest") stdout.push(bytes);
      };
      child.stdout.on("data", chunk => consume(chunk, true)); child.stderr.on("data", chunk => consume(chunk, false));
      child.once("error", () => finish(null, "spawn_failed")); child.once("close", code => finish(code));
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop("deadline"), timeoutMs);
      if (signal?.aborted) abort();
    } catch { finish(null, "spawn_failed"); }
  });
}

export async function executeVerification(plan, { cwd, metadata, fingerprint, run = runCommand, signal } = {}) {
  assertExecutablePlan(plan);
  const startedAt = new Date().toISOString(), results = [];
  let code = "ok";
  for (const check of plan.local) {
    if (await fingerprint() !== plan.identity.fingerprint) { code = "source_changed"; break; }
    const outcome = await run(check, { cwd, signal });
    results.push({ id: check.id, argv: [...check.argv], ...outcome });
    if (outcome.status !== "passed") { code = outcome.code; break; }
    if (await fingerprint() !== plan.identity.fingerprint) { code = "source_changed"; break; }
  }
  const remaining = plan.local.slice(results.length).map(check => ({ id: check.id, reason: "not_run" }));
  return { schema: "zeros.zstack-receipt/v1", ...metadata, identity: plan.identity, startedAt, completedAt: new Date().toISOString(),
    status: code === "ok" ? "passed" : "failed", code, results, unverified: [...plan.ci, ...remaining],
    evidence: [], tokens: null };
}

export async function writeReceipt(file, receipt) {
  let handle, directory;
  try {
    const target = path.resolve(file), parent = path.dirname(target);
    directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await directory.stat();
    if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || (parentInfo.mode & 0o022)) throw new Error();
    if (await realpath(parent) !== parent) throw new Error();
    handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o600) throw new Error();
    const value = `${JSON.stringify(receipt, null, 2)}\n`;
    if (Buffer.byteLength(value) > 2 * 1024 * 1024) throw new Error();
    await handle.writeFile(value); await handle.sync();
    const current = await lstat(target);
    const parentCurrent = await lstat(parent);
    if (current.dev !== info.dev || current.ino !== info.ino || current.nlink !== 1 ||
      parentCurrent.dev !== parentInfo.dev || parentCurrent.ino !== parentInfo.ino || await realpath(parent) !== parent) throw new Error();
    await directory.sync();
  } catch { throw new Error("zstack_receipt_unsafe"); }
  finally { await handle?.close(); await directory?.close(); }
}

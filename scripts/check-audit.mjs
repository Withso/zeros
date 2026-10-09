import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function verifyAuditGraph() {
  const cwd = process.cwd();
  const isRoot = cwd === ROOT;
  if (!isRoot && cwd !== join(ROOT, "apps/control-plane")) {
    throw new Error("Unsupported audit working directory");
  }
  const boundary = isRoot ? "Root" : "Control-plane";
  if (
    !["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"].every(
      (filename) => existsSync(join(cwd, filename)),
    )
  ) {
    throw new Error(`${boundary} audit boundary files are missing`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  } catch {
    throw new Error(`${boundary} audit boundary manifest is invalid`);
  }
  if (manifest?.name !== (isRoot ? "zeros" : "@zeros/control-plane")) {
    throw new Error(`${boundary} audit boundary manifest identity changed`);
  }
  let config;
  try {
    const output = execFileSync(
      "pnpm",
      ["config", "get", "auditConfig", "--json"],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    config = output.trim() ? JSON.parse(output) : {};
  } catch {
    throw new Error(`${boundary} audit configuration could not be read`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${boundary} audit configuration must be an object`);
  }
  for (const [field, advisory] of [
    ["ignoreGhsas", "GHSA-86w9-cpqp-85rv"],
    ["ignoreCves", "CVE-2026-85393"],
  ]) {
    const exceptions = config[field] ?? [];
    if (
      !Array.isArray(exceptions) ||
      exceptions.some((value) => typeof value !== "string")
    ) {
      throw new Error(
        `${boundary} audit configuration ${field} must be an array of strings`,
      );
    }
    if (
      exceptions.some(
        (value) => value.trim().toUpperCase() === advisory.toUpperCase(),
      )
    ) {
      throw new Error(`${boundary} audit cannot ignore the Forge advisory`);
    }
  }
}

export const AUDIT_ATTEMPTS = 3;
// pnpm's audit client already waits 10 seconds and then a minute between its
// own endpoint retries. Leave one whole command enough time to finish that
// sequence, while keeping both a single attempt and the outer retry loop
// finite in release CI.
export const AUDIT_ATTEMPT_TIMEOUT_MS = 150_000;
export const AUDIT_TOTAL_TIMEOUT_MS = 480_000;
export const AUDIT_RETRY_DELAY_MS = 5_000;

const TRANSPORT_FAILURE_RX =
  /\b(?:ERR_SOCKET_TIMEOUT|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|\bHTTP\s+(?:408|429|5\d{2})\b/i;
const AUDIT_FINDING_RX =
  /\bGHSA-[a-z0-9-]+\b|\bfound\s+[1-9]\d*\s+(?:(?:low|moderate|high|critical)\s+severity\s+)?vulnerabilit(?:y|ies)\b|\b[1-9]\d*\s+vulnerabilit(?:y|ies)\s+found\b/i;

export function isRetryableAuditTransportFailure(output) {
  // A registry/proxy status can appear in advisory details or surrounding CI
  // output. Findings always win: retries are only for a transport-only failure
  // and must never turn a real audit failure into a later success.
  return !AUDIT_FINDING_RX.test(output) && TRANSPORT_FAILURE_RX.test(output);
}

function stopProcess(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The child can exit between the timeout and the signal.
    }
  }
  child.kill("SIGTERM");
}

function forceStopProcess(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The graceful timeout can win this race.
    }
  }
  child.kill("SIGKILL");
}

export function runAuditCommand({ timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("pnpm", ["audit", "--prod", "--audit-level=high"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;

    const write = (stream) => (chunk) => {
      const text = chunk.toString();
      output += text;
      stream.write(text);
    };
    child.stdout.on("data", write(process.stdout));
    child.stderr.on("data", write(process.stderr));
    child.on("error", (error) => {
      const text = `${error.stack ?? error.message}\n`;
      output += text;
      process.stderr.write(text);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      const text = `pnpm audit exceeded its ${timeoutMs}ms command timeout\n`;
      output += text;
      process.stderr.write(text);
      stopProcess(child);
    }, timeoutMs);
    const forceTimer = setTimeout(
      () => forceStopProcess(child),
      timeoutMs + 5_000,
    );

    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve({
        exitCode: code ?? 1,
        output,
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
  });
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runAuditWithRetries({
  execute = runAuditCommand,
  sleep = delay,
  now = Date.now,
  attempts = AUDIT_ATTEMPTS,
  attemptTimeoutMs = AUDIT_ATTEMPT_TIMEOUT_MS,
  totalTimeoutMs = AUDIT_TOTAL_TIMEOUT_MS,
} = {}) {
  const startedAt = now();
  let result;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) {
      return result;
    }

    result = await execute({ timeoutMs: Math.min(attemptTimeoutMs, remainingMs) });
    if (result.exitCode === 0) {
      return result;
    }
    if (
      !isRetryableAuditTransportFailure(result.output) ||
      attempt === attempts
    ) {
      return result;
    }

    const retryDelayMs = Math.min(
      AUDIT_RETRY_DELAY_MS * attempt,
      totalTimeoutMs - (now() - startedAt),
    );
    if (retryDelayMs <= 0) return result;
    console.warn(
      `pnpm audit transport failed (attempt ${attempt}/${attempts}); retrying in ${retryDelayMs}ms`,
    );
    await sleep(retryDelayMs);
  }

  return result;
}

export async function runCheckedAudit({
  verifyPatch = verifyAuditGraph,
  ...options
} = {}) {
  verifyPatch();
  return runAuditWithRetries(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runCheckedAudit();
  process.exitCode = result.exitCode;
}

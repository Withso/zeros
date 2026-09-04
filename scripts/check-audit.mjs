import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

export function isRetryableAuditTransportFailure(output) {
  return TRANSPORT_FAILURE_RX.test(output);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runAuditWithRetries();
  process.exitCode = result.exitCode;
}

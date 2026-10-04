import { request as httpRequest } from "node:http";
import type { ChildProcess } from "node:child_process";
import {
  ENGINE_HEALTH_PROBE_TIMEOUT_MS,
  isExpectedEngineHealth,
} from "./engine-health";

/** Prove the engine event loop can answer, not merely that its kernel listener
 * still owns the port. A wedged Bun process can keep completing TCP handshakes
 * from the accept backlog for minutes while every HTTP/WS request is frozen;
 * the old connect-only watchdog therefore missed the archive hang it was meant
 * to recover. `/health` is synchronous and loopback-only, so a valid response
 * is the smallest application-level liveness check. The manifest's per-boot
 * nonce makes this an ownership check too: a sibling/stale engine returning a
 * generic healthy response on the same port is not OUR engine. */
export function engineResponsive(
  port: number,
  expectedInstance: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? ENGINE_HEALTH_PROBE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    options.signal?.aborted
  ) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (responsive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(responsive);
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        headers: { Host: `127.0.0.1:${port}` },
        signal: options.signal,
      },
      (res) => {
        let body = "";
        let bytes = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8192) {
            finish(false);
            return;
          }
          body += chunk;
        });
        res.once("end", () => {
          if (res.statusCode !== 200) {
            finish(false);
            return;
          }
          try {
            finish(isExpectedEngineHealth(JSON.parse(body), expectedInstance));
          } catch {
            finish(false);
          }
        });
        res.once("error", () => finish(false));
        res.once("aborted", () => finish(false));
        res.once("close", () => finish(false));
      },
    );
    // Socket inactivity timeouts reset on every chunk. A partial response must
    // not keep a probe alive forever or stack probes on subsequent timer ticks.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    req.once("error", () => finish(false));
    req.end();
  });
}

type ProbeChild = Pick<ChildProcess, "exitCode" | "signalCode"> & {
  once(event: "exit" | "error", listener: () => void): unknown;
  removeListener(event: "exit" | "error", listener: () => void): unknown;
};

/** A long confirmation must not delay actual crash recovery or adopt an
 * answering sibling. Bind cancellation to the exact observed child, and remove
 * temporary listeners whether HTTP succeeds, times out, or the child exits. */
export async function ownedEngineResponsive(
  child: ProbeChild | null,
  port: number,
  expectedInstance: string,
  timeoutMs = ENGINE_HEALTH_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null)
    return false;
  const controller = new AbortController();
  const exited = () => controller.abort();
  child.once("exit", exited);
  child.once("error", exited);
  try {
    return await engineResponsive(port, expectedInstance, {
      timeoutMs,
      signal: controller.signal,
    });
  } finally {
    child.removeListener("exit", exited);
    child.removeListener("error", exited);
  }
}

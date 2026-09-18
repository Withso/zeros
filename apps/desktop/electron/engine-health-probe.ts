import { request as httpRequest } from "node:http";
import { isExpectedEngineHealth } from "./engine-health";

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
): Promise<boolean> {
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
    const deadline = setTimeout(() => finish(false), 1500);
    req.once("error", () => finish(false));
    req.end();
  });
}

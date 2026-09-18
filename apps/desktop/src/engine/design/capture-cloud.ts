import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  DESIGN_CAPTURE_PNG_BYTES,
  DESIGN_CAPTURE_TIMEOUT_MS,
} from "@zeros/protocol/design-capture";
import {
  startDesignCaptureService,
  type DesignCaptureHost,
  type DesignCaptureService,
} from "./capture-service";

const WORKER = "/opt/zeros/dist-engine/design-capture-worker.js";
const BROWSERS = "/opt/zeros/design-browsers";
const CAPTURE_UID = 10002;

function rootControlled(file: string): boolean {
  for (let current = file; ; current = path.dirname(current)) {
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || info.uid !== 0 || info.mode & 0o022)
      return false;
    if (current === "/") return true;
  }
}

/** Separate, disposable renderer UID. The privileged coordinator never loads
 * Playwright or Chromium, and the renderer receives no provider/capture token.
 * Only the immutable cloud image can provide this worker and browser install. */
export function createCloudDesignCaptureHost(): DesignCaptureHost {
  return (input, signal) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const child = spawn(
        "/usr/bin/setpriv",
        [
          `--reuid=${CAPTURE_UID}`,
          `--regid=${CAPTURE_UID}`,
          "--clear-groups",
          "--no-new-privs",
          process.execPath,
          WORKER,
        ],
        {
          cwd: "/tmp",
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            LANG: "C.UTF-8",
            HOME: "/home/zeros-capture",
            PLAYWRIGHT_BROWSERS_PATH: BROWSERS,
          },
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      let killTimeout: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals = "SIGKILL") => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {
            /* already retired */
          }
        }
      };
      const abort = () => {
        if (failed) return;
        failed = true;
        kill("SIGTERM");
        killTimeout = setTimeout(() => kill(), 1000);
      };
      const timeout = setTimeout(abort, DESIGN_CAPTURE_TIMEOUT_MS);
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(killTimeout);
        signal.removeEventListener("abort", abort);
        kill();
      };
      child.stdin.on("error", abort);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > Math.ceil((DESIGN_CAPTURE_PNG_BYTES * 4) / 3) + 4096)
          abort();
        else chunks.push(chunk);
      });
      child.once("error", () => {
        cleanup();
        reject(new Error("Cloud Design renderer could not start."));
      });
      child.once("close", (code) => {
        cleanup();
        if (failed || signal.aborted || code !== 0) {
          reject(new Error("Cloud Design capture failed or was cancelled."));
          return;
        }
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            data?: unknown;
            renderer?: unknown;
          };
          if (
            typeof reply.data !== "string" ||
            typeof reply.renderer !== "string" ||
            reply.renderer.length > 128
          )
            throw new Error("Invalid capture reply");
          resolve({
            bytes: Buffer.from(reply.data, "base64"),
            renderer: reply.renderer,
          });
        } catch {
          reject(new Error("Cloud Design capture returned invalid evidence."));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
}

export async function startCloudDesignCapture(): Promise<
  DesignCaptureService | undefined
> {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    !process.env.ZEROS_CLOUD_PORT
  )
    return undefined;
  if (
    !rootControlled("/etc/zeros/cloud-worker.json") ||
    !rootControlled(WORKER) ||
    !rootControlled(BROWSERS)
  )
    return undefined;
  const host = createCloudDesignCaptureHost();
  // Advertise capture only after this exact image demonstrates sandboxed render
  // and cleanup. No browser survives this admission or an individual job.
  const probe = await host(
    {
      version: 1,
      html: "<!doctype html><body></body>",
      revision: "capture-admission",
      width: 1,
      height: 1,
      colorScheme: "light",
    },
    AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS),
  );
  const { assertDesignCapturePng } = await import("./capture-service");
  assertDesignCapturePng(probe.bytes, 1, 1);
  return startDesignCaptureService(host);
}

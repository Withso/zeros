import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isCloudDeploymentOwner } from "../agents/containment/cloud-deployment-authority.mjs";
import { isCloudExecutionBoundary } from "../agents/containment/cloud-execution-boundary";
import { resolveCloudRuntime } from "../agents/containment/cloud-runtime-root.mjs";
import type { ExecutionBoundary, PreparedBoundary } from "../agents/containment/types";
import { DESIGN_CAPTURE_PNG_BYTES, DESIGN_CAPTURE_TIMEOUT_MS } from "@zeros/protocol/design-capture";
import { startDesignCaptureService, type DesignCaptureHost, type DesignCaptureService } from "./capture-service";

function rootControlled(file: string): boolean {
  for (let current = file; ; current = path.dirname(current)) {
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info || info.isSymbolicLink() || !isCloudDeploymentOwner(current, info.uid) || info.mode & 0o022) return false;
    if (current === "/") return true;
  }
}

/** Disposable rendering with the engine identity and original owned lifecycle.
 * Its explicit environment omits provider credentials; the VM is the boundary.
 * Chromium and supported frame source retain their existing rendering policy. */
export function createCloudDesignCaptureHost(boundary: ExecutionBoundary,
  options: { onIdentity?: (identity: { uid: number; gid: number }) => void } = {}): DesignCaptureHost {
  if (!isCloudExecutionBoundary(boundary)) throw new Error("Cloud Design requires its original VM execution boundary.");
  const runtime = resolveCloudRuntime();
  return async (input, signal) => {
    signal.throwIfAborted();
    const timeout = new AbortController();
    const jobSignal = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), DESIGN_CAPTURE_TIMEOUT_MS);
    const executionId = `design-capture-${randomUUID()}`;
    let home: string | undefined, prepared: PreparedBoundary | undefined, preparationStarted = false;
    let identity: { uid: number; gid: number } | undefined;
    let result: Awaited<ReturnType<DesignCaptureHost>> | undefined;
    let failed = false, failure: unknown;
    let detachAbort: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => prepared ? stopping ??= prepared.stopAndProve() : Promise.resolve();
    try {
      home = await mkdtemp(path.join(tmpdir(), "zeros-design-capture-"));
      jobSignal.throwIfAborted();
      preparationStarted = true;
      prepared = await boundary.prepareOwned({ executionId, actor: "repo-code-task", providerId: "design-capture",
        cwd: home, workspaceRoot: home }, { signal: jobSignal, retainFailedPreparationProof: true, kind: "service", role: "workload" });
      jobSignal.throwIfAborted();
      const child = await prepared.spawn({ command: runtime.profile === "v4" ? runtime.node : process.execPath,
        args: [`${runtime.workerRoot}/dist-engine/design-capture-worker.js`], cwd: home, stdio: "pipe",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", HOME: home, TMPDIR: home,
          PLAYWRIGHT_BROWSERS_PATH: `${runtime.workerRoot}/design-browsers` } });
      jobSignal.throwIfAborted();
      if (!child.stdin || !child.stdout) throw new Error("Cloud Design renderer pipes are unavailable.");
      child.stderr?.resume();
      result = await new Promise<Awaited<ReturnType<DesignCaptureHost>>>((resolve, reject) => {
        const chunks: Buffer[] = []; let size = 0;
        const abort = () => {
          void stop().catch(() => {});
          reject(new Error("Cloud Design capture failed or was cancelled."));
        };
        jobSignal.addEventListener("abort", abort, { once: true });
        detachAbort = () => jobSignal.removeEventListener("abort", abort);
        child.stdin!.on("error", abort); child.stdout!.on("error", abort);
        child.stdout!.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > Math.ceil(DESIGN_CAPTURE_PNG_BYTES * 4 / 3) + 4096) timeout.abort();
          else chunks.push(chunk);
        });
        void child.wait().then(exit => {
          jobSignal.removeEventListener("abort", abort);
          if (jobSignal.aborted || exit.code !== 0) { abort(); return; }
          try {
            const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown; renderer?: unknown; identity?: { uid?: unknown; gid?: unknown } };
            if (typeof reply.data !== "string" || typeof reply.renderer !== "string" || reply.renderer.length > 128)
              throw new Error("Invalid capture reply");
            const uid = reply.identity?.uid, gid = reply.identity?.gid;
            if (typeof uid !== "number" || typeof gid !== "number" || !Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) ||
              uid < 0 || gid < 0 || uid !== process.geteuid?.() || gid !== process.getegid?.()) {
              reject(new Error("Cloud Design capture returned invalid identity evidence.")); return;
            }
            identity = { uid, gid };
            resolve({ bytes: Buffer.from(reply.data, "base64"), renderer: reply.renderer });
          } catch { reject(new Error("Cloud Design capture returned invalid evidence.")); }
        }, abort);
        child.stdin!.end(JSON.stringify(input));
      });
    } catch (error) {
      failed = true; failure = error;
    } finally {
      clearTimeout(timer);
      detachAbort?.();
    }
    try {
      if (prepared) await stop();
      else if (preparationStarted) await boundary.proveFailedPreparationStopped(executionId);
    } catch { throw new Error("Cloud Design renderer retirement is unconfirmed."); }
    if (home) await rm(home, { recursive: true, force: true });
    if (failed) throw failure;
    if (!result || !identity) throw new Error("Cloud Design capture returned invalid evidence.");
    // Internal deployment qualification observes the fixed worker's effective
    // identity only after its original workload has positively retired.
    options.onIdentity?.(identity);
    return result;
  };
}

export async function startCloudDesignCapture(boundary: ExecutionBoundary | null): Promise<DesignCaptureService | undefined> {
  if (process.platform !== "linux" || !isCloudExecutionBoundary(boundary)) return undefined;
  const runtime = resolveCloudRuntime();
  if (!rootControlled("/etc/zeros/cloud-worker.json") ||
    !rootControlled(`${runtime.workerRoot}/dist-engine/design-capture-worker.js`) ||
    !rootControlled(`${runtime.workerRoot}/design-browsers`)) return undefined;
  const host = createCloudDesignCaptureHost(boundary);
  // Advertise only after the pinned image demonstrates rendering and positive
  // retirement. No per-agent OS or Design-write protection is asserted.
  const probe = await host({ version: 1, html: "<!doctype html><body></body>", revision: "capture-admission",
    width: 1, height: 1, colorScheme: "light" }, AbortSignal.timeout(DESIGN_CAPTURE_TIMEOUT_MS));
  const { assertDesignCapturePng } = await import("./capture-service");
  assertDesignCapturePng(probe.bytes, 1, 1);
  return startDesignCaptureService(host);
}

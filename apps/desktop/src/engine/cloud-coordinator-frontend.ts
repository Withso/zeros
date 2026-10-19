import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { isCloudExecutionBoundary } from "./agents/containment/cloud-execution-boundary";
import type { ExecutionBoundary, PreparedBoundary } from "./agents/containment/types";
import { assertCloudRuntimePath, resolveCloudRuntime } from "./agents/containment/cloud-runtime-root.mjs";
import type { CloudFrontendLaunch, CloudFrontendProcess } from "./cloud-execution-coordinator";

/** One fixed, credential-free frontend in an original infrastructure scope.
 * Host custody supplies PID/start-token/cgroup proof and includes it in drain
 * and census. The renderer cannot choose a command, unit, path or environment. */
export function cloudCoordinatorFrontendSpawner(boundary: ExecutionBoundary | null, socketPath: string, loopbackPath: string, port: number) {
  if (!isCloudExecutionBoundary(boundary)) throw new Error("Cloud frontend requires original Host custody");
  const runtime = resolveCloudRuntime();
  const directory = path.dirname(socketPath), stat = lstatSync(directory);
  if (path.dirname(loopbackPath) !== directory || realpathSync(directory) !== directory || !stat.isDirectory() ||
      stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Cloud frontend requires its private owner directory");
  const script = path.join(runtime.workerRoot, "apps/desktop/src/engine/cloud-interactive-frontend.mjs");
  assertCloudRuntimePath(script);
  return async (launch: CloudFrontendLaunch): Promise<CloudFrontendProcess | null> => {
    if (launch.signal.aborted) return null;
    // This check creates no scope. Keep reversible idle/checkpoint/handoff
    // fences closed and retry only after the original registry admits work.
    try { boundary.workloads.assertAccepting(); } catch { return null; }
    const executionId = `cloud-frontend-${launch.frontendId}`, cwd = path.dirname(socketPath);
    let prepared: PreparedBoundary | undefined;
    let preparing = false;
    let stop: Promise<void> | undefined;
    const stopAndProve = () => stop ??= (async () => {
      if (prepared) await prepared.stopAndProve();
      else if (preparing) await boundary.proveFailedPreparationStopped(executionId);
    })();
    try {
      launch.signal.throwIfAborted();
      preparing = true;
      prepared = await boundary.prepareOwned({ executionId, actor: "repo-code-task", providerId: "cloud-frontend",
        cwd, workspaceRoot: cwd }, { signal: launch.signal, retainFailedPreparationProof: true, kind: "service", role: "infrastructure" });
      launch.signal.throwIfAborted();
      const child = await prepared.spawn({ command: runtime.node,
        args: [script],
        cwd, stdio: "pipe", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
      if (!child.stdin || !child.stdout) throw new Error("Cloud frontend pipes unavailable");
      child.stderr?.resume();
      void child.wait().then(launch.exited, launch.exited);
      child.stdin.on("error", launch.exited); child.stdout.on("error", launch.exited);
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (Buffer.byteLength(pending) + Buffer.byteLength(chunk) > 4096) { launch.exited(); return; }
        pending += chunk;
        for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try { launch.message(JSON.parse(line)); } catch { launch.exited(); return; }
        }
      });
      const send = (frame: object) => {
        if (launch.signal.aborted || !child.stdin?.writable || child.stdin.writableLength > 4096) throw new Error("Cloud frontend is unavailable");
        child.stdin.write(`${JSON.stringify(frame)}\n`);
      };
      send({ type: "start", frontendId: launch.frontendId, socketPath, loopbackPath, port });
      return { stopAndProve, challenge: challengeId => send({ type: "ping", frontendId: launch.frontendId, challengeId }) };
    } catch {
      await stopAndProve();
      // A failed proof rejects: the coordinator cannot retry an unknown child.
      return null;
    }
  };
}

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const decimal = value => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
const refused = () => new Error("cloud_runner_transport_unavailable");

/** These are public custody coordinates, never provider argv/environment.
 * The native client repeats validation and checks the actual peer and kernel. */
export function runnerTransportArguments(values) {
  if (!Array.isArray(values) || values.length !== 12 ||
    !/^\/tmp\/zeros-runners-[A-Za-z0-9]{6}$/.test(values[0]) ||
    ![1, 2, 3, 4, 5, 6, 10, 11].every(index => decimal(values[index])) ||
    !UUID.test(values[7]) || !/^r1-[a-f0-9]{64}$/.test(values[8]) || !UUID.test(values[9])) throw refused();
  return { command: `/opt/zeros-infra/${values[8]}/bin/cloud-runner-bus`, values: [...values] };
}

/** Pause after the non-secret prelude; native and runner inherit the original
 * anonymous descriptors. No material has been released while we read it, so
 * there is no buffered provider input to lose or retransmit on this handoff. */
export async function runCloudRunnerTransport({ input, args, spawnProcess = spawn, timeoutMs = 10_000 }) {
  const { command, values } = runnerTransportArguments(args);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw refused();
  const attempt = await new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); input.off("data", data); input.off("end", fail); input.off("error", fail); };
    const fail = () => { cleanup(); input.pause(); reject(refused()); };
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (pending.length + bytes.length > 4096) { fail(); return; }
      pending = Buffer.concat([pending, bytes]);
      const end = pending.indexOf(10);
      if (end < 0) return;
      cleanup(); input.pause();
      try {
        const value = JSON.parse(pending.subarray(0, end).toString("utf8")), intent = value?.intent, scope = intent?.scope;
        if (end !== pending.length - 1 || Object.keys(value).sort().join(",") !== "intent,type" || value.type !== "start" ||
          intent.version !== 1 || !UUID.test(intent.attemptId) || scope?.version !== 1 ||
          scope.owner?.pid !== Number(values[5]) || scope.owner?.startToken !== values[6] || scope.bootId !== values[7] ||
          scope.runtimeId !== values[8] || scope.executionId !== values[9] ||
          scope.workload?.directory !== "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload" ||
          scope.workload?.dev !== values[10] || scope.workload?.ino !== values[11]) throw refused();
        resolve(intent.attemptId);
      } catch { reject(refused()); }
    };
    const timer = setTimeout(fail, timeoutMs); timer.unref();
    input.on("data", data); input.once("end", fail); input.once("error", fail);
    if (input.destroyed || input.readableEnded) fail();
  });
  // The start intent is consumed once; even a failed/lost native ACK never
  // repeats this submission. The parent retains the original retirement claim.
  const child = spawnProcess(command, ["start", ...values.slice(0, 10), attempt, ...values.slice(10)], {
    cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: "inherit",
  });
  return await new Promise((resolve, reject) => {
    child.once("error", () => reject(refused()));
    child.once("close", (code, signal) => resolve(signal || code === null ? 70 : code));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCloudRunnerTransport({ input: process.stdin, args: process.argv.slice(2) })
    .then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });
}

import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME = 64 * 1024;
const ROOT = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime/engine-workload-shared/workload";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const refused = () => new Error("cloud_runner_request_refused");

function requestFrame(input, signal) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      input.off("data", data); input.off("end", failed); input.off("error", failed);
      signal.removeEventListener("abort", failed);
    };
    const failed = () => { cleanup(); pending.fill(0); reject(refused()); };
    const data = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const newline = bytes.indexOf(10), length = newline < 0 ? bytes.length : newline;
      if (pending.length + length > MAX_FRAME) { failed(); return; }
      pending = Buffer.concat([pending, bytes.subarray(0, length)]);
      if (newline < 0) return;
      input.pause(); cleanup();
      try {
        const value = JSON.parse(pending.toString("utf8"));
        if (!value || Object.keys(value).sort().join(",") !== "request,type" || value.type !== "launch") throw refused();
        const request = value.request;
        if (!request || Object.keys(request).sort().join(",") !== "args,command,cwd,env" ||
          ![request.command, request.cwd].every(item => typeof item === "string" && path.isAbsolute(item) && !/[\0\r\n]/.test(item)) ||
          !Array.isArray(request.args) || request.args.length > 1024 || request.args.some(item => typeof item !== "string" || item.includes("\0")) ||
          !request.env || typeof request.env !== "object" || Array.isArray(request.env) ||
          Object.entries(request.env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || typeof item !== "string" || item.includes("\0")))
          throw refused();
        if (newline + 1 < bytes.length) input.unshift(bytes.subarray(newline + 1));
        resolve(request);
      } catch { reject(refused()); }
      finally { pending.fill(0); }
    };
    input.on("data", data); input.once("end", failed); input.once("error", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted || input.readableEnded || input.destroyed) failed();
  });
}

/** The qualified unit supplies inherited private pipes and a non-secret
 * invocation witness. Only the first frame is control; subsequent bytes are
 * opaque provider stdin. Unit metadata and diagnostics never carry material. */
export async function runCloudAgentRunner({ input, output, error, proof, spawnProcess = spawn, timeoutMs = 10_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw refused();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs); timer.unref();
  let child, closed;
  const failed = () => { controller.abort(); try { child?.kill("SIGKILL"); } catch { /* The unit still owns full retirement. */ } };
  output.on("error", failed); error.on("error", failed); input.on("error", failed);
  controller.signal.addEventListener("abort", failed, { once: true });
  try {
    output.write(`${JSON.stringify({ type: "hello", proof })}\n`);
    const request = await requestFrame(input, controller.signal);
    if (controller.signal.aborted) throw refused();
    child = spawnProcess(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ["pipe", "pipe", "pipe"] });
    closed = new Promise(resolve => child.once("close", (code, signal) => resolve(signal || code === null ? 1 : code)));
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve); child.once("error", () => reject(refused()));
    });
    if (controller.signal.aborted || !child.stdin || !child.stdout || !child.stderr) throw refused();
    await new Promise((resolve, reject) => {
      const aborted = () => reject(refused());
      controller.signal.addEventListener("abort", aborted, { once: true });
      output.write(`${JSON.stringify({ type: "ack", proof })}\n`, writeError => {
        controller.signal.removeEventListener("abort", aborted);
        if (writeError || controller.signal.aborted) reject(refused()); else resolve();
      });
    });
    clearTimeout(timer);
    child.stdin.on("error", () => { input.unpipe(child.stdin); input.resume(); });
    child.stdout.on("error", failed); child.stderr.on("error", failed);
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(error, { end: false });
    input.pipe(child.stdin);
    return await closed;
  } catch {
    failed();
    await closed;
    throw refused();
  } finally {
    clearTimeout(timer);
    input.off("error", failed); output.off("error", failed); error.off("error", failed);
    controller.signal.removeEventListener("abort", failed);
  }
}

/** A hello is only a channel cross-check. The client independently observes
 * this invocation through its original systemd connection and kernel birth. */
export function cloudAgentRunnerProof(args, env = process.env) {
  if (args.length !== 6 || args[0] !== "--attempt" || args[2] !== "--boot" || args[4] !== "--execution" ||
    ![args[1], args[3], args[5]].every(value => UUID.test(value)) || !/^[a-f0-9]{32}$/.test(env.INVOCATION_ID ?? "") ||
    [process.getuid?.(), process.getgid?.(), process.geteuid?.(), process.getegid?.()].some(value => value !== 10003)) throw refused();
  const unit = `zeros-agent-runner@${args[5]}.service`;
  const membership = readFileSync("/proc/self/cgroup", "utf8").trim();
  if (!membership.startsWith("0::/") || membership.includes("\n")) throw refused();
  const directory = `/sys/fs/cgroup${membership.slice(3)}`;
  if (!directory.startsWith(`${ROOT}/runner-${args[3]}/`) || !directory.endsWith(`/${unit}`) || realpathSync(directory) !== directory ||
    statfsSync(directory).type !== 0x63677270) throw refused();
  const metadata = lstatSync(directory, { bigint: true });
  const stat = readFileSync("/proc/self/stat", "utf8"), end = stat.lastIndexOf(")");
  const startToken = stat.slice(end + 1).trim().split(/\s+/)[19];
  if (end < 0 || !/^[1-9][0-9]*$/.test(startToken ?? "") || !metadata.isDirectory() || metadata.isSymbolicLink()) throw refused();
  return { version: 1, attemptId: args[1], bootId: args[3], unit, invocationId: env.INVOCATION_ID,
    pid: process.pid, startToken, cgroup: { directory, dev: String(metadata.dev), ino: String(metadata.ino) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = cloudAgentRunnerProof(process.argv.slice(2));
    runCloudAgentRunner({ input: process.stdin, output: process.stdout, error: process.stderr, proof })
      .then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });
  } catch { process.exitCode = 70; }
}

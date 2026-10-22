import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostExecutionBoundary } from "../host-boundary";
import type { PreparedBoundary } from "../types";

// Retained from the retired cloud Host entry suites: these are the Local
// launch controls, independent of any cloud workload path.
const originalKey = "ZEROS_HOST_SUPERVISOR_ORIGINAL_ENV";
const reservedUserKey = "ZEROS_HOST_SUPERVISOR_WORKLOAD_ENTRY";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value: string | undefined) => JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8"));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const environmentDigest = (value: Record<string, string>) => digest(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

const prepared: PreparedBoundary[] = [];
afterEach(async () => { for (const boundary of prepared.splice(0)) await boundary.stopAndProve(); });

describe("Local Host launch envelope", () => {
  it("preserves the selected env and the reserved-prefix envelope byte shape", async () => {
    const boundary = await new HostExecutionBoundary().prepare({ executionId: randomUUID(), actor: "agent-code",
      cwd: process.cwd(), workspaceRoot: process.cwd() });
    prepared.push(boundary);
    const env = { PATH: "/selected/bin", HOME: "/selected/home", NODE_OPTIONS: "--require=/user/module.cjs",
      LD_PRELOAD: "/user/interposer.so", [reservedUserKey]: "caller-value", ZEROS_TEST: "selected" };
    const launch = boundary.wrapSpawn({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: process.cwd(), env });
    try {
      expect(launch.args).not.toContain("--cloud-workload");
      for (const name of ["PATH", "HOME", "NODE_OPTIONS", "LD_PRELOAD", "ZEROS_TEST"] as const)
        expect(launch.env[name]).toBe(env[name]);
      // Only reserved-prefix names travel in the envelope, restored verbatim.
      expect(decode(launch.env[originalKey])).toEqual({ [reservedUserKey]: "caller-value" });
    } finally {
      boundary.cancelUnstartedLaunch!(launch);
    }
  });
});

/** Run the ORIGINAL supervisor bytes in a disposable lifecycle generation. */
async function localLaunch() {
  const directory = await mkdtemp(path.join(tmpdir(), "zeros-host-local-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const generation = `host-${randomUUID()}`, token = randomUUID();
    const generationRoot = path.join(directory, generation);
    await Promise.all(["commands", "claims", "domains"].map(name => mkdir(path.join(generationRoot, name), { recursive: true, mode: 0o700 })));
    const pending = path.join(generationRoot, "commands", `${token}.json`);
    await writeFile(pending, JSON.stringify({ version: 1, generation, token, ownerPid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
    const supervisor = path.join(directory, "host-process-supervisor.mjs");
    await writeFile(supervisor, await readFile(new URL("../host-process-supervisor.mjs", import.meta.url)));
    const target = path.join(directory, "target.mjs"), preload = path.join(directory, "preload.mjs");
    await writeFile(preload, 'import { appendFileSync } from "node:fs"; appendFileSync("order.log", "target-startup\\n");');
    await writeFile(target, [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { createHash } from "node:crypto";',
      'const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");',
      'appendFileSync("order.log", "target\\n");',
      'const stat=readFileSync("/proc/self/stat","utf8"), fields=stat.slice(stat.lastIndexOf(")")+1).trim().split(/\\s+/);',
      'process.stdout.write(JSON.stringify({args:digest(process.argv.slice(2)),cwd:process.cwd(),',
      ' env:digest(Object.entries(process.env).sort(([a],[b])=>a.localeCompare(b))),parent:process.ppid,group:Number(fields[2]),session:Number(fields[3])}));',
    ].join("\n"));
    // A target argument that looks like a supervisor flag stays a literal.
    const targetArgs = ["literal space", "α", "--cloud-workload"];
    const targetEnv: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory,
      PROVIDER_SENTINEL: "only-target", NODE_OPTIONS: `--import=${preload}`, LOCAL_SENTINEL: "unchanged",
      [reservedUserKey]: "literal-user-value" };
    const reserved = Object.fromEntries(Object.entries(targetEnv).filter(([name]) => name.startsWith("ZEROS_HOST_SUPERVISOR_")));
    const env = { ...targetEnv, [originalKey]: encode(reserved) };
    const args = [supervisor, "--pending", pending, "--claim", path.join(generationRoot, "claims", `${token}.json`),
      "--domain", path.join(generationRoot, "domains", `${token}.json`), "--generation", generation, "--token", token,
      "--owner-pid", String(process.pid), "--parent-pid", String(process.pid), "--", process.execPath, target, ...targetArgs];
    child = spawn(process.execPath, args, { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const supervisorPid = child.pid;
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture supervisor did not exit")), 5000);
      child!.once("error", error => { clearTimeout(timeout); reject(error); });
      child!.once("close", code => { clearTimeout(timeout); resolve(code); });
    });
    const order = await readFile(path.join(directory, "order.log"), "utf8").catch(() => "");
    return { exit, stdout, stderr, order, supervisorPid, targetArgs, targetEnv, directory };
  } finally {
    retire(child);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Kill only this fixture's own supervisor group if it is still running. */
function retire(child: ReturnType<typeof spawn> | undefined) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

describe.runIf(process.platform === "linux")("actual Local Host supervisor", () => {
  it.each(["personal", "organization-local"])("preserves byte-identical %s env/argv/cwd and original process group", async () => {
    const result = await localLaunch();
    expect(result.stderr).toBe("");
    expect(result.exit).toBe(0);
    // Historical Local NODE_OPTIONS also applies to the Host supervisor.
    expect(result.order).toBe("target-startup\ntarget-startup\ntarget\n");
    expect(JSON.parse(result.stdout)).toEqual({ args: digest(result.targetArgs), cwd: result.directory,
      env: environmentDigest(result.targetEnv), parent: result.supervisorPid, group: result.supervisorPid,
      session: result.supervisorPid });
  });
});

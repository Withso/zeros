import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Real Node and the shipped tsx hook, not Vitest's transform: the engine loads
// these probes from the CommonJS worker package with its qualification entry
// as the main module. A fresh TMPDIR gives tsx the cold transform cache of a
// new engine view, so esbuild really compiles every module.
const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
function child(source: string) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "zeros-qualification-loader-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, sandbox, scratch],
      { encoding: "utf8", timeout: 120_000, env: { ...process.env, TMPDIR: scratch } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

it("loads every role probe once, without a second entry run or any lingering transform service", () => {
  const stdout = child(`
    import { execFileSync } from "node:child_process";
    import { readdirSync, readFileSync, writeFileSync } from "node:fs";
    import { createRequire } from "node:module";
    import { pathToFileURL } from "node:url";
    const [sandbox, scratch] = process.argv.slice(1);
    const live = () => process.platform === "linux"
      ? readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).filter(name => {
          try { const stat = readFileSync("/proc/" + name + "/stat", "utf8"), [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            return Number(parent) === process.pid && state !== "Z"; } catch { return false; } }).map(Number)
      : execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,comm="], { encoding: "utf8" }).split("\\n").map(line => line.trim().split(/\\s+/))
          .filter(([, parent, state, command]) => Number(parent) === process.pid && !state?.startsWith("Z") && !/(^|\\/)ps$/.test(command ?? "")).map(([pid]) => Number(pid));
    const { loadCloudQualificationRoles } = await import(pathToFileURL(sandbox + "/cloud-qualification-loader.mjs"));
    process.argv[1] = sandbox + "/qualify-cloud-engine.mjs";
    const { roles, unregister } = await loadCloudQualificationRoles();
    const children = live();
    // A later lazy compile, as during qualification, must not start a
    // lingering transform service either.
    const from = sandbox + "/loader.cjs", later = createRequire(from)("tsx/cjs/api").register({ namespace: "later-compile" });
    writeFileSync(scratch + "/later.ts", "export const compiled: number = " + process.pid + ";\\n");
    later.require(scratch + "/later.ts", from);
    const laterChildren = live();
    later.unregister();
    await unregister();
    await new Promise(resolve => setTimeout(resolve, 250));
    process.stdout.write(JSON.stringify({ roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, typeof role])),
      children, laterChildren, setting: process.env.ESBUILD_WORKER_THREADS ?? null }) + "\\n");
  `);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(stdout)).toEqual({ children: [], laterChildren: [], setting: null, roles: { createCloudQualificationRuntime: "function",
    qualifyCloudActorTools: "function", qualifyCloudCapture: "function", qualifyCloudHumanServices: "function" } });
}, 150_000);

it("runs the serialized privilege parser of a hook-compiled role probe in a fresh context", () => {
  const stdout = child(`
    import { createRequire } from "node:module";
    import vm from "node:vm";
    const from = process.argv[1] + "/loader.cjs";
    const api = createRequire(from)("tsx/cjs/api").register({ namespace: "role-identity-probe" });
    const { cloudRoleIdentityProbe } = api.require("./cloud-role-identity.ts", from);
    const namespaces = Object.fromEntries(["mnt", "pid", "user", "net", "cgroup"].map((name, index) => [name, name + ":[" + (4026531835 + index) + "]"]));
    const namespace = file => namespaces[file.slice("/proc/self/ns/".length)];
    const probe = cloudRoleIdentityProbe({ workloadDirectory: "/sys/fs/cgroup/fixture/workload", credential: "absent" }, namespace);
    const status = ["CapEff", "CapPrm", "CapInh", "CapBnd", "CapAmb"].map(name => name + ":\\t0000000000000000").join("\\n") + "\\nNoNewPrivs:\\t1\\nSeccomp:\\t2\\n";
    const files = { "/proc/self/status": status, "/proc/self/cgroup": "0::/fixture/workload\\n" };
    const run = uid => {
      let code = null;
      vm.runInNewContext(probe, { require: name => { if (name !== "node:fs") throw new Error("unexpected module"); return { readFileSync: file => files[file], readlinkSync: namespace }; },
        process: { getuid: () => uid, geteuid: () => uid, getgid: () => 10003, getegid: () => 10003, env: {}, exit: value => { code = value; } } });
      return code;
    };
    process.stdout.write(JSON.stringify({ engine: run(10003), root: run(0) }) + "\\n");
    api.unregister();
  `);
  expect(JSON.parse(stdout)).toEqual({ engine: null, root: 91 });
}, 150_000);

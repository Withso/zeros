import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const kernel = vi.hoisted(() => ({ enter: vi.fn() }));
vi.mock("../cloud-workload-cgroup.mjs", () => ({ enterCloudWorkload: kernel.enter }));
const entryKey = "ZEROS_HOST_SUPERVISOR_WORKLOAD_ENTRY";
const originalKey = "ZEROS_HOST_SUPERVISOR_ORIGINAL_ENV";
const root = "/sys/fs/cgroup/system.slice/zeros-host.service/engine-runtime";
const entry = { version: 1, common: { directory: root, dev: "7", ino: "1" },
  workload: { directory: `${root}/engine-workload-shared/workload`, dev: "7", ino: "5" } };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const environmentDigest = (value: Record<string, string>) => digest(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const refusal = { code: "cloud_containment_environment_not_ready", message: "Cloud workload entry is unavailable." };
afterEach(() => { kernel.enter.mockReset(); });

describe("cloud Host entry courier (explicit mocked kernel dependency)", () => {
  it("passes only the strict bounded original descriptor to synchronous self-entry", async () => {
    const { enterCloudHostWorkload } = await import("../cloud-host-workload-entry.mjs");
    expect(enterCloudHostWorkload(encode(entry))).toBeUndefined();
    expect(kernel.enter).toHaveBeenCalledExactlyOnceWith(entry, undefined);
  });

  it.each([undefined, null, "", 1, "not base64!", "e30=", "x".repeat(32768),
    Buffer.from([0xff]).toString("base64url"),
    Buffer.from(JSON.stringify(entry) + " ".repeat(16384)).toString("base64url"),
    encode("not a descriptor"), encode({ ...entry, version: 2 }), encode({ ...entry, pid: 123 }),
    encode({ ...entry, common: { ...entry.common, directory: "relative" } }),
    encode({ ...entry, workload: { ...entry.workload, ino: "05" } }),
    encode({ ...entry, workload: { ...entry.workload, dev: "-1" } }),
    encode({ ...entry, workload: { ...entry.workload, ino: "18446744073709551616" } }),
    encode({ ...entry, common: { ...entry.common, directory: `${root}/../host` } }),
    encode({ ...entry, common: { ...entry.common, directory: "/" + "x".repeat(4096) } }),
    encode({ ...entry, workload: { ...entry.workload, providerEnv: "must-not-appear" } }),
  ])("refuses malformed courier %# before any migration", async encoded => {
    const { enterCloudHostWorkload } = await import("../cloud-host-workload-entry.mjs");
    expect(() => enterCloudHostWorkload(encoded)).toThrow(expect.objectContaining(refusal));
    expect(kernel.enter).not.toHaveBeenCalled();
  });

  it("sanitizes migration refusal without retaining native details or continuing target launch", async () => {
    const { enterCloudHostWorkload } = await import("../cloud-host-workload-entry.mjs");
    kernel.enter.mockImplementation(() => { throw new Error("UNSAFE_NATIVE_DETAIL_SENTINEL"); });
    expect(() => enterCloudHostWorkload(encode(entry))).toThrow(expect.objectContaining(refusal));
  });

  it("refuses an accidentally asynchronous entry helper rather than completing preexec early", async () => {
    const { enterCloudHostWorkload } = await import("../cloud-host-workload-entry.mjs");
    kernel.enter.mockReturnValue(Promise.resolve());
    expect(() => enterCloudHostWorkload(encode(entry))).toThrow(expect.objectContaining(refusal));
  });

  it("contains an accidentally asynchronous helper rejection", async () => {
    const { enterCloudHostWorkload } = await import("../cloud-host-workload-entry.mjs");
    kernel.enter.mockReturnValue(Promise.reject(new Error("UNSAFE_ASYNC_DETAIL_SENTINEL")));
    expect(() => enterCloudHostWorkload(encode(entry))).toThrow(expect.objectContaining(refusal));
    await Promise.resolve();
  });
});

// Run the ORIGINAL supervisor bytes and entry module in a disposable fixture,
// substituting ONLY a clearly fake kernel helper. This proves ordering and
// Local behavior; it does not qualify actual cgroup placement or root custody.
async function retireFixture(directory: string, child: ReturnType<typeof spawn> | undefined, ownerLost: boolean | undefined) {
  if (ownerLost) {
    // Only the ORIGINAL child created by our dedicated fixture owner can be
    // signalled here, with its captured kernel birth and original group.
    try {
      const original = JSON.parse(await readFile(path.join(directory, "fixture-supervisor.json"), "utf8")) as { pid: number; birth: string };
      const stat = await readFile(`/proc/${original.pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (fields[0] !== "Z" && fields[19] === original.birth && Number(fields[2]) === original.pid) {
        process.kill(-original.pid, "SIGKILL");
      }
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(ownerLost ? child.pid : -child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}

async function launchFixture(options: { cloud: boolean; encoded?: string; targetArguments?: string[];
  targetOriginal?: string; removePending?: boolean; localCourier?: string; unsafeOriginal?: boolean;
  ownerLostDuringEntry?: boolean; obsoleteCourier?: boolean; duplicateFlag?: boolean; omitOriginal?: boolean }) {
  const directory = await mkdtemp(path.join(tmpdir(), "zeros-host-entry-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const generation = `host-${randomUUID()}`, token = randomUUID();
    const generationRoot = path.join(directory, generation);
    await Promise.all(["commands", "claims", "domains"].map(name => mkdir(path.join(generationRoot, name), { recursive: true, mode: 0o700 })));
    const pending = path.join(generationRoot, "commands", `${token}.json`);
    await writeFile(pending, JSON.stringify({ version: 1, generation, token, ownerPid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
    const sourceRoot = path.resolve("apps/desktop/src/engine/agents/containment");
    const supervisor = path.join(directory, "host-process-supervisor.mjs");
    await writeFile(supervisor, await readFile(path.join(sourceRoot, "host-process-supervisor.mjs")));
    try {
      await writeFile(path.join(directory, "cloud-host-workload-entry.mjs"), await readFile(path.join(sourceRoot, "cloud-host-workload-entry.mjs")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path.join(directory, "cloud-workload-cgroup.mjs"), [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      'export function enterCloudWorkload(entry) {',
      '  if (process.env.NODE_OPTIONS || process.env.LD_PRELOAD || process.env.PROVIDER_SENTINEL) throw new Error("unsafe startup");',
      '  const domain=JSON.parse(readFileSync(process.argv[process.argv.indexOf("--domain")+1],"utf8"));',
      '  if (domain.pid!==process.pid || domain.kind!=="supervisor" || existsSync(process.argv[process.argv.indexOf("--claim")+1])) throw new Error("entry before durable claim");',
      '  if (entry.workload.ino === "999") throw new Error("UNSAFE_NATIVE_DETAIL_SENTINEL");',
      '  appendFileSync("order.log", "entry\\n");',
      '  if (entry.workload.ino === "444") {',
      '    const owner=Number(readFileSync("fixture-owner.pid","utf8"));',
      '    if (process.ppid!==owner) throw new Error("not the original fixture owner");',
      '    process.kill(owner,"SIGTERM"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);',
      '  }',
      '}',
    ].join("\n"));
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
    const targetArgs = options.targetArguments ?? ["literal space", "α", "--cloud-workload"];
    const targetEnv: Record<string, string> = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory,
      PROVIDER_SENTINEL: "only-target", NODE_OPTIONS: `--import=${preload}`, LOCAL_SENTINEL: "unchanged" };
    if (options.unsafeOriginal) targetEnv.ZEROS_HOST_SUPERVISOR_FIXTURE = "must-be-stripped-for-cloud";
    if (options.localCourier !== undefined) targetEnv[entryKey] = options.localCourier;
    const reserved = Object.fromEntries(Object.entries(targetEnv).filter(([name]) => name.startsWith("ZEROS_HOST_SUPERVISOR_")));
    const env: Record<string, string> = options.cloud ? { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", STARTUP_ONLY_SENTINEL: "not-target",
      [options.obsoleteCourier ? "ZEROS_HOST_SUPERVISOR_CLOUD_ENTRY" : entryKey]: options.encoded ?? encode(entry),
      [originalKey]: options.targetOriginal ?? encode(targetEnv) } : { ...targetEnv, [originalKey]: encode(reserved) };
    if (options.omitOriginal) delete env[originalKey];
    if (options.removePending) await rm(pending);
    const args = [supervisor, "--pending", pending, "--claim", path.join(generationRoot, "claims", `${token}.json`),
      "--domain", path.join(generationRoot, "domains", `${token}.json`), "--generation", generation, "--token", token,
      "--owner-pid", String(process.pid), "--parent-pid", String(process.pid), ...(options.cloud ? ["--cloud-workload"] : []),
      ...(options.duplicateFlag ? ["--cloud-workload"] : []),
      "--", process.execPath, target, ...targetArgs];
    if (options.ownerLostDuringEntry) {
      // A dedicated fixture owner may die; never signal the Vitest/engine PID.
      const launcher = path.join(directory, "fixture-owner.mjs");
      await writeFile(path.join(directory, "fixture-launch.json"), JSON.stringify({ args, env }));
      await writeFile(launcher, [
        'import { spawn } from "node:child_process"; import { readFileSync,writeFileSync } from "node:fs";',
        'const {args,env}=JSON.parse(readFileSync("fixture-launch.json","utf8"));',
        'args[args.indexOf("--owner-pid")+1]=String(process.pid); args[args.indexOf("--parent-pid")+1]=String(process.pid);',
        'const pending=JSON.parse(readFileSync(args[args.indexOf("--pending")+1],"utf8")); pending.ownerPid=process.pid;',
        'writeFileSync(args[args.indexOf("--pending")+1],JSON.stringify(pending),{mode:0o600}); writeFileSync("fixture-owner.pid",String(process.pid));',
        'const child=spawn(process.execPath,args,{cwd:process.cwd(),env,detached:true,stdio:["ignore",process.stdout,process.stderr]});',
        'const stat=readFileSync(`/proc/${child.pid}/stat`,"utf8"), fields=stat.slice(stat.lastIndexOf(")")+1).trim().split(/\\s+/);',
        'writeFileSync("fixture-supervisor.json",JSON.stringify({pid:child.pid,birth:fields[19]})); child.once("exit",code=>{process.exitCode=code??125;});',
      ].join("\n"));
      child = spawn(process.execPath, [launcher], { cwd: directory, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    } else {
      child = spawn(process.execPath, args, { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    const supervisorPid = child.pid;
    let stdout = "", stderr = "";
    child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture supervisor did not exit")), 3000);
      child!.once("error", error => { clearTimeout(timeout); reject(error); });
      child!.once("close", code => { clearTimeout(timeout); resolve(code); });
    });
    const order = await readFile(path.join(directory, "order.log"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const expectedEnv = Object.fromEntries(Object.entries(targetEnv).filter(([name]) => !options.cloud || !name.startsWith("ZEROS_HOST_SUPERVISOR_")));
    return { exit, stdout, stderr, order, supervisorPid, targetArgs, expectedEnv, directory };
  } finally {
    await retireFixture(directory, child, options.ownerLostDuringEntry);
    await rm(directory, { recursive: true, force: true });
  }
}

describe.runIf(process.platform === "linux")("actual Host supervisor with an explicit fake kernel entry helper", () => {
  it("self-enters before target Node preload can execute/fork and restores exact target env/cwd/argv/group", async () => {
    const result = await launchFixture({ cloud: true, unsafeOriginal: true });
    expect(result.exit).toBe(0);
    expect(result.order).toBe("entry\ntarget-startup\ntarget\n");
    expect(JSON.parse(result.stdout)).toEqual({ args: digest(result.targetArgs), cwd: result.directory,
      env: environmentDigest(result.expectedEnv), parent: result.supervisorPid, group: result.supervisorPid, session: result.supervisorPid });
  });

  it.each(["personal", "organization-local"])("preserves byte-identical %s Local env/argv/cwd and original process group", async () => {
    const result = await launchFixture({ cloud: false, localCourier: "literal-user-value" });
    expect(result.exit).toBe(0);
    // Historical Local NODE_OPTIONS also applies to the Host supervisor.
    expect(result.order).toBe("target-startup\ntarget-startup\ntarget\n");
    expect(JSON.parse(result.stdout)).toEqual({ args: digest(result.targetArgs), cwd: result.directory,
      env: environmentDigest(result.expectedEnv), parent: result.supervisorPid, group: result.supervisorPid, session: result.supervisorPid });
  });

  it.each(["", "not-base64!", encode({ ...entry, workload: { ...entry.workload, ino: "999" } })])(
    "refuses failed cloud entry %# without starting target or leaking native details", async encoded => {
      const result = await launchFixture({ cloud: true, encoded });
      expect(result.exit).toBe(125);
      expect(result.order).toBe("");
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("cloud_containment_environment_not_ready");
      expect(result.stderr).not.toContain("UNSAFE_NATIVE_DETAIL_SENTINEL");
    });

  it("keeps a canceled original pending claim from entry or target execution", async () => {
    const result = await launchFixture({ cloud: true, removePending: true });
    expect(result.exit).toBe(125);
    expect(result.order).toBe("");
    expect(result.stdout).toBe("");
  });

  it("rechecks original owner after entry and refuses target startup when that owner died", async () => {
    const result = await launchFixture({ cloud: true, ownerLostDuringEntry: true,
      encoded: encode({ ...entry, workload: { ...entry.workload, ino: "444" } }) });
    expect(result.order).toBe("entry\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cloud_containment_environment_not_ready");
  });

  it("refuses malformed target restoration only AFTER entry without exposing original bytes", async () => {
    const result = await launchFixture({ cloud: true, targetOriginal: Buffer.from('{"secret":"UNSAFE_ORIGINAL_SENTINEL').toString("base64url") });
    expect(result.exit).toBe(125);
    expect(result.order).toBe("entry\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("UNSAFE_ORIGINAL_SENTINEL");
  });

  it("never accepts the obsolete CLOUD_ENTRY alias", async () => {
    const result = await launchFixture({ cloud: true, obsoleteCourier: true });
    expect(result.exit).toBe(125);
    expect(result.order).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cloud_containment_environment_not_ready");
  });

  it("refuses duplicate cloud flags before entry or target startup", async () => {
    const result = await launchFixture({ cloud: true, duplicateFlag: true });
    expect(result.exit).toBe(125);
    expect(result.order).toBe("");
    expect(result.stdout).toBe("");
  });

  it("requires the full target envelope rather than inheriting cloud startup settings", async () => {
    const result = await launchFixture({ cloud: true, omitOriginal: true });
    expect(result.exit).toBe(125);
    expect(result.order).toBe("entry\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("cloud_containment_environment_not_ready");
  });
});

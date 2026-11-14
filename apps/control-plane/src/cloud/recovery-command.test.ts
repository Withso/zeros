import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCheckpointResult } from "./checkpoint.js";
import { recoveryCheckpointCommand, recoveryShutdownCommand, recoveryShutdownResult } from "./recovery-command.js";

const execute = promisify(execFile), bootId = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000002";
describe("recovery shutdown and fresh capture", () => {
  let directory: string, worker: string, env: NodeJS.ProcessEnv;
  let unit: { active: string; main: number; enabled: string; refuse: boolean; populated: boolean };
  const save = () => writeFile(join(directory, "unit.json"), JSON.stringify(unit));
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "recovery-shutdown-"));
    worker = join(directory, "home/.local/share/zeros/cloud-worker");
    for (const name of [worker, join(directory, "runtime"), join(directory, "bin"), join(directory, "cgroup/system.slice/zeros-worker.service")])
      await mkdir(name, { recursive: true });
    await writeFile(join(directory, "runtime/.install.lock"), "");
    await writeFile(join(worker, "runtime-boot"), bootId);
    await writeFile(join(directory, "calls"), "");
    unit = { active: "active", main: 123, enabled: "enabled", refuse: false, populated: false }; await save();
    await writeFile(join(directory, "bin/sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o700 });
    await writeFile(join(directory, "bin/systemctl"), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), root=process.env.RECOVERY_TEST_ROOT;
const file=path.join(root,'unit.json'), unit=JSON.parse(fs.readFileSync(file,'utf8')), op=process.argv[2];
if(op==='show') console.log('ActiveState='+unit.active+'\\nMainPID='+unit.main+'\\nControlPID=0\\nControlGroup=/system.slice/zeros-worker.service');
else if(op==='is-enabled') { console.log(unit.enabled); process.exit(unit.enabled==='enabled'?0:1); }
else if(op==='disable') { fs.appendFileSync(path.join(root,'calls'),'disable\\n'); unit.enabled='disabled'; }
else if(op==='stop') {
  fs.appendFileSync(path.join(root,'calls'),'stop\\n'); if(unit.refuse) process.exit(1);
  unit.active='inactive'; unit.main=0;
  fs.writeFileSync(path.join(root,'cgroup/system.slice/zeros-worker.service/cgroup.events'),'populated '+(unit.populated?'1':'0')+'\\n');
} else process.exit(2);
fs.writeFileSync(file,JSON.stringify(unit));
`, { mode: 0o700 });
    env = { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, RECOVERY_TEST_ROOT: directory };
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));
  const binding = () => ({ id, bootId, deadline: Date.now() + 60_000 });
  const run = (command: string) => execute("bash", ["-c", command
    .replaceAll("/home/user/.local/share/zeros/cloud-worker", worker)
    .replaceAll("/opt/zeros/runtime", join(directory, "runtime"))
    .replaceAll("/sys/fs/cgroup", join(directory, "cgroup"))], { env });

  it("proves shutdown once and reconciles a lost reply without another stop", async () => {
    expect((await run(recoveryShutdownCommand(binding()))).stdout).toBe("zeros-recovery-stopped\n");
    expect((await run(recoveryShutdownCommand(binding()))).stdout).toBe("zeros-recovery-stopped\n");
    expect(await readFile(join(directory, "calls"), "utf8")).toBe("disable\nstop\n");
  });
  it.each(["refused", "populated", "restarted"])("never certifies %s execution as stopped", async kind => {
    if (kind === "restarted") {
      await run(recoveryShutdownCommand(binding()));
      unit.active = "active"; unit.main = 456;
    } else if (kind === "refused") unit.refuse = true;
    else unit.populated = true;
    await save();
    expect((await run(recoveryShutdownCommand(binding()))).stdout).toBe("zeros-recovery-refused\n");
  });
  it("does not touch a different boot or an expired command", async () => {
    expect((await run(recoveryShutdownCommand({ ...binding(), deadline: Date.now() - 1 }))).stdout).toBe("zeros-recovery-refused\n");
    await writeFile(join(worker, "runtime-boot"), "00000000-0000-4000-8000-000000000003");
    expect((await run(recoveryShutdownCommand(binding()))).stdout).toBe("zeros-recovery-refused\n");
    expect(await readFile(join(directory, "calls"), "utf8")).toBe("");
  });
  it("captures a fresh archive only after the exact stopped receipt, regardless of an old reuse hint", async () => {
    const home = join(directory, "home"), repo = join(home, "acme/app"), uploaded = join(directory, "uploaded");
    await mkdir(repo, { recursive: true }); await writeFile(join(worker, "session.json"), "native context");
    await writeFile(join(directory, "bin/curl"), '#!/bin/sh\nwhile [ "$1" != -T ]; do shift; done\nshift\ncp "$1" "$RECOVERY_TEST_UPLOAD"\n', { mode: 0o700 });
    env.RECOVERY_TEST_UPLOAD = uploaded;
    const input = { ...binding(), home, checkoutPath: repo, baseBranch: "main", key: Buffer.alloc(32, 1),
      uploadUrl: "https://example.test/checkpoint", reuse: { fingerprint: "a".repeat(64), base: null } };
    const before = await run(recoveryCheckpointCommand(input));
    expect(parseCheckpointResult(before.stdout).ok).toBe(false);
    await run(recoveryShutdownCommand(binding()));
    const after = await run(recoveryCheckpointCommand(input));
    expect(parseCheckpointResult(after.stdout)).toMatchObject({ ok: true, bytes: expect.any(Number), sha256: expect.any(String) });
    expect((await readFile(uploaded)).length).toBeGreaterThan(0);
  });
  it("does not promote a timed-out command or private output into a receipt", () => {
    expect(recoveryShutdownResult({ exitCode: 0, timedOut: false, stdout: "zeros-recovery-stopped\n" })).toBe(true);
    expect(recoveryShutdownResult({ exitCode: 1, timedOut: false, stdout: "zeros-recovery-stopped\n" })).toBe(false);
    expect(recoveryShutdownResult({ exitCode: 0, timedOut: true, stdout: "zeros-recovery-stopped\n" })).toBe(false);
    expect(recoveryShutdownResult({ exitCode: 0, timedOut: false, stdout: "private diagnostic" })).toBe(false);
  });
});

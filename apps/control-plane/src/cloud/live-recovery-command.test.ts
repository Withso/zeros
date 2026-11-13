import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveRecoveryHideCommand, liveRecoveryHideState, liveRecoveryKey } from "./live-recovery-command.js";

const execute = promisify(execFile), boot = "00000000-0000-4000-8000-000000000001", sandbox = "bx_fixture1234";
describe("durable route repair command", () => {
  let directory: string, worker: string, calls: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "route-recovery-")); worker = join(directory, "worker"); calls = join(directory, "calls");
    await mkdir(worker); await mkdir(join(directory, "runtime")); await mkdir(join(directory, "bin"));
    await writeFile(join(directory, "runtime/.install.lock"), ""); await writeFile(join(worker, "runtime-boot"), boot);
    await writeFile(calls, "");
    await writeFile(join(directory, "bin/systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(directory, "bin/host"), "#!/bin/sh\nprintf x >> \"$RECOVERY_TEST_CALLS\"\nexit \"${RECOVERY_TEST_EXIT:-0}\"\n", { mode: 0o700 });
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));
  const run = (expiresAt = Date.now() + 60_000, exit = "0") => execute("bash", ["-c", liveRecoveryHideCommand(sandbox, boot, expiresAt)
    .replaceAll("/home/user/.local/share/zeros/cloud-worker", worker).replaceAll("/opt/zeros/runtime", join(directory, "runtime"))],
  { env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, RECOVERY_TEST_CALLS: calls, RECOVERY_TEST_EXIT: exit } });

  it("reconciles a lost successful reply without another hide", async () => {
    expect((await run()).stdout).toBe("hidden");
    expect((await run()).stdout).toBe("hidden");
    expect(await readFile(calls, "utf8")).toBe("x");
    expect(await readFile(join(worker, `route-recovery/${boot}`), "utf8")).toBe(`${liveRecoveryKey(sandbox, boot)} hidden`);
  });
  it("serializes two replicas on the VM before either calls hide", async () => {
    expect((await Promise.all([run(), run()])).map(result => result.stdout)).toEqual(["hidden", "hidden"]);
    expect(await readFile(calls, "utf8")).toBe("x");
  });
  it("keeps an ambiguous hide pending and never repeats it", async () => {
    expect((await run(Date.now() + 60_000, "1")).stdout).toBe("refused");
    expect((await run()).stdout).toBe("pending");
    expect(await readFile(calls, "utf8")).toBe("x");
  });
  it("refuses a late provider command and a different runtime boot", async () => {
    expect((await run(Date.now() - 1)).stdout).toBe("refused");
    await writeFile(join(worker, "runtime-boot"), "00000000-0000-4000-8000-000000000002");
    expect((await run()).stdout).toBe("binding_changed");
    expect(await readFile(calls, "utf8")).toBe("");
  });
  it("never turns raw command output into diagnostics or success", () => {
    expect(liveRecoveryHideState({ exitCode: 0, timedOut: false, stdout: "synthetic-private-canary" })).toBe("refused");
    expect(liveRecoveryHideState({ exitCode: 1, timedOut: true, stdout: "hidden" })).toBe("pending");
    expect(() => liveRecoveryKey("bx_fixture1234; false", boot)).toThrow("Invalid route recovery binding");
  });
});

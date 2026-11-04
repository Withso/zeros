import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installRuntimeCommand } from "./runtime.js";

it.each([true, false])("only restarts a worker when the installed runtime changes (same=%s)", same => {
  const root = mkdtempSync(join(tmpdir(), "zeros-runtime-restart-"));
  try {
    const sha256 = "a".repeat(64), runtime = join(root, "opt/zeros/runtime", sha256);
    const old = join(root, "opt/zeros/runtime", "b".repeat(64)), bin = join(root, "bin");
    for (const directory of [runtime, old, bin, join(root, "etc/systemd/system"), join(root, "etc/profile.d")]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(runtime, ".complete"), "");
    symlinkSync(same ? runtime : old, join(root, "opt/zeros/worker"));
    const log = join(root, "systemctl.log");
    writeFileSync(log, "");
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" != "-n" ] || shift\n[ "$1" != "chown" ] || exit 0\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ZEROS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
    // Run the real installer with only its absolute filesystem destinations relocated.
    const command = installRuntimeCommand({ sha256, url: "https://fixture.example.test/runtime.tar.gz" })
      .replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/etc/systemd/system", join(root, "etc/systemd/system"))
      .replaceAll("/etc/profile.d", join(root, "etc/profile.d"));
    const output = execFileSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZEROS_TEST_SYSTEMCTL_LOG: log } });
    const restarts = readFileSync(log, "utf8").split("\n").filter(line => /(?:try-restart|restart|stop) zeros-worker/.test(line));
    expect(restarts).toEqual(same ? [] : ["try-restart zeros-worker.service"]);
    expect(output.includes("runtime-changed")).toBe(!same);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

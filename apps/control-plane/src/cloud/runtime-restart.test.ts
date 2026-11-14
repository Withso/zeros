import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { installRuntimeCommand } from "./runtime.js";

it.each([true, false])("never starts or restarts a worker during runtime selection (same=%s)", same => {
  const root = mkdtempSync(join(tmpdir(), "zeros-runtime-restart-"));
  try {
    const source = join(root, "source"); mkdirSync(source);
    const worker = Buffer.from("export {};\n");
    writeFileSync(join(source, "worker.mjs"), worker);
    writeFileSync(join(source, "runtime-manifest.json"), JSON.stringify({ version: 1, files: {
      "worker.mjs": { sha256: createHash("sha256").update(worker).digest("hex"), bytes: worker.length, mode: 0o644 },
    } }));
    const archive = join(root, "runtime.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex"), runtime = join(root, "opt/zeros/runtime", sha256);
    const old = join(root, "opt/zeros/runtime", "b".repeat(64)), bin = join(root, "bin");
    for (const directory of [runtime, old, bin, join(root, "etc/systemd/system"), join(root, "etc/profile.d")]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(runtime, ".complete"), "");
    symlinkSync(same ? runtime : old, join(root, "opt/zeros/worker"));
    const log = join(root, "systemctl.log");
    writeFileSync(log, "");
    writeFileSync(join(bin, "sudo"), '#!/bin/sh\n[ "$1" != "-n" ] || shift\n[ "$1" != "chown" ] || exit 0\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(join(bin, "systemctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ZEROS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
    writeFileSync(join(bin, "curl"), '#!/bin/sh\nwhile [ "$1" != -o ]; do shift; done\ncp "$ZEROS_TEST_ARCHIVE" "$2"\n', { mode: 0o755 });
    // Run the real installer with only its absolute filesystem destinations relocated.
    const command = installRuntimeCommand({ sha256, url: "https://fixture.example.test/runtime.tar.gz" })
      .replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/etc/systemd/system", join(root, "etc/systemd/system"))
      .replaceAll("/etc/profile.d", join(root, "etc/profile.d"));
    const output = execFileSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZEROS_TEST_SYSTEMCTL_LOG: log, ZEROS_TEST_ARCHIVE: archive } });
    const restarts = readFileSync(log, "utf8").split("\n").filter(line => /(?:try-restart|restart|stop) zeros-worker/.test(line));
    expect(restarts).toEqual([]);
    expect(output.includes("runtime-changed")).toBe(!same);
    if (!same) expect(existsSync(old)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRuntimeCommand } from "./runtime.js";

const sha256 = "a".repeat(64);
const url = "https://r2.example.test/bucket/cloud-v2/runtime/aaa.tar.gz?X-Amz-Signature=abc&X-Amz-Expires=900";

describe("cloud v2 runtime install", () => {
  it("downloads a missing runtime once, checks its sha256 and points the worker at it", () => {
    const command = installRuntimeCommand({ sha256, url });
    expect(command.startsWith("bash -c '")).toBe(true);
    // The script is one quoted argument that bash parses cleanly.
    execFileSync("bash", ["-c", `set -- ${command.slice("bash -c ".length)}; bash -n -c "$1"`]);
    const script = execFileSync("bash", ["-c", `set -- ${command.slice("bash -c ".length)}; printf %s "$1"`], { encoding: "utf8" });
    expect(script).toContain(`dir=/opt/zeros/runtime/${sha256}`);
    expect(script).toContain('if [ ! -f "$dir/.complete" ]');
    expect(script).toContain(`printf '%s  %s\\n' ${sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`);
    expect(script).toContain(`'${url}'`);
    expect(script).toContain("sudo -n mv -T /opt/zeros/worker.next /opt/zeros/worker");
    expect(script).toContain("systemctl try-restart zeros-worker.service");
  });

  it("leaves an unchanged VM untouched without any privileged command", () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-runtime-")), bin = join(root, "bin"), log = join(root, "sudo.log");
    try {
      for (const dir of [bin, join(root, "opt/zeros"), join(root, "etc/systemd/system"), join(root, "etc/profile.d"), join(root, "payload")]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, "payload/worker.mjs"), "export {};\n");
      execFileSync("tar", ["-czf", join(root, "runtime.tar.gz"), "-C", join(root, "payload"), "."]);
      const digest = createHash("sha256").update(readFileSync(join(root, "runtime.tar.gz"))).digest("hex");
      writeFileSync(join(bin, "sudo"), `#!/bin/bash\necho "$*" >> ${log}\n[ "$1" = -n ] && shift\nexec "$@"\n`, { mode: 0o755 });
      writeFileSync(join(bin, "systemctl"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "chown"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "curl"), `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncp ${join(root, "runtime.tar.gz")} "$out"\n`, { mode: 0o755 });
      const script = execFileSync("bash", ["-c", `set -- ${installRuntimeCommand({ sha256: digest, url }).slice("bash -c ".length)}; printf %s "$1"`], { encoding: "utf8" })
        .replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/etc/systemd/system", join(root, "etc/systemd/system"))
        .replaceAll("/etc/profile.d", join(root, "etc/profile.d"));
      const run = () => execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(run()).toContain("runtime-changed");
      expect(readlinkSync(join(root, "opt/zeros/worker"))).toBe(join(root, `opt/zeros/runtime/${digest}`));
      const privileged = readFileSync(log, "utf8");
      expect(privileged.length).toBeGreaterThan(0);
      // A resumed VM with the same runtime, unit and profile: no sudo, no lock, no rewrite.
      expect(run()).not.toContain("runtime-changed");
      expect(readFileSync(log, "utf8")).toBe(privileged);
      // Anything out of date takes the full path again.
      writeFileSync(join(root, "etc/profile.d/zeros-worker.sh"), "stale\n");
      run();
      expect(readFileSync(log, "utf8").length).toBeGreaterThan(privileged.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a malformed version or a non-https source", () => {
    expect(() => installRuntimeCommand({ sha256: "abc", url })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "http://r2.example.test/x" })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "https://user:pw@r2.example.test/x" })).toThrow();
  });
});

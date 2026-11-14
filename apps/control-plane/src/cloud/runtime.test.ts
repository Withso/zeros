import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { installRuntimeCommand } from "./runtime.js";

const sha256 = "a".repeat(64);
const url = "https://r2.example.test/bucket/cloud-v2/runtime/aaa.tar.gz?X-Amz-Signature=abc&X-Amz-Expires=900";

describe("cloud v2 runtime install", () => {
  it("downloads a missing runtime once, checks its sha256 and points the worker at it", () => {
    const command = installRuntimeCommand({ sha256, url, timeoutSeconds: 30 });
    expect(command.startsWith("timeout --signal=TERM --kill-after=1 30s bash -c '")).toBe(true);
    // The script is one quoted argument that bash parses cleanly.
    execFileSync("bash", ["-c", `set -- ${command.slice(command.indexOf("bash -c ") + "bash -c ".length)}; bash -n -c "$1"`]);
    const script = execFileSync("bash", ["-c", `set -- ${command.slice(command.indexOf("bash -c ") + "bash -c ".length)}; printf %s "$1"`], { encoding: "utf8" });
    expect(script).toContain(`dir=/opt/zeros/runtime/${sha256}`);
    expect(script).toContain('runtime_verify "$dir"');
    expect(script).toContain(`printf '%s  %s\\n' ${sha256} "$tmp/runtime.tar.gz" | sha256sum -c --status`);
    expect(script).toContain(`'${url}'`);
    expect(script).toContain("sudo -n mv -T /opt/zeros/worker.next /opt/zeros/worker");
    expect(script).not.toMatch(/systemctl (?:try-restart|restart) zeros-worker/);
  });

  it("leaves an unchanged VM untouched without any privileged command, and preserves compiled code while selecting a runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-runtime-")), bin = join(root, "bin"), log = join(root, "sudo.log");
    try {
      for (const dir of [bin, join(root, "opt/zeros"), join(root, "etc/systemd/system"), join(root, "etc/profile.d"), join(root, "payload")]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, "payload/worker.mjs"), "export {};\n");
      const worker = readFileSync(join(root, "payload/worker.mjs"));
      writeFileSync(join(root, "payload/runtime-manifest.json"), JSON.stringify({ version: 1, files: {
        "worker.mjs": { sha256: createHash("sha256").update(worker).digest("hex"), bytes: worker.length, mode: 0o644 },
      } }));
      execFileSync("tar", ["-czf", join(root, "runtime.tar.gz"), "-C", join(root, "payload"), "."]);
      const digest = createHash("sha256").update(readFileSync(join(root, "runtime.tar.gz"))).digest("hex");
      writeFileSync(join(bin, "sudo"), `#!/bin/bash\necho "$*" >> ${log}\n[ "$1" = -n ] && shift\nexec "$@"\n`, { mode: 0o755 });
      writeFileSync(join(bin, "systemctl"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "chown"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "curl"), `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done\ncp ${join(root, "runtime.tar.gz")} "$out"\n`, { mode: 0o755 });
      const generated = installRuntimeCommand({ sha256: digest, url });
      const script = execFileSync("bash", ["-c", `set -- ${generated.slice(generated.indexOf("bash -c ") + "bash -c ".length)}; printf %s "$1"`], { encoding: "utf8" })
        .replaceAll("/opt/zeros", join(root, "opt/zeros")).replaceAll("/etc/systemd/system", join(root, "etc/systemd/system"))
        .replaceAll("/etc/profile.d", join(root, "etc/profile.d")).replaceAll("/home/user/.cache", join(root, "cache"));
      const cache = join(root, "cache/zeros/node-compile-cache"), entry = join(cache, "v24-x64-tag-1000/entry");
      mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, "previous runtime");
      const run = () => execFileSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      const installed = run();
      expect(installed).toContain("runtime-changed");
      const phases = installed.split("\n").filter(line => line.startsWith("zeros-runtime-timing "));
      expect(phases.map(line => line.split(" ")[1])).toEqual(expect.arrayContaining(["download", "verify", "unpack", "activate"]));
      expect(phases.every(line => /^zeros-runtime-timing [a-z]+ [0-9]+ ok$/.test(line))).toBe(true);
      expect(phases.join("\n")).not.toContain("X-Amz");
      expect(readlinkSync(join(root, "opt/zeros/worker"))).toBe(join(root, `opt/zeros/runtime/${digest}`));
      expect(existsSync(cache)).toBe(true);
      expect(readFileSync(entry, "utf8")).toBe("previous runtime");
      mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, "current runtime");
      const privileged = readFileSync(log, "utf8");
      expect(privileged.length).toBeGreaterThan(0);
      // A resumed VM with the same runtime, unit and profile: no sudo, no lock, no rewrite.
      expect(run()).not.toContain("runtime-changed");
      expect(readFileSync(log, "utf8")).toBe(privileged);
      // Anything out of date takes the full path again.
      writeFileSync(join(root, "etc/profile.d/zeros-worker.sh"), "stale\n");
      run();
      expect(readFileSync(log, "utf8").length).toBeGreaterThan(privileged.length);
      // Neither path discards the current runtime's compiled code.
      expect(readFileSync(entry, "utf8")).toBe("current runtime");
      const unitPath = join(root, "etc/systemd/system/zeros-worker.service");
      const unit = readFileSync(unitPath, "utf8");
      expect(unit).toContain("\nOOMPolicy=continue\n");
      // A snapshot with the old policy needs a reload, never a worker restart.
      writeFileSync(unitPath, unit.replace("OOMPolicy=continue\n", ""));
      const beforeRepair = readFileSync(log, "utf8");
      expect(run()).not.toContain("runtime-changed");
      const repair = readFileSync(log, "utf8").slice(beforeRepair.length);
      expect(readFileSync(unitPath, "utf8")).toBe(unit);
      expect(repair).toContain("systemctl daemon-reload");
      expect(repair).not.toMatch(/(?:try-restart|restart|stop) zeros-worker/);
      expect(readFileSync(entry, "utf8")).toBe("current runtime");
      const afterRepair = readFileSync(log, "utf8");
      run();
      expect(readFileSync(log, "utf8")).toBe(afterRepair);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a malformed version or a non-https source", () => {
    expect(() => installRuntimeCommand({ sha256: "abc", url })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "http://r2.example.test/x" })).toThrow();
    expect(() => installRuntimeCommand({ sha256, url: "https://user:pw@r2.example.test/x" })).toThrow();
  });
});

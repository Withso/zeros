// Official Ubuntu package programs run only inside this private mount/PID view.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chownSync, readFileSync, readlinkSync, statfsSync, writeFileSync } from "node:fs";
import { assertPrivateNamespace, assertPrivateRoot } from "./runtime-contract";
import { assertPrivatePidNamespace } from "./fixture-scope";
import { ubuntuFailureDiagnostic } from "./ubuntu-diagnostics";
const config = JSON.parse(readFileSync(process.argv[2], "utf8")) as { outerMountNamespace: string; outerPidNamespace: string };
assertPrivateNamespace({ outer: config.outerMountNamespace, current: readlinkSync("/proc/self/ns/mnt"), uid: process.getuid!() });
assertPrivatePidNamespace(config.outerPidNamespace, readlinkSync("/proc/self/ns/pid"), process.pid);
assertPrivateRoot(statfsSync("/").type);
process.umask(0o022);
const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", HOME: "/root", DEBIAN_FRONTEND: "noninteractive" };
let step = "ownership";
try {
  // Only the new, exclusively owned rootfs bind inodes change ownership.
  execFileSync("/usr/bin/chown", ["-R", "0:0", "/usr", "/etc", "/var"], { stdio: "pipe" });
  for (const directory of ["/usr", "/etc", "/var"]) chownSync(directory, 0, 0);
  writeFileSync("/usr/sbin/policy-rc.d", "#!/bin/sh\nexit 101\n", { mode: 0o755 });
  step = "apt_update";
  execFileSync("/usr/bin/apt-get", ["update"], { stdio: "pipe", env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  step = "apt_install";
  execFileSync("/usr/bin/apt-get", ["install", "-y", "--no-install-recommends", "podman", "bubblewrap", "uidmap", "ca-certificates",
    "git", "socat", "ripgrep", "util-linux", "fuse-overlayfs", "slirp4netns"], { stdio: "pipe", env, timeout: 8 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  step = "inventory";
  const packages = execFileSync("/usr/bin/dpkg-query", ["--show", "--showformat=${binary:Package}\t${Version}\n"], { encoding: "utf8", env });
  process.stdout.write(`${JSON.stringify({ packageCount: packages.trim().split("\n").length,
    packagesSha256: createHash("sha256").update(packages).digest("hex") })}\n`);
} catch (error) {
  // Package output never leaves this process; the operator sees a closed code.
  process.stdout.write(`${JSON.stringify({ code: "ubuntu_package_install_failed", step,
    diagnostics: ubuntuFailureDiagnostic(error as { stderr?: unknown }).diagnostics })}\n`); process.exitCode = 1;
}

import { describe, expect, it } from "vitest";
import { selectUbuntuChecksum, validateUbuntuArchivePaths, ubuntuInstallArguments, ubuntuFailureDiagnostic } from "../cloud-workspace-validation/cloud-agent-e2e/ubuntu-rootfs";

describe("verified private Ubuntu SOURCE-MODE fixture", () => {
  it("keeps the exact closed Ubuntu bootstrap cause while dropping apt prose and host details", () => {
    expect(ubuntuFailureDiagnostic({ stdout: '{"code":"ubuntu_package_install_failed","step":"apt_install","diagnostics":["dns_unavailable"]}\n',
      stderr: "Bearer secret hostname private" })).toEqual({ step: "apt_install", diagnostics: ["dns_unavailable"] });
    expect(ubuntuFailureDiagnostic({ stderr: "bwrap: Can't chdir to /home/private: No such file or directory" }))
      .toEqual({ step: "bootstrap", diagnostics: ["file_missing"] });
    expect(ubuntuFailureDiagnostic({ stdout: '{"step":"Bearer secret","diagnostics":["private"]}', stderr: "Bearer secret" }))
      .toEqual({ step: "bootstrap", diagnostics: [] });
  });
  it("requires exactly one published checksum for the pinned image", () => {
    const name = "ubuntu-base-24.04.5-base-amd64.tar.gz", hash = "a".repeat(64);
    expect(selectUbuntuChecksum(`${hash} *${name}\n${"b".repeat(64)} *other.tar.gz\n`, name)).toBe(hash);
    expect(() => selectUbuntuChecksum(`${hash} *other.tar.gz\n`, name)).toThrow("ubuntu_checksum_invalid");
    expect(() => selectUbuntuChecksum(`${hash} *${name}\n${hash} *${name}\n`, name)).toThrow("ubuntu_checksum_invalid");
    expect(() => selectUbuntuChecksum(`bad *${name}\n`, name)).toThrow("ubuntu_checksum_invalid");
  });
  it("refuses archive paths that can leave their own empty extraction directory", () => {
    expect(() => validateUbuntuArchivePaths(["./", "./usr/", "./usr/bin/bash"])).not.toThrow();
    for (const unsafe of ["/etc/passwd", "../host", "./usr/../../host", "./usr/../host", "./usr\u0000bad"])
      expect(() => validateUbuntuArchivePaths([unsafe])).toThrow("ubuntu_archive_invalid");
  });
  it("projects only the private OS fixture into the installer, never the host root or cgroup", () => {
    const args = ubuntuInstallArguments("/scratch/ubuntu", "/vercel/node", "/scratch/install.mjs", "/scratch/config.json");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--as-pid-1");
    expect(args.some((value, index) => ["--bind", "--ro-bind"].includes(value) && args[index + 1] === "/")).toBe(false);
    expect(args).not.toContain("/sys/fs/cgroup");
    expect(args).not.toContain("/home/vercel-sandbox/zeros");
    expect(args).toContain("/scratch/ubuntu/usr");
    expect(args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2)).toEqual(["--chdir", "/"]);
    expect(args.some((value, index) => value === "--chmod" && args[index + 1] === "1777" && args[index + 2] === "/tmp")).toBe(true);
  });
});

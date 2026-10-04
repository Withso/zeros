import { copyFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BundleError, check, parseManifest, sha256 } from "./manifest";
import { runTool } from "./toolchain";

export type ClosureReport = {
  checks: string[];
  isolation: "mount_namespace_no_network";
  durationMs: number;
};
export async function runClosureProbes(
  runtime: string,
): Promise<ClosureReport> {
  const start = performance.now();
  const manifest = await readFile(path.join(runtime, "manifest.json"));
  parseManifest(manifest);
  const installed = `/opt/zeros-infra/r1-${sha256(manifest)}`;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "zeros-runtime-probe-"));
  try {
    const script = path.join(scratch, "probe.cjs");
    await copyFile(
      fileURLToPath(new URL("./probe.cjs", import.meta.url)),
      script,
    );
    const args = [
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "bwrap",
      "--unshare-user",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-uts",
      "--die-with-parent",
      "--new-session",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/usr",
      "/usr",
      "--symlink",
      "usr/bin",
      "/bin",
      "--symlink",
      "usr/sbin",
      "/sbin",
    ];
    for (const directory of ["/lib", "/lib64"]) {
      if (await stat(directory).catch(() => null))
        args.push("--ro-bind", directory, directory);
    }
    // This VM permits mount/network/user namespaces but not a new proc mount.
    // A read-only proc view supports native CLI self-discovery. No checkout,
    // HOME, /tmp, pnpm store or ambient Node resolution path is mounted.
    args.push(
      "--ro-bind",
      "/proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--dir",
      "/etc",
    );
    if (await stat("/etc/ld.so.cache").catch(() => null))
      args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
    args.push(
      "--ro-bind",
      runtime,
      installed,
      "--ro-bind",
      script,
      "/probe.cjs",
      "--chdir",
      `${installed}/worker`,
      "--clearenv",
      "--setenv",
      "HOME",
      "/tmp/home",
      "--setenv",
      "PATH",
      `${installed}/bin:/usr/bin:/bin`,
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--setenv",
      "TZ",
      "UTC",
      "--setenv",
      "TSX_DISABLE_CACHE",
      "1",
      "--setenv",
      "PLAYWRIGHT_BROWSERS_PATH",
      `${installed}/worker/design-browsers`,
      "--setenv",
      "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE",
      "ubuntu24.04-x64",
      `${installed}/bin/node`,
      "/probe.cjs",
      installed,
    );
    const output = await runTool(
      "setpriv",
      args,
      {
        cwd: scratch,
        env: { PATH: "/usr/bin:/bin", HOME: scratch },
        timeout: 180_000,
      },
      "closure_probes",
    );
    const lines = output.split("\n");
    const diagnostic = JSON.parse(lines.at(-1)!);
    check(
      diagnostic.ok === true &&
        diagnostic.failedChecks.length === 0 &&
        diagnostic.component === "bundle",
      "closure_probes",
    );
    const report = JSON.parse(lines.at(-2)!);
    check(
      Array.isArray(report.checks) &&
        report.checks.length > 0 &&
        report.checks.every(
          (name: unknown) => typeof name === "string" && /^[a-z_]+$/.test(name),
        ),
      "closure_probes",
    );
    return {
      checks: report.checks,
      isolation: "mount_namespace_no_network",
      durationMs: Math.round(performance.now() - start),
    };
  } catch (error) {
    // Preserve only a closed diagnostic from the probe when a native check fails.
    // Tool stderr is never returned to a release job.
    if (error instanceof BundleError) throw error;
    throw new BundleError("closure_probes");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

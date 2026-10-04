import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BundleError,
  canonicalJson,
  check,
  parseManifest,
  sha256,
} from "./manifest";
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
  const manifestSha256 = sha256(manifest);
  const runtimeId = `r1-${manifestSha256}`;
  const installed = `/opt/zeros-infra/${runtimeId}`;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "zeros-runtime-probe-"));
  try {
    const script = path.join(scratch, "probe.cjs");
    await copyFile(
      fileURLToPath(new URL("./probe.cjs", import.meta.url)),
      script,
    );
    // Imports that resolve R require the same v4 marker, descriptor and facade
    // as an installed runtime. These synthetic base/receipt/session identities
    // exist only in the disposable probe namespace, never in the artifact.
    const marker = path.join(scratch, "cloud-worker.json");
    const active = path.join(scratch, "active-runtime.json");
    await writeFile(
      marker,
      canonicalJson({
        backend: "cloud-worker",
        gid: 10001,
        profile: "zeros-cloud-worker-v4",
        uid: 10001,
        version: 4,
      }),
      { mode: 0o444, flag: "wx" },
    );
    await writeFile(
      active,
      canonicalJson({
        schema: "zeros.active-runtime/v1",
        runtimeId,
        manifestSha256,
        root: installed,
        baseCompatibilityId: `bc1-${"0".repeat(64)}`,
        installerReceiptSha256: "0".repeat(64),
        bootId: "00000000-0000-4000-8000-000000000000",
        supervisorSessionId: "00000000-0000-4000-8000-000000000001",
        cgroupRoot: "/sys/fs/cgroup/zeros-host.service",
      }),
      { mode: 0o600, flag: "wx" },
    );
    const args = [
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "bwrap",
      "--unshare-user",
      // Map the builder's ownership to namespace root without host privileges.
      "--uid",
      "0",
      "--gid",
      "0",
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
      "--tmpfs",
      "/home",
      "--dir",
      "/etc",
    );
    if (await stat("/etc/ld.so.cache").catch(() => null))
      args.push("--ro-bind", "/etc/ld.so.cache", "/etc/ld.so.cache");
    args.push(
      "--ro-bind",
      runtime,
      installed,
      "--dir",
      "/etc/zeros",
      "--ro-bind",
      marker,
      "/etc/zeros/cloud-worker.json",
      "--dir",
      "/run/zeros",
      "--ro-bind",
      active,
      "/run/zeros/active-runtime.json",
      "--dir",
      "/opt/zeros",
      "--symlink",
      "/opt/zeros",
      "/zeros",
      "--symlink",
      `../zeros-infra/${runtimeId}`,
      "/opt/zeros/current",
    );
    for (const name of ["bin", "worker", "manifest.json"])
      args.push("--symlink", `current/${name}`, `/opt/zeros/${name}`);
    for (const [name, target] of [
      ["logs", "/srv/zeros/log"],
      ["state", "/srv/zeros/state"],
    ])
      args.push("--symlink", target, `/opt/zeros/${name}`);
    args.push(
      "--ro-bind",
      script,
      "/probe.cjs",
      "--chdir",
      `${installed}/worker`,
      "--clearenv",
      "--setenv",
      "HOME",
      "/home/runtime-probe",
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
    if (error instanceof BundleError) {
      try {
        const stdout =
          (error as BundleError & { toolStdout?: string }).toolStdout ?? "";
        const diagnostic = JSON.parse(stdout.trim().split("\n").at(-1)!);
        if (
          diagnostic.schema === "zeros.diagnostic/v1" &&
          diagnostic.component === "bundle" &&
          diagnostic.stage === "closure" &&
          Array.isArray(diagnostic.failedChecks) &&
          diagnostic.failedChecks.length <= 31 &&
          diagnostic.failedChecks.every(
            (name: unknown) =>
              typeof name === "string" && /^[a-z_]+$/.test(name),
          )
        ) {
          Object.assign(error, {
            failedChecks: [
              ...new Set(["closure_probes", ...diagnostic.failedChecks]),
            ],
          });
        }
      } catch {
        /* A namespace/tool failure has no inner diagnostic. */
      }
      throw error;
    }
    throw new BundleError("closure_probes");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

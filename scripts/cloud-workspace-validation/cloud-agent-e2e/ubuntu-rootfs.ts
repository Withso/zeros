import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "tsup";
import { HarnessFailure } from "./assertions";
import { ubuntuFailureDiagnostic } from "./ubuntu-diagnostics";
export { ubuntuFailureDiagnostic } from "./ubuntu-diagnostics";

const execute = promisify(execFile);
const IMAGE = "ubuntu-base-24.04.5-base-amd64.tar.gz";
const ORIGIN = "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/";
export function selectUbuntuChecksum(published: string, name: string): string {
  const rows = published.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((row): row is RegExpExecArray => !!row && row[2] === name);
  if (rows.length !== 1) throw new HarnessFailure("ubuntu_checksum_invalid");
  return rows[0][1];
}
export function validateUbuntuArchivePaths(names: readonly string[]): void {
  if (!names.length || names.length > 100_000 || names.some(name => !name || name.startsWith("/") || /[\0\r\n]/.test(name) ||
    name.split("/").some(part => part === ".."))) throw new HarnessFailure("ubuntu_archive_invalid");
}
/** No host root/system/cgroup write mount exists in this package installer. */
export function ubuntuInstallArguments(root: string, node: string, entry: string, config: string): string[] {
  return ["--unshare-pid", "--as-pid-1", "--unshare-ipc", "--unshare-uts", "--cap-add", "ALL",
    ...["usr", "etc", "var"].flatMap(name => ["--bind", `${root}/${name}`, `/${name}`]),
    ...["bin", "sbin", "lib", "lib64"].flatMap(name => ["--symlink", `usr/${name}`, `/${name}`]),
    "--ro-bind", node, node, "--ro-bind", path.dirname(entry), "/scratch", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/tmp", "--chmod", "1777", "/tmp", "--dir", "/run", "--dir", "/root", "--dir", "/home",
    "--chdir", "/", "--", node, `/scratch/${path.basename(entry)}`, `/scratch/${path.basename(config)}`];
}
export class UbuntuFixtureFailure extends HarnessFailure {
  constructor(readonly bootstrap: ReturnType<typeof ubuntuFailureDiagnostic>) { super("ubuntu_package_install_failed"); }
}
async function download(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) throw new HarnessFailure("ubuntu_download_failed");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length;
    if (bytes > maxBytes) { await response.body.cancel().catch(() => {}); throw new HarnessFailure("ubuntu_download_failed"); }
    chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export async function prepareUbuntuRootfs(sourceRoot: string, scratch: string) {
  const directory = path.join(scratch, `ubuntu-${randomUUID()}`), root = path.join(directory, "rootfs");
  await mkdir(directory, { mode: 0o700 }); await mkdir(root, { mode: 0o700 });
  const expected = selectUbuntuChecksum((await download(`${ORIGIN}SHA256SUMS`, 64 * 1024)).toString("utf8"), IMAGE);
  const image = await download(`${ORIGIN}${IMAGE}`, 64 * 1024 * 1024);
  if (createHash("sha256").update(image).digest("hex") !== expected) throw new HarnessFailure("ubuntu_checksum_invalid");
  const archive = path.join(directory, IMAGE); await writeFile(archive, image, { mode: 0o600 });
  const listing = await execute("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
  validateUbuntuArchivePaths(listing.stdout.trimEnd().split("\n"));
  // Verified official archive, an exclusively created empty directory, and
  // tar's traversal checks. Downloaded programs execute only in the view below.
  await execute("tar", ["-xzf", archive, "--directory", root, "--no-same-owner", "--no-same-permissions"], { maxBuffer: 64 * 1024 });
  for (const name of ["usr", "etc", "var"]) {
    const directory = path.join(root, name), metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) throw new HarnessFailure("ubuntu_archive_invalid");
  }
  // Unlink a rootfs symlink before writing: no extracted absolute link can
  // redirect this host-side setup into a real /run or /etc file.
  const resolver = path.join(root, "etc/resolv.conf");
  await rm(resolver, { force: true }); await writeFile(resolver, await readFile("/etc/resolv.conf"), { flag: "wx" });
  const entry = path.join(directory, "install.mjs"), config = path.join(directory, "install.json");
  await build({ config: false, entry: { install: path.join(sourceRoot, "scripts/cloud-workspace-validation/cloud-agent-e2e/ubuntu-install.ts") },
    outDir: directory, format: ["esm"], platform: "node", target: "node24", splitting: false, outExtension: () => ({ js: ".mjs" }),
    noExternal: ["@zeros/protocol", "zod"], external: [/^node:/], silent: true });
  await writeFile(config, JSON.stringify({ outerMountNamespace: await readlink("/proc/self/ns/mnt"), outerPidNamespace: await readlink("/proc/self/ns/pid") }), { mode: 0o600 });
  let installed;
  try { installed = await execute("sudo", ["unshare", "--mount", "--propagation", "private", "--pid", "--fork", "--mount-proc", "/usr/bin/bwrap",
    ...ubuntuInstallArguments(root, process.execPath, entry, config)], { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, maxBuffer: 64 * 1024, timeout: 10 * 60_000 }); }
  catch (error) { throw new UbuntuFixtureFailure(ubuntuFailureDiagnostic(error as { stdout?: unknown; stderr?: unknown })); }
  const metadata = JSON.parse(installed.stdout) as { packageCount: number; packagesSha256: string };
  if (!Number.isSafeInteger(metadata.packageCount) || !/^[a-f0-9]{64}$/.test(metadata.packagesSha256)) throw new HarnessFailure("fixture_contract_invalid");
  const manifest = { schema: "zeros.source-ubuntu-fixture/v1", qualified: false, source: `${ORIGIN}${IMAGE}`, imageSha256: expected, ...metadata };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { root, manifest };
}

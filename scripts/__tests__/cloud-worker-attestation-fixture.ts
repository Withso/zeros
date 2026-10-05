import * as fs from "node:fs";
import path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as url from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as runtimeRoot from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";
import { cloudHostRuntimeProfile, cloudRuntimeProcessSecurityQualified } from "../cloud-workspace-validation/sandbox/cloud-runtime-profile.mjs";
import * as resources from "../cloud-workspace-validation/sandbox/cgroup-resources.mjs";
import * as admission from "../cloud-workspace-validation/sandbox/cloud-resource-admission.mjs";

const sandbox = path.resolve("scripts/cloud-workspace-validation/sandbox");
const layout = JSON.parse(fs.readFileSync(path.join(sandbox, "runtime-layout.json"), "utf8"));
export const proofPath = "/run/zeros/cloud-worker-admission.json";
export const activePath = "/run/zeros/active-runtime.json";
export const markerPath = "/etc/zeros/cloud-worker.json";
export const compatibilityPath = "/opt/zeros-bootstrap/compatibility.json";
export const digest = (bytes: string | Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

export function attestationFixture(version = 4) {
  const tree = cloudRuntimeFixture();
  if (version !== 4) fs.rmSync(tree.physical("/opt/zeros"), { recursive: true, force: true });
  let root = version === 4 ? tree.descriptor.root : "/opt/zeros-runtime";
  let worker = version === 4 ? `${root}/worker` : "/opt/zeros";
  const helpers = [
    "runtime-layout.json", "cloud-runtime-root.mjs", "cloud-runtime-profile.mjs", "cloud-engine-launcher.mjs",
    "cloud-engine-view.mjs", "cloud-engine-cgroup.mjs", "ensure-cloud-worker-supervisor.mjs",
    "cgroup-resources.mjs", "cloud-resource-admission.mjs", "image-build-contract.mjs",
    "cloud-setup-process.mjs", "consume-cloud-admission.mjs", "install-cloud-preview-links.mjs",
    "install-cloud-github-credential.mjs", "cloud-github-refresh-request.mjs", "cloud-git-askpass.mjs",
    "cloud-worker-supervisor.mjs", "setup-cloud-workspace.mjs", "attest-cloud-worker.mjs",
    "zeros-cloud-engine.apparmor",
  ];
  for (const helper of helpers) tree.write(`${root}/lib/zeros/${helper}`, "installed", 0o555);
  for (const file of ["bin/node", "bin/start-engine.sh", version === 4 ? "bin/cloud-engine-namespace" : "cloud-engine-namespace",
    version === 4 ? "bin/cloud-process-supervisor" : "cloud-process-supervisor"])
    tree.write(`${root}/${file}`, "installed", 0o555);
  for (const file of ["dist-engine/cli.js", "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
    "scripts/cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs"])
    tree.write(`${worker}/${file}`, "installed", 0o555);
  for (const file of ["/usr/bin/bwrap", "/usr/bin/setpriv"]) tree.write(file, "installed", 0o555);
  tree.write("/etc/apparmor.d/zeros-cloud-engine", "base policy");
  const compatibility = { schema: "zeros.base-compatibility/v1", arch: "x64", bootstrapProtocolVersion: 1,
    glibc: "2.39", os: { id: "ubuntu", versionId: "24.04" }, systemdMin: 254,
    artifactHostSuffixes: [".r2.cloudflarestorage.com"], supportedManifestSchemas: ["zeros.runtime-manifest/v1"],
    uids: { agent: 10001, capture: 10002, coordinator: 10004, engine: 10003 },
    protectedFiles: [{ mode: "0444", path: "/etc/apparmor.d/zeros-cloud-engine", sha256: digest("base policy") }] };
  tree.write(compatibilityPath, compatibility);
  const files: Record<string, unknown>[] = [];
  function inventory(directory: string) {
    for (const name of fs.readdirSync(tree.physical(directory))) {
      const file = `${directory}/${name}`, relative = file.slice(root.length + 1);
      if (relative === "manifest.json") continue;
      const stat = fs.lstatSync(tree.physical(file));
      if (stat.isDirectory()) {
        files.push({ path: relative, mode: "0755", type: "dir" });
        inventory(file);
      } else files.push({ path: relative, mode: "0555", type: "file", size: stat.size,
        sha256: digest(fs.readFileSync(tree.physical(file))) });
    }
  }
  inventory(root);
  files.sort((a, b) => Buffer.compare(Buffer.from(String(a.path)), Buffer.from(String(b.path))));
  const manifest = { schema: "zeros.runtime-manifest/v1", files,
    agents: { claude: { cli: "2.1.288", sdk: "0.3.288" }, codex: { package: "0.160.0" }, cursor: { sdk: "1.0.35" } },
    entrypoints: { node: "bin/node", setup: "lib/zeros/setup-cloud-workspace.mjs", startEngine: "bin/start-engine.sh",
      supervisor: "lib/zeros/cloud-worker-supervisor.mjs" },
    platform: { arch: "x64", libc: "glibc", minGlibc: "2.39", node: "22.23.1", nodeModulesAbi: 127, os: "linux" },
    protocols: { bootstrap: 1, engine: 20, setup: 2 }, source: { commit: "a".repeat(40), lockfileSha256: "b".repeat(64) } };
  if (version === 4) {
    tree.descriptor.manifestSha256 = digest(JSON.stringify(manifest));
    tree.descriptor.runtimeId = `r1-${tree.descriptor.manifestSha256}`;
    tree.descriptor.baseCompatibilityId = `bc1-${digest(JSON.stringify(compatibility))}`;
    const next = `/opt/zeros-infra/${tree.descriptor.runtimeId}`;
    fs.renameSync(tree.physical(root), tree.physical(next));
    tree.descriptor.root = root = next; worker = `${root}/worker`;
    fs.unlinkSync(tree.physical("/opt/zeros/current"));
    tree.link("/opt/zeros/current", `../zeros-infra/${tree.descriptor.runtimeId}`);
    tree.write(`${root}/manifest.json`, manifest);
  }
  const receipt = { schema: "zeros.runtime-install-receipt/v1", runtimeId: tree.descriptor.runtimeId,
    manifestSha256: tree.descriptor.manifestSha256, archiveSha256: "d".repeat(64),
    baseCompatibilityId: tree.descriptor.baseCompatibilityId, bootstrapVersion: 1,
    fileCount: files.filter(file => file.type === "file").length,
    expandedBytes: files.reduce((sum, file) => sum + Number(file.size ?? 0), 0), installedAt: "2026-10-04T00:00:00Z" };
  const receiptPath = `/srv/zeros/runtime-installs/${tree.descriptor.runtimeId}.json`;
  const updateReceipt = (value: unknown = receipt) => {
    tree.write(receiptPath, value, 0o600);
    tree.descriptor.installerReceiptSha256 = digest(fs.readFileSync(tree.physical(receiptPath)));
    tree.write(activePath, tree.descriptor, 0o600);
  };
  updateReceipt();
  const marker = version === 4 ? tree.marker : { ...tree.marker, version, profile: `zeros-cloud-worker-v${version}`,
    toolchain: { node: `${root}/bin/node`, bwrap: "/usr/bin/bwrap", setpriv: "/usr/bin/setpriv",
      supervisor: `${worker}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs` } };
  tree.write(markerPath, marker);
  if (version !== 4) tree.write("/etc/zeros/image-build.json", { version: 1, profile: marker.profile, runtimeLayout: layout });
  tree.write("/proc/sys/kernel/random/boot_id", tree.descriptor.bootId);
  tree.write("/proc/1/stat", `1 (fixture init) ${["S", ...Array(18).fill("0"), "12345"].join(" ")}`);
  tree.write("/proc/self/status", "Seccomp:\t2\nNoNewPrivs:\t1\n");
  tree.write("/proc/self/cgroup", "0::/ssh.scope\n");
  tree.write("/proc/meminfo", "MemTotal:       8388608 kB\n");
  if (version !== 4) {
    tree.write("/sys/fs/cgroup/cpu.max", "400000 100000");
    tree.write("/sys/fs/cgroup/memory.max", String(8 * 1024 ** 3));
    tree.write("/sys/fs/cgroup/pids.max", "4096");
  }
  const cgroup = tree.descriptor.cgroupRoot;
  tree.write(`${cgroup}/cgroup.controllers`, "cpu memory pids");
  tree.write(`${cgroup}/cgroup.subtree_control`, "cpu memory pids");
  tree.write(`${cgroup}/cgroup.procs`, "");
  const limits = { finite: true, cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096",
    hierarchy: [{ path: `${cgroup.slice("/sys/fs/cgroup".length)}/engine-32345678-1234-4234-8234-123456789abc`,
      cpuMax: "400000 100000", memoryMax: String(7 * 1024 ** 3), pidsMax: "4096" }] };
  const qualification = { version: 1, secure: true,
    identity: { secure: true, hostUid: 10003, namespaceUid: 0, noNewPrivs: 1, seccompMode: 2, resources: limits,
      checks: [{ name: "fixed-engine-user-namespace", status: "pass" }] },
    workload: { secure: true }, capture: { secure: true }, humanServices: { secure: true }, actorTools: { secure: true } };
  const setupQualification = { secure: true, unprivileged: true, detachedDescendantsRetired: true, timeoutRetired: true };
  const namespaces = Object.fromEntries(["mnt", "pid", "cgroup", "net", "ipc", "uts", "user"].map((name, i) => [name, `${name}:[${100 + i}]`]));
  tree.mkdir("/run/zeros"); fs.chmodSync(tree.physical("/run/zeros"), 0o700);
  const filesystem = { ...fs, ...tree.filesystem,
    realpathSync: (file: string) => file.startsWith(`${sandbox}/`) ? file : tree.filesystem.realpathSync(file),
    readFileSync: ((file: string | number, options?: fs.EncodingOption) => fs.readFileSync(typeof file === "number" ? file : tree.physical(file), options)) as typeof fs.readFileSync,
    readlinkSync: (file: string) => file.startsWith("/proc/self/ns/") ? namespaces[path.basename(file)] : tree.filesystem.readlinkSync(file),
    writeFileSync: (file: string, data: string | Buffer, options: fs.WriteFileOptions) => fs.writeFileSync(tree.physical(file), data, options),
    mkdirSync: (file: string, options: fs.MakeDirectoryOptions) => fs.mkdirSync(tree.physical(file), options),
    chmodSync: (file: string, mode: number) => fs.chmodSync(tree.physical(file), mode),
    unlinkSync: (file: string) => fs.unlinkSync(tree.physical(file)),
    renameSync: (from: string, to: string) => fs.renameSync(tree.physical(from), tree.physical(to)),
    rmSync: (file: string, options: fs.RmOptions) => fs.rmSync(tree.physical(file), options),
    statfsSync: () => ({ blocks: 20n * 1024n ** 3n, bsize: 1n, type: 0x63677270 }),
  };
  const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  let spawnOverride: ((file: string, args: string[]) => unknown) | undefined;
  let now = Date.parse("2026-10-04T00:00:00Z");
  function execute(name = "attest-cloud-worker.mjs", args?: string[]) {
    let stdout = "", stderr = "", exitCode = 0;
    const entry = path.join(sandbox, name), node = version === 4 ? `${root}/bin/node` : "/usr/local/bin/node";
    const token = "/run/zeros/.test-lock";
    if (!args) tree.write(token, "e".repeat(64), 0o600);
    const exit = {};
    const handlers = new Map<string, (error: unknown) => void>();
    const fakeProcess = { platform: "linux", arch: "x64", pid: 42, execPath: node,
      getuid: () => 0, geteuid: () => 0, getgid: () => 0, getegid: () => 0,
      argv: [node, entry, ...(args ?? ["--engine-lock-held", token])], env: {},
      stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } },
      exit: (code: number) => { exitCode = code; throw exit; }, exitCode: 0,
      on: (event: string, handler: (error: unknown) => void) => { handlers.set(event, handler); },
    };
    const resolver = runtimeRoot.createCloudRuntimeResolver({ filesystem, executable: () => node, isEngine: () => false });
    const cache = new Map<string, unknown>();
    const spawnSync = (file: string, childArgs: string[], options: Record<string, unknown>) => {
      calls.push({ file, args: childArgs, options });
      const override = spawnOverride?.(file, childArgs);
      if (override) return override;
      const output = childArgs[0]?.endsWith("cloud-engine-launcher.mjs") || childArgs.includes("--cloud-worker")
        ? JSON.stringify(qualification) : childArgs[0]?.endsWith("cloud-setup-process.mjs") ? JSON.stringify(setupQualification)
          : file === "/usr/bin/findmnt" ? JSON.stringify({ filesystems: [{ target: childArgs.at(-1), fstype: "fixture", options: "ro" }] }) : "fixture-version";
      return { status: 0, signal: null, stdout: output, stderr: "" };
    };
    function load(file: string): unknown {
      if (cache.has(file)) return cache.get(file);
      const exports = {};
      cache.set(file, exports);
      const source = fs.readFileSync(file, "utf8").replaceAll("import.meta.url", JSON.stringify(url.pathToFileURL(file).href));
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      const require = (id: string): unknown => {
        if (id === "node:fs") return filesystem;
        if (id === "node:crypto") return { ...crypto, randomBytes: (count: number) => Buffer.alloc(count, 1) };
        if (id === "node:os") return { ...os, availableParallelism: () => 4 };
        if (id === "node:path") return path;
        if (id === "node:url") return url;
        if (id === "node:util") return { TextDecoder };
        if (id === "node:child_process") return { spawnSync };
        if (id === "./cloud-runtime-root.mjs") return { ...runtimeRoot, resolveCloudRuntime: resolver.resolve };
        if (id === "./runtime-layout.json") return layout;
        if (id === "./cgroup-resources.mjs") return resources;
        if (id === "./cloud-resource-admission.mjs") return admission;
        if (id === "./cloud-runtime-profile.mjs") return { cloudRuntimeProcessSecurityQualified,
          readCloudHostRuntimeProfile: () => cloudHostRuntimeProfile(JSON.parse(filesystem.readFileSync(markerPath, "utf8"))) };
        if (id === "./image-build-contract.mjs") return { cloudImageBuildMatchesInstallation: () => true,
          cloudImageBaseOrigin: () => ({ baseImage: "fixture", baseOrigin: {} }), readCloudImageNativeInventory: () => ({}) };
        if (id.startsWith("./")) return load(path.resolve(path.dirname(file), id));
        throw new Error(`Unexpected fixture import: ${id}`);
      };
      runInNewContext(compiled, { require, exports, module: { exports }, process: fakeProcess, Buffer, TextDecoder,
        Date: class extends Date { static now() { return now; } }, setTimeout, clearTimeout }, { timeout: 5000 });
      return exports;
    }
    try { load(entry); } catch (error) {
      if (error !== exit) {
        const handler = handlers.get("uncaughtException");
        if (!handler) throw error;
        try { handler(error); } catch (failure) { if (failure !== exit) throw failure; }
      }
    }
    return { stdout, stderr, exitCode: exitCode || fakeProcess.exitCode };
  }
  return { ...tree, root, worker, receipt, receiptPath, manifest, compatibility, marker, filesystem,
    qualification, setupQualification, namespaces, limits, calls, execute, updateReceipt,
    setSpawn: (override: typeof spawnOverride) => { spawnOverride = override; },
    advance: (milliseconds: number) => { now += milliseconds; } };
}

// Test-only VM IO adapter. All VM paths live under a disposable fixture root;
// the only real kernel observation is flock on that fixture's own setup lock.
const fs = require("node:fs");
const native = { ...fs };
const child = require("node:child_process");
const spawnSync = child.spawnSync;
const moduleApi = require("node:module");
const path = require("node:path");
const url = require("node:url");
const nativeFileURLToPath = url.fileURLToPath;
const node = process.execPath;
const adapter = __filename;
const configPath = process.argv[2];
const config = JSON.parse(native.readFileSync(configPath, "utf8"));
const invocation = process.argv.slice(3);
const script = invocation[0];
const role = invocation[1] ?? "orchestrator";
const service = config.runtime.cgroupRoot;
const host = `${service}/host`;
const lockPath = "/run/zeros/setup.lock";
const descriptors = new Map(role === "orchestrator" ? [] : [[3, lockPath]]);
let membership = "0::/system.slice/ssh.service\n";
let changedHost = false;
const virtual = file => typeof file === "string" && file.startsWith("/") && !file.startsWith(config.root);
const physical = file => virtual(file) ? path.join(config.root, file) : file;
const owners = () => JSON.parse(native.readFileSync(config.owners, "utf8"));
const owner = (stat, file) => Object.assign(stat, owners()[file] ?? { uid: 0, gid: 0 });
const record = value => native.appendFileSync(config.events, `${JSON.stringify({ role, ...value })}\n`);
const setOwner = (file, uid, gid) => {
  const current = owners(); current[file] = { uid, gid };
  native.writeFileSync(config.owners, JSON.stringify(current));
};

for (const name of ["existsSync", "mkdirSync", "mkdtempSync", "readdirSync", "chmodSync", "rmSync", "unlinkSync"])
  fs[name] = (file, ...args) => native[name](physical(file), ...args);
fs.lstatSync = file => owner(native.lstatSync(physical(file)), file);
fs.realpathSync = file => {
  const resolved = native.realpathSync(physical(file));
  return virtual(file) ? resolved.slice(config.root.length) || "/" : resolved;
};
fs.readlinkSync = file => config.links[file] ?? native.readlinkSync(physical(file));
fs.openSync = (file, flags, mode) => {
  if (file === `${host}/cgroup.procs` && flags & fs.constants.O_WRONLY && config.condition === "changed-host" && !changedHost) {
    changedHost = true;
    native.renameSync(physical(host), physical(`${host}-original`));
    native.mkdirSync(physical(host), { mode: 0o755 });
    native.writeFileSync(physical(`${host}/cgroup.procs`), "17\n", { mode: 0o600 });
  }
  const fd = native.openSync(physical(file), flags, mode);
  descriptors.set(fd, file); return fd;
};
fs.closeSync = fd => { descriptors.delete(fd); return native.closeSync(fd); };
fs.fstatSync = fd => owner(native.fstatSync(fd), descriptors.get(fd));
fs.fchownSync = (fd, uid, gid) => setOwner(descriptors.get(fd), uid, gid);
fs.lchownSync = fs.chownSync = setOwner;
fs.readFileSync = (file, ...args) => {
  if (file === "/proc/self/cgroup") return args[0] === "utf8" ? membership : Buffer.from(membership);
  const target = typeof file === "string" && file.startsWith("/proc/self/fdinfo/") ? file : physical(file);
  return native.readFileSync(target, ...args);
};
fs.readSync = (fd, buffer, offset, length, position) => {
  if (descriptors.get(fd) === "/proc/self/cgroup") {
    const bytes = Buffer.from(membership);
    const current = config.readOffsets[fd] ?? 0;
    const count = bytes.copy(buffer, offset, current, Math.min(bytes.length, current + length));
    config.readOffsets[fd] = current + count; return count;
  }
  return native.readSync(fd, buffer, offset, length, position);
};
fs.writeFileSync = (file, ...args) => native.writeFileSync(physical(file), ...args);
fs.renameSync = (source, target) => {
  native.renameSync(physical(source), physical(target));
  const current = owners();
  if (current[source]) { current[target] = current[source]; delete current[source]; }
  native.writeFileSync(config.owners, JSON.stringify(current));
};
fs.writeSync = (fd, bytes, ...args) => {
  if (descriptors.get(fd) === `${host}/cgroup.procs`) {
    record({ kind: "placement", bytes });
    if (bytes === "0") membership = "0::/system.slice/zeros-host.service/host\n";
    return Buffer.byteLength(bytes);
  }
  return native.writeSync(fd, bytes, ...args);
};
fs.statfsSync = file => {
  const original = file.startsWith("/proc/self/fd/") ? descriptors.get(Number(path.basename(file))) ?? file : file;
  return { type: original.startsWith("/sys/fs/cgroup") ? 0x63677270 : original.startsWith("/proc") ? 0x9fa0 : 0xef53 };
};
url.fileURLToPath = (...args) => {
  const result = nativeFileURLToPath(...args);
  return result.startsWith(config.root) ? result.slice(config.root.length) : result;
};
const packageFile = name => `${config.runtime.root}/worker/node_modules/${name}`;
moduleApi.createRequire = () => {
  const requireFixture = name => {
    if (name === "better-sqlite3") return () => ({ prepare: () => ({ get: () => ({ abi: 127 }) }), close() {} });
    if (name === "node-pty") return { spawn() {} };
    if (name.endsWith("/zeros-engine.ts")) return { ZerosEngine() {} };
    return { fixture: true };
  };
  requireFixture.resolve = packageFile;
  requireFixture.cache = { [packageFile("node-pty/pty.node")]: {} };
  return requireFixture;
};
const ok = stdout => ({ status: 0, signal: null, stdout, stderr: "" });
child.spawnSync = (executable, args, options) => {
  if (executable === "/usr/bin/flock") return spawnSync(executable, args, options);
  if (executable === "/usr/bin/unshare") {
    record({ kind: "offline-command", executable, args, membership, lockForwarded: options.stdio.length === 4 });
    return spawnSync(node, [adapter, configPath, ...args.slice(3)], options);
  }
  if (executable === config.runtime.node && ["/runtime-self-test.mjs", "/cloud-engine-launcher.mjs"].some(name => args[0].endsWith(name))) {
    record({ kind: "role-command", executable, args, membership, lockForwarded: options.stdio.length === 4 });
    return spawnSync(node, [adapter, configPath, ...args], options);
  }
  if (executable === "/usr/bin/python3") return ok(args.at(-1) === "status" ? JSON.stringify({
    schema: "zeros.base-status/v1", baseCompatibilityId: config.runtime.baseCompatibilityId,
    bootId: config.runtime.bootId, currentRuntimeId: config.runtime.runtimeId, hostState: "idle",
  }) : "");
  if (executable === config.runtime.node && args.at(-1) === "--help") {
    record({ kind: "engine-load", membership }); return ok("Usage: fixture\n");
  }
  if (executable.endsWith("/claude")) return ok("1.2.3 (Claude Code)\n");
  if (executable.endsWith("/codex")) return ok("codex-cli 1.2.3\n");
  throw new Error("Unexpected child command in isolated self-test fixture");
};
for (const name of ["getuid", "geteuid", "getgid", "getegid"]) process[name] = () => 0;
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "arch", { value: "x64" });
Object.defineProperty(process, "execPath", { value: config.runtime.node });
process.argv = [config.runtime.node, ...invocation];
moduleApi.syncBuiltinESMExports();
record({ kind: "entry", membership });

(async () => {
  const cgroup = await import(url.pathToFileURL(physical(`${config.runtime.root}/lib/zeros/cloud-engine-cgroup.mjs`)));
  cgroup.CloudEngineCgroup.prototype.prepare = function () {
    record({ kind: "scope.prepare", membership });
    // Reaching the real launcher boundary is this fixture's sole positive
    // claim. Do not manufacture a successful native qualification report.
    throw new Error("Fixture stopped at actual scope.prepare boundary");
  };
  await import(url.pathToFileURL(physical(script)));
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

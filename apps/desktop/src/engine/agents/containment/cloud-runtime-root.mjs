import * as nativeFs from "node:fs";
import { TextDecoder } from "node:util";
const { closeSync, constants, statfsSync, openSync, readSync } = nativeFs;
import path from "node:path";

const PROC_SUPER_MAGIC = 0x9fa0;
const OVERFLOW_ID = 65534;

/** Archived maps remain readable. New execution maps only the non-root engine
 * identity; VM root and the retired worker identities are not mapped. */
export function cloudEngineIdMapVersion(source) {
  if (typeof source !== "string" || source.length > 256) return null;
  const rows = source.trim().split("\n");
  if (rows.length !== 1 && rows.length !== 2 && rows.length !== 3) return null;
  const parsed = rows.map((row) => {
    if (!/^\s*\d+\s+\d+\s+\d+\s*$/.test(row)) return null;
    return row.trim().split(/\s+/).map(Number);
  });
  if (rows.length === 1 && parsed[0]?.join(",") === "10003,10003,1") return 5;
  if (parsed[0]?.join(",") !== "0,10003,1") return null;
  if (rows.length === 1) return 4;
  if (parsed[1]?.join(",") !== "10001,10001,2") return null;
  return rows.length===2?2:parsed[2]?.join(",")==="10004,10004,1"?3:null;
}

export function isCloudEngineIdMap(source) {
  return cloudEngineIdMapVersion(source)!==null;
}

function readProc(file, maximum) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (statfsSync(`/proc/self/fd/${descriptor}`).type !== PROC_SUPER_MAGIC)
      throw new Error("Cloud namespace evidence is not procfs");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(
        descriptor,
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!read) break;
      size += read;
    }
    if (size > maximum)
      throw new Error("Cloud namespace evidence is too large");
    return buffer.toString("utf8", 0, size);
  } finally {
    closeSync(descriptor);
  }
}

export function hasCloudEngineUserNamespace(version) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 10003 ||
    process.geteuid?.() !== 10003 ||
    process.getgid?.() !== 10003 ||
    process.getegid?.() !== 10003
  )
    return false;
  try {
    return hasCloudIdentityMap(version) &&
      isCloudEngineSecurityStatus(readProc("/proc/self/status", 65536));
  } catch { return false; }
}

/** Closed kernel status contract for the current engine, never child input. */
export function isCloudEngineSecurityStatus(source) {
  if (typeof source !== "string" || source.length > 65536 || source.includes("\0")) return false;
  const values = new Map();
  for (const line of source.split("\n")) {
    const match = /^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):[ \t]*(\S+)[ \t]*$/.exec(line);
    if (!match) continue;
    if (values.has(match[1])) return false;
    values.set(match[1], match[2]);
  }
  return ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(key => values.get(key) === "0000000000000000") &&
    values.get("NoNewPrivs") === "1" && values.get("Seccomp") === "2";
}

function hasCloudIdentityMap(version) {
  try {
    const uidVersion=cloudEngineIdMapVersion(readProc("/proc/self/uid_map",256));
    const gidVersion=cloudEngineIdMapVersion(readProc("/proc/self/gid_map",256));
    return uidVersion === 5 && uidVersion === gidVersion &&
      uidVersion === cloudProfileIdentityMapVersion(version ?? 4);
  } catch {
    return false;
  }
}

function mountPath(value) {
  // These are the only escapes in a kernel mountinfo pathname. Never accept a
  // partial or unknown escape as another spelling of an authority path.
  if (/\\(?!040|011|012|134)/.test(value)) return null;
  return value.replace(/\\(040|011|012|134)/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

export function isReadOnlyCloudMount(candidate, source) {
  if (
    typeof candidate !== "string" ||
    !path.isAbsolute(candidate) ||
    path.resolve(candidate) !== candidate ||
    candidate.includes("\0") ||
    typeof source !== "string" ||
    source.length > 2 * 1024 * 1024
  )
    return false;
  let closest = null;
  for (const line of source.trim().split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 4) return false;
    const mount = mountPath(fields[4]);
    if (!mount || !path.isAbsolute(mount) || path.resolve(mount) !== mount)
      return false;
    if (
      candidate !== mount &&
      mount !== "/" &&
      !candidate.startsWith(`${mount}/`)
    )
      continue;
    // A stacked mount at the same pathname is ambiguous without resolving its
    // mount ID from the pinned descriptor. Fail closed for that rare case.
    if (closest?.mount === mount) return false;
    if (!closest || mount.length > closest.mount.length)
      closest = { mount, readOnly: fields[5].split(",").includes("ro") };
  }
  return closest?.readOnly === true;
}

/** The host launcher attests physical root ownership BEFORE entering the
 * namespace and locks these mounts by crossing into a less privileged mount
 * namespace. There, host root is intentionally unmapped and stat reports the
 * overflow ID. This is a check of that admitted view, not a substitute for the
 * launcher's physical ownership/image attestation. Never admit an overflow
 * owner in an ordinary local process or on a writable mount. */
export function isCloudDeploymentOwner(candidate, uid) {
  if (uid === 0) return true;
  if (uid !== OVERFLOW_ID || !hasCloudEngineUserNamespace()) return false;
  try {
    return isReadOnlyCloudMount(
      candidate,
      readProc("/proc/self/mountinfo", 2 * 1024 * 1024),
    );
  } catch {
    return false;
  }
}

export function cloudProfileIdentityMapVersion(version) {
  return version === 4 ? 5 : null;
}

const MARKER = "/etc/zeros/cloud-worker.json";
const ACTIVE = "/run/zeros/active-runtime.json";
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const invalidRuntime = () => new Error("Cloud runtime descriptor or installation is invalid");
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

/** No normalization of an authority path: alternate spellings are rejected. */
export function isCloudRuntimeCgroupRoot(value) {
  return typeof value === "string" && value.length <= 4096 &&
    /^\/sys\/fs\/cgroup\/(?:[A-Za-z0-9_.@-]+\/)*zeros-host\.service$/.test(value) &&
    path.resolve(value) === value;
}

export function parseCloudActiveRuntime(value) {
  if (!exactKeys(value, ["schema", "runtimeId", "manifestSha256", "root", "baseCompatibilityId",
    "installerReceiptSha256", "bootId", "supervisorSessionId", "cgroupRoot"]) ||
    value.schema !== "zeros.active-runtime/v1" || typeof value.manifestSha256 !== "string" || !DIGEST.test(value.manifestSha256) ||
    value.runtimeId !== `r1-${value.manifestSha256}` ||
    value.root !== `/opt/zeros-infra/${value.runtimeId}` ||
    typeof value.baseCompatibilityId !== "string" || !/^bc1-[a-f0-9]{64}$/.test(value.baseCompatibilityId) ||
    typeof value.installerReceiptSha256 !== "string" || !DIGEST.test(value.installerReceiptSha256) ||
    typeof value.bootId !== "string" || !UUID.test(value.bootId) ||
    typeof value.supervisorSessionId !== "string" || !UUID.test(value.supervisorSessionId) ||
    !isCloudRuntimeCgroupRoot(value.cgroupRoot)) throw invalidRuntime();
  return Object.freeze({ ...value });
}

export function cloudActiveRuntimeDescriptor(runtime) {
  if (runtime?.profile !== "v4") throw invalidRuntime();
  return parseCloudActiveRuntime(Object.fromEntries([
    "schema", "runtimeId", "manifestSha256", "root", "baseCompatibilityId", "installerReceiptSha256",
    "bootId", "supervisorSessionId", "cgroupRoot",
  ].map(name => [name, runtime[name]])));
}

export function validateCloudRuntimeMarker(value, projection = false) {
  if (!exactKeys(value, ["backend", "gid", "profile", "uid", "version", ...(projection ? ["toolchain"] : [])]) ||
    value.version !== 4 || value.backend !== "cloud-worker" || value.profile !== "zeros-cloud-worker-v4" ||
    !(value.uid === 10001 && value.gid === 10001 || projection &&
      (value.uid === 0 && value.gid === 0 || value.uid === 10003 && value.gid === 10003))) throw invalidRuntime();
  if (projection && (!exactKeys(value.toolchain, value.uid === 10001 ? ["bwrap", "node", "setpriv", "supervisor"] : ["node", "supervisor"]) ||
    Object.values(value.toolchain).some(file => typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes("\0"))))
    throw invalidRuntime();
  return value;
}

function parseDocument(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // JSON.parse alone silently accepts duplicate keys. Scan strings before
  // parsing so even escaped spellings of a duplicate authority key fail.
  const objects = [];
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "{") objects.push(new Set());
    else if (char === "}") objects.pop();
    else if (char === '"') {
      const start = index++;
      for (; index < source.length; index++) {
        if (source[index] === "\\") index++;
        else if (source[index] === '"') break;
      }
      let next = index + 1;
      while (/\s/.test(source[next] ?? "") && next < source.length) next++;
      if (source[next] === ":") {
        const key = JSON.parse(source.slice(start, index + 1));
        const keys = objects.at(-1);
        if (!keys || !/^[\x20-\x7e]+$/.test(key) || keys.has(key)) throw invalidRuntime();
        keys.add(key);
      }
    }
  }
  return JSON.parse(source);
}

function runtimePaths(descriptor) {
  const root = descriptor.root;
  const workerRoot = `${root}/worker`;
  const libRoot = `${root}/lib/zeros`, binRoot = `${root}/bin`;
  const helperNames = {
    setup: "setup-cloud-workspace.mjs", attester: "attest-cloud-worker.mjs",
    supervisor: "cloud-worker-supervisor.mjs", ensureSupervisor: "ensure-cloud-worker-supervisor.mjs",
    launcher: "cloud-engine-launcher.mjs", setupProcess: "cloud-setup-process.mjs",
    profile: "cloud-runtime-profile.mjs", consumeAdmission: "consume-cloud-admission.mjs",
    gitAskpass: "cloud-git-askpass.mjs", installPreviewLinks: "install-cloud-preview-links.mjs",
    installGithubCredential: "install-cloud-github-credential.mjs", githubRefreshRequest: "cloud-github-refresh-request.mjs",
  };
  return Object.freeze({
    ...descriptor, profile: "v4", root, workerRoot, libRoot, binRoot,
    node: `${binRoot}/node`, startEngine: `${binRoot}/start-engine.sh`,
    engineNamespace: `${binRoot}/cloud-engine-namespace`,
    processSupervisor: `${binRoot}/cloud-process-supervisor`,
    cgroupRoot: descriptor.cgroupRoot,
    helpers: Object.freeze(Object.fromEntries(Object.entries(helperNames).map(([key, name]) => [key, `${libRoot}/${name}`]))),
  });
}

/** Injectable filesystem operations are for isolated tests, never environment
 * or request input. Production callers use the argument-free singleton below. */
export function createCloudRuntimeResolver({
  filesystem = nativeFs,
  isOwner = isCloudDeploymentOwner,
  isReadOnly = file => {
    // Unreadable mount evidence (for example no procfs) never proves a
    // read-only projection; the caller then rejects the runtime fail-closed.
    let mountinfo;
    try { mountinfo = readProc("/proc/self/mountinfo", 2 * 1024 * 1024); } catch { return false; }
    return isReadOnlyCloudMount(file, mountinfo);
  },
  isEngine = () => hasCloudEngineUserNamespace(4),
  executable = () => process.execPath,
} = {}) {
  let resolved, childResolved;
  function assertPath(file, directory = false, owns = isOwner) {
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file ||
      file.includes("\0") || filesystem.realpathSync(file) !== file)
      throw new Error("Cloud runtime path is not canonical");
    for (let current = file; ; current = path.dirname(current)) {
      const stat = filesystem.lstatSync(current);
      if (stat.isSymbolicLink() || !owns(current, stat.uid) || (stat.mode & 0o022) ||
        (current === file && !directory ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()))
        throw invalidRuntime();
      if (current === "/") break;
    }
  }
  function readDocument(file, maximum, owns = isOwner) {
    assertPath(file, false, owns);
    const fd = filesystem.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = filesystem.fstatSync(fd), current = filesystem.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || !isOwner(file, stat.uid) || (stat.mode & 0o022) ||
        stat.dev !== current.dev || stat.ino !== current.ino || stat.size < 2 || stat.size > maximum)
        throw invalidRuntime();
      if (file === ACTIVE && ((stat.mode & 0o7000) || (stat.mode & 0o777) !== 0o600 &&
        !((stat.mode & 0o333) === 0 && isReadOnly(file)) ||
        isEngine() && (stat.uid !== OVERFLOW_ID || !isReadOnly(file)))) throw invalidRuntime();
      const buffer = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = filesystem.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size !== stat.size || size > maximum) throw invalidRuntime();
      return parseDocument(buffer.subarray(0, size));
    } finally { filesystem.closeSync(fd); }
  }
  function assertLink(file, target) {
    assertPath(path.dirname(file), true);
    const stat = filesystem.lstatSync(file);
    if (!stat.isSymbolicLink() || !isOwner(file, stat.uid) || filesystem.readlinkSync(file) !== target)
      throw invalidRuntime();
  }
  function assertFacade(runtime) {
    assertPath("/opt/zeros", true);
    assertLink("/zeros", "/opt/zeros");
    assertLink("/opt/zeros/current", `../zeros-infra/${runtime.runtimeId}`);
    for (const name of ["bin", "worker", "manifest.json"]) assertLink(`/opt/zeros/${name}`, `current/${name}`);
    assertLink("/opt/zeros/logs", "/srv/zeros/log");
    assertLink("/opt/zeros/state", "/srv/zeros/state");
    try {
      const target = filesystem.readlinkSync("/opt/zeros/previous");
      if (!/^\.\.\/zeros-infra\/r1-[a-f0-9]{64}$/.test(target)) throw invalidRuntime();
      assertLink("/opt/zeros/previous", target);
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  function inside(root, file) { return file === root || file.startsWith(`${root}/`); }
  function packagePath(file, runtime = resolve()) {
    if (typeof file !== "string" || path.resolve(file) !== file || !inside(runtime.workerRoot, file)) throw invalidRuntime();
    // Resolve one link at a time. A final realpath-only check misses a chain
    // that escapes the installation and then comes back into the tree.
    let pending = file.slice(runtime.workerRoot.length).split("/").filter(Boolean);
    let current = runtime.workerRoot, links = 0;
    const linkRoot = runtime.root;
    assertPath(current, true);
    while (pending.length) {
      const component = pending.shift();
      if (component === "" || component === ".") continue;
      if (component === "..") {
        const parent = path.dirname(current);
        if (!inside(linkRoot, parent)) throw invalidRuntime();
        current = parent;
        continue;
      }
      current = path.join(current, component);
      const stat = filesystem.lstatSync(current);
      if (!isOwner(current, stat.uid)) throw invalidRuntime();
      if (stat.isSymbolicLink()) {
        const target = filesystem.readlinkSync(current);
        if (!target || path.isAbsolute(target) || target.includes("\0") || ++links > 40) throw invalidRuntime();
        // Follow each raw component before a later '..'. Lexical normalization
        // would erase an intervening symlink and could validate a different file.
        pending = [...target.split("/"), ...pending];
        current = path.dirname(current);
      } else if ((stat.mode & 0o022) ||
        (pending.length ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw invalidRuntime();
    }
    assertPath(current);
    return current;
  }
  function resolve() {
    if (resolved) return resolved;
    const pinnedNode = /^\/opt\/zeros-infra\/r1-[a-f0-9]{64}\/bin\/node$/.test(executable()) ? executable() : null;
    let hasMarker = false;
    try { filesystem.lstatSync(MARKER); hasMarker = true; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    // A dangling link is a present, invalid marker, never an absent marker.
    const marker = hasMarker ? readDocument(MARKER, 4096) : undefined;
    // This resolver is cloud-only. Local engines select their Local backend
    // through an absent loadCloudWorkerConfiguration marker and never call it.
    if (marker === undefined) throw invalidRuntime();
    // The host/projection marker contract is intentionally checked separately
    // from the descriptor; matching kernel UID maps never select a profile.
    const projection = isEngine();
    validateCloudRuntimeMarker(marker, projection);
    // The engine view mounts its private 0700 /run/zeros tmpfs, owned by the
    // fixed engine identity, around the read-only root descriptor bind. Only
    // that parent may be engine-owned; the descriptor itself stays root's.
    const descriptorOwner = (candidate, uid) => isOwner(candidate, uid) ||
      projection && marker.uid === 10003 && uid === 10003 && candidate === path.dirname(ACTIVE);
    const descriptor = parseCloudActiveRuntime(readDocument(ACTIVE, 16384, descriptorOwner));
    const runtime = runtimePaths(descriptor);
    if (pinnedNode && pinnedNode !== runtime.node) throw invalidRuntime();
    if (projection && (marker.uid !== 10003 || marker.gid !== 10003 || !isReadOnly(MARKER) || marker.toolchain.node !== runtime.node ||
      marker.toolchain.supervisor !== `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`)) throw invalidRuntime();
    assertPath(runtime.root, true);
    assertPath(runtime.workerRoot, true);
    assertPath(runtime.libRoot, true);
    assertFacade(runtime);
    // The raw immutable base marker remains a reader contract. Current runtime
    // assets use the Host supervisor even before entering the engine view.
    const hostSupervisor = `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`;
    for (const file of [runtime.node, runtime.startEngine, runtime.engineNamespace, hostSupervisor,
      `${runtime.workerRoot}/dist-engine/cli.js`, `${runtime.root}/manifest.json`, runtime.helpers.supervisor, runtime.helpers.setup]) assertPath(file);
    for (const file of [runtime.node, runtime.startEngine, runtime.engineNamespace])
      if (!(filesystem.lstatSync(file).mode & 0o111)) throw invalidRuntime();
    return resolved = runtime;
  }
  const childOwner = (file, uid) => isOwner(file, uid) || uid === OVERFLOW_ID &&
    hasCloudIdentityMap(4) && isReadOnly(file);
  function assertChildPath(file, directory = false) {
    assertPath(file, directory, childOwner);
  }
  function resolveChild() {
    if (childResolved) return childResolved;
    const node = executable();
    const match = /^\/opt\/zeros-infra\/(r1-[a-f0-9]{64})\/bin\/node$/.exec(node);
    if (!match) throw invalidRuntime();
    const runtime = runtimePaths({ root: path.dirname(path.dirname(node)), runtimeId: match[1] });
    // Same-user children keep the exact admitted map. Unmapped VM root is
    // accepted only on the inherited read-only deployment view.
    assertChildPath(runtime.root, true);
    assertChildPath(runtime.workerRoot, true);
    assertChildPath(runtime.node);
    if (!(filesystem.lstatSync(runtime.node).mode & 0o111)) throw invalidRuntime();
    return childResolved = runtime;
  }
  return Object.freeze({ resolve, resolveChild, assertPath, assertChildPath, packagePath });
}

const runtimeResolver = createCloudRuntimeResolver();
/** The only production runtime selector. It never consumes argv or env. */
export const resolveCloudRuntime = () => runtimeResolver.resolve();
/** Only for children whose parent selected their physical Node executable. */
export const resolveCloudRuntimeChild = () => runtimeResolver.resolveChild();
export const assertCloudRuntimePath = (file, directory = false) => runtimeResolver.assertPath(file, directory);
export const assertCloudRuntimeChildPath = (file, directory = false) => runtimeResolver.assertChildPath(file, directory);
export const resolveCloudRuntimePackagePath = file => runtimeResolver.packagePath(file);

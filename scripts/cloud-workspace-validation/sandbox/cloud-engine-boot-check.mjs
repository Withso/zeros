#!/usr/bin/env node
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudEngineIdMapVersion, isReadOnlyCloudMount, resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { cloudEnginePrivilegeStatus } from "./cloud-engine-privilege.mjs";
import { qualifyCloudEngineResources } from "./cloud-engine-resource-check.mjs";
import { loadCloudWorkloadCustody, inspectCloudWorkloadTree } from "../../../apps/desktop/src/engine/agents/containment/cloud-workload-cgroup.mjs";

const fail = () => { throw new Error("Cloud current boot checks refused"); };
const require = value => { if (!value) fail(); };
const sameScope = (a, b) => a?.directory === b?.directory && a?.dev === b?.dev && a?.ino === b?.ino;
const native = {
  identity: () => ({ pid: process.pid, uid: process.getuid?.(), euid: process.geteuid?.(), gid: process.getgid?.(), egid: process.getegid?.() }),
  read: file => fs.readFileSync(file, "utf8"), metadata: file => fs.lstatSync(file), realpath: file => fs.realpathSync(file),
  filesystem: file => fs.statfsSync(file).type,
  rootCredentialDenied: () => {
    try { fs.accessSync("/proc/1/root/etc/shadow", fs.constants.R_OK); return false; }
    catch (error) { return ["EACCES", "EPERM"].includes(error?.code); }
  },
  resources: qualifyCloudEngineResources, custody: runtime => loadCloudWorkloadCustody(runtime.cgroupRoot),
  census: custody => inspectCloudWorkloadTree(custody),
};
const nativeStorage = new Set([0xef53, 0x58465342, 0x9123683e, 0x794c7630]);
function mountTargets(source) {
  require(typeof source === "string" && source.length <= 2 * 1024 * 1024 && !source.includes("\0"));
  const result = new Set();
  for (const line of source.trim().split("\n")) {
    const fields = line.split(" "), separator = fields.indexOf("-");
    require(separator >= 6 && fields.length >= separator + 4 && !/\\(?!040|011|012|134)/.test(fields[4]));
    const target = fields[4].replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    require(path.isAbsolute(target) && path.resolve(target) === target && !result.has(target));
    result.add(target);
  }
  return result;
}

/** Read the actual executing process and its fixed view. IO ports are for
 * portable kernel fixtures, never selected by a request or an environment.
 * No functional tools, descendant stress test or TypeScript loader is used. */
export function checkCloudEngineBoot(runtime = resolveCloudRuntime(), io = native) {
  require(runtime.profile === "v4");
  const identity = io.identity();
  require([identity.uid, identity.euid, identity.gid, identity.egid].every(value => value === 10003));
  const uidMap = io.read("/proc/self/uid_map"), gidMap = io.read("/proc/self/gid_map");
  require(cloudEngineIdMapVersion(uidMap) === 5 && cloudEngineIdMapVersion(gidMap) === 5);
  const privilege = cloudEnginePrivilegeStatus(io.read("/proc/self/status"));
  require(privilege.noNewPrivs === 1 && privilege.seccompMode === 2 && Object.values(privilege.capabilities).every(value => value === 0));
  // File presence is not attachment. The current base intentionally uses an
  // unconfined AppArmor profile to permit its exact user-namespace transition.
  require(io.read("/proc/self/attr/current").trim() === "zeros-cloud-engine (unconfined)");
  const mountinfo = io.read("/proc/self/mountinfo"), targets = mountTargets(mountinfo);
  for (const file of ["/", "/usr", "/opt", "/etc", "/etc/zeros", runtime.root, runtime.workerRoot]) {
    const stat = io.metadata(file);
    require(stat.isDirectory() && !stat.isSymbolicLink() && [0, 65534].includes(stat.uid) && [0, 65534].includes(stat.gid) &&
      !(stat.mode & 0o022) && io.realpath(file) === file && isReadOnlyCloudMount(file, mountinfo));
  }
  const mutable = ["/srv/zeros/workspace", "/srv/zeros/state", "/srv/zeros/home/agent", "/srv/zeros/home/capture"];
  for (const file of [runtime.root, "/usr", ...mutable]) {
    require(nativeStorage.has(io.filesystem(file)));
    // No nested foreign binds or lazy restore mounts beneath an admitted
    // source. Deliberate top-level view aliases are checked independently.
    require(![...targets].some(target => target.startsWith(`${file}/`)));
  }
  for (const file of mutable) {
    const stat = io.metadata(file);
    require(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 10003 && stat.gid === 10003 && !(stat.mode & 0o022) && io.realpath(file) === file);
  }
  for (const file of ["/root", "/home/user", "/srv/zeros/broker", "/etc/shadow", "/etc/ssh", "/run/zeros/cloud-worker-supervisor.sock",
    "/run/zeros-privilege", "/srv/zeros/setup", "/opt/zeros-bootstrap", "/srv/zeros/runtime-installs"]) {
    try { io.metadata(file); fail(); } catch (error) { require(error?.code === "ENOENT"); }
  }
  for (const file of ["/srv/zeros/.zeros-setup", "/srv/zeros/.zeros-engine-setup"]) {
    const stat = io.metadata(file);
    require(stat.isDirectory() && !stat.isSymbolicLink() && [0, 65534].includes(stat.uid) && (stat.mode & 0o7777) === 0 && isReadOnlyCloudMount(file, mountinfo));
  }
  require(io.rootCredentialDenied());
  const custody = io.custody(runtime), common = `${runtime.cgroupRoot}/engine-runtime`;
  require(custody.common.directory === common && custody.workload.directory === `${common}/engine-workload-shared/workload` && custody.infrastructure.length === 1);
  const controller = custody.infrastructure[0];
  require(controller.kind === "engine" && controller.pid === identity.pid && controller.controlIdentity?.directory === controller.controlDirectory &&
    controller.controlDirectory?.startsWith(`${common}/engine-`) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(controller.controlDirectory.slice(`${common}/engine-`.length)));
  const resources = io.resources(runtime), census = io.census(custody);
  require(census.complete === true && census.populated === true && census.workloadPids.length === 0 && census.infrastructurePids.length === 1 &&
    census.infrastructurePids[0] === identity.pid && census.processes.length === 1 && census.processes[0].pid === identity.pid &&
    census.processes[0].startToken === controller.startToken && sameScope(census.common, custody.common) &&
    Number.isInteger(census.groups) && census.groups >= 4 && census.groups <= 8192 && /^[a-f0-9]{64}$/.test(census.censusSha256));
  return { schema: "zeros.cloud-boot-probe/v1", identity: { uid: identity.uid, euid: identity.euid, gid: identity.gid, egid: identity.egid,
    uidMap: "10003 10003 1", gidMap: "10003 10003 1", ...privilege },
    apparmor: { profile: "zeros-cloud-engine", mode: "unconfined" }, mounts: true, storage: true, credentials: true, resources,
    custody: { common: custody.common, workload: custody.workload,
      controller: { pid: controller.pid, startToken: controller.startToken, scope: controller.controlIdentity } },
    census: { sha256: census.censusSha256, groups: census.groups, processes: 1 } };
}

async function main() {
  if (process.argv.length !== 2) fail();
  process.stdout.write(`${JSON.stringify(checkCloudEngineBoot())}\n`);
  // Stay live until the root monitor checks this exact blocked process's
  // original custody record. The ack is fixed and grants no command input.
  await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { value += chunk; if (value !== "1") reject(new Error("Cloud boot acknowledgement refused")); });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => value === "1" ? resolve() : reject(new Error("Cloud boot acknowledgement refused")));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write("cloud current boot checks refused\n"); process.exitCode = 125; });
}

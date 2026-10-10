import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { CloudEngineCgroup } from "./cloud-engine-cgroup.mjs";
import { readCloudRootControllerRecord, readCloudRootProcessBirth } from "./publish-cloud-workload-custody.mjs";

const TIMEOUT_MS = 5000;
/** @type {(file: string, args: string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess} */
const spawnResidentWorkload = spawn;

/** Root-owned original controller. Its non-root resident has a control leaf;
 * resident PTYs enter the same shared workload pool as engine work. */
export class CloudResidentWorkload {
  constructor({ runtime, hostId, organizationId, workspaceId, spawnProcess = spawnResidentWorkload,
    readCustody = readCloudRootControllerRecord, readBirth = readCloudRootProcessBirth,
    removeServices = id => rmSync(`/run/zeros/resident-workloads/${id}`, { recursive: true, force: true }) }) {
    if (runtime.profile !== "v4") throw new Error("Resident workloads require v4");
    this.scope = new CloudEngineCgroup({ runtime, kind: "workload", instanceId: hostId });
    this.runtime = runtime;
    this.identity = Object.freeze({ hostId, organizationId, workspaceId });
    this.spawnProcess = spawnProcess;
    this.removeServices = removeServices;
    this.readCustody = readCustody;
    this.readBirth = readBirth;
    this.child = null;
    this.authority = null;
    this.fence = 0;
    this.lastEngineId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopFlight = null;
    this.healthy = false;
    this.originalCustody = null;
  }

  descriptor() {
    return { ...this.identity, protocol: "zeros.resident-pty/v1", runtimeId: this.runtime.runtimeId,
      manifestSha256: this.runtime.manifestSha256, bootId: this.runtime.bootId,
      supervisorSessionId: this.runtime.supervisorSessionId, scope: this.scope.directory,
      fence: this.fence, engineId: this.authority?.engineId ?? null,
      generation: this.authority?.generation ?? null };
  }

  fail() {
    this.healthy = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("Resident control unavailable"));
    }
    this.pending.clear();
  }

  async start(runtimeB64) {
    if (this.child || this.stopFlight) throw new Error("Resident workload already started");
    const child = this.spawnProcess(this.runtime.node, [`${this.runtime.libRoot}/cloud-engine-launcher.mjs`, "--resident"], {
      cwd: "/", detached: true, stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: "/root", LANG: "C.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ZEROS_CLOUD_RUNTIME_B64: runtimeB64, ZEROS_RESIDENT_HOST_ID: this.identity.hostId },
    });
    this.child = child;
    this.healthy = true;
    const lost = () => { this.fail(); void this.stop().catch(() => undefined); };
    child.on("error", lost); child.once("exit", lost);
    child.stdin.on("error", () => this.fail()); child.stdout.on("error", () => this.fail());
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4096) { this.fail(); return; }
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (!reply || Object.keys(reply).sort().join(",") !== "id,ok" || reply.ok !== true ||
            !Number.isSafeInteger(reply.id)) throw new Error();
          const pending = this.pending.get(reply.id);
          if (!pending) throw new Error();
          this.pending.delete(reply.id); clearTimeout(pending.timer); pending.resolve();
        } catch { this.fail(); }
      }
    });
    try {
      const ownerBirth = this.readBirth(child.pid);
      this.ownerBirth = { pid: ownerBirth.pid, startToken: ownerBirth.startToken };
      await this.request({ op: "start", identity: this.identity });
      const scope = this.scope.currentIdentity;
      this.originalCustody = this.readCustody({ runtime: this.runtime, owner: this.ownerBirth, scope });
    }
    catch (error) { await this.stop(); throw error; }
  }

  request(command) {
    if (!this.healthy || this.stopFlight || !this.child || this.child.exitCode !== null || this.child.signalCode !== null ||
      this.pending.size >= 4) return Promise.reject(new Error("Resident control unavailable"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, ...command }) + "\n", error => { if (error) this.fail(); });
    });
  }

  rootCustody() {
    if (!this.healthy || !this.originalCustody || !this.child || this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error("Resident original custody unavailable");
    const current = this.readCustody({ runtime: this.runtime, owner: this.ownerBirth,
      scope: this.originalCustody.scope, episode: this.originalCustody.episode });
    if (JSON.stringify(current) !== JSON.stringify(this.originalCustody)) throw new Error("Resident original custody changed");
    return globalThis.structuredClone(current);
  }

  async witness() { await this.request({ op: "ping" }); this.rootCustody(); return this.descriptor(); }

  async enroll(authority) {
    if (authority.organizationId !== this.identity.organizationId || authority.workspaceId !== this.identity.workspaceId ||
      authority.engineId === this.lastEngineId || authority.fence <= this.fence)
      throw new Error("Resident authority rejected");
    await this.request({ op: "authorize", authority });
    // Keep only public fencing identity in the root controller; the token goes
    // directly to the resident host and the freshly admitted engine.
    const publicAuthority = { organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      engineId: authority.engineId, generation: authority.generation, fence: authority.fence };
    this.authority = publicAuthority; this.lastEngineId = authority.engineId; this.fence = authority.fence;
  }

  async detach(expected) {
    if (expected.hostId !== this.identity.hostId || expected.engineId !== this.authority?.engineId ||
      expected.fence !== this.fence || !Number.isSafeInteger(this.fence + 1))
      throw new Error("Resident authority rejected");
    await this.request({ op: "revoke", fence: this.fence + 1 });
    this.fence++; this.authority = null;
    return this.descriptor();
  }

  stop() { return this.stopFlight ??= this.stopAll(); }

  async stopAll() {
    this.fail();
    const child = this.child;
    try {
      if (child) {
        child.stdin.end();
        const exited = () => !child.pid || child.exitCode !== null || child.signalCode !== null;
        const wait = timeout => new Promise(resolve => {
          if (exited()) { resolve(); return; }
          const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(); };
          const timer = setTimeout(finish, timeout);
          child.once("exit", finish);
        });
        await wait(12_000);
        if (!exited()) {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
          await wait(5000);
          if (!exited()) throw new Error("Resident launcher retirement unconfirmed");
        }
      }
    } finally {
      child?.stdin.destroy(); child?.stdout.destroy(); child?.unref();
      // This original controller leaf is separate from the shared workload
      // pool. Whole-VM detached work is retired by the outside root broker.
      await this.scope.retire();
      this.removeServices(this.identity.hostId);
    }
  }
}

/** Compatibility is limited to the root's still-held ORIGINAL old launcher
 * and direct dedicated leaf. A modern controller cannot own shared-pool PTYs. */
export function captureCloudLegacyResident(resident) {
  const refused = () => { throw new Error("legacy_resident_control_refused"); };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const unsigned = /^(?:0|[1-9][0-9]{0,19})$/;
  const runtime = resident?.runtime, identity = resident?.identity, scope = resident?.scope, child = resident?.child;
  if (!runtime || runtime.profile !== "v4" || !identity || !uuid.test(identity.hostId) ||
      !uuid.test(identity.organizationId) || !uuid.test(identity.workspaceId) || !(scope instanceof CloudEngineCgroup) ||
      scope.nested || scope.directory !== `${runtime.cgroupRoot}/engine-workload-${identity.hostId}` ||
      !child || !Number.isSafeInteger(child.pid) || child.pid < 2 || child.exitCode !== null || child.signalCode !== null ||
      resident.stopFlight || typeof resident.readBirth !== "function" || typeof resident.fail !== "function") refused();
  const original = scope.io.identity(scope.directory);
  if (original.directory !== scope.directory || !unsigned.test(original.dev) || !unsigned.test(original.ino) || original.ino === "0") refused();
  const birth = resident.readBirth(child.pid);
  if (birth.pid !== child.pid || !unsigned.test(birth.startToken) || birth.startToken === "0" ||
      resident.ownerBirth && (resident.ownerBirth.pid !== birth.pid || resident.ownerBirth.startToken !== birth.startToken)) refused();
  const episode = { runtimeId: runtime.runtimeId, bootId: runtime.bootId, supervisorSessionId: runtime.supervisorSessionId };
  if (!/^r1-[a-f0-9]{64}$/.test(episode.runtimeId) || !uuid.test(episode.bootId) || !uuid.test(episode.supervisorSessionId)) refused();
  const authority = { ...resident.authority };
  if (authority.organizationId !== identity.organizationId || authority.workspaceId !== identity.workspaceId ||
      !uuid.test(authority.engineId) || !Number.isSafeInteger(authority.generation) || authority.generation < 1 ||
      !Number.isSafeInteger(authority.fence) || authority.fence < 1 || Object.hasOwn(authority, "token")) refused();
  const source = Object.freeze({ hostId: identity.hostId, authority: Object.freeze(authority),
    runtime: Object.freeze(episode), scope: Object.freeze({ ...original }) });
  let pruned = false, flight;
  const assertCurrent = (allowExited = false) => {
    if (resident.runtime !== runtime || resident.scope !== scope || resident.child !== child ||
        resident.identity !== identity || Object.entries(episode).some(([key, value]) => runtime[key] !== value) ||
        Object.entries(authority).some(([key, value]) => resident.authority?.[key] !== value)) refused();
    if (!allowExited && (child.exitCode !== null || child.signalCode !== null)) refused();
    if (child.exitCode === null && child.signalCode === null) {
      const current = resident.readBirth(child.pid);
      if (current.pid !== birth.pid || current.startToken !== birth.startToken) refused();
    }
    if (!pruned) {
      const current = scope.io.identity(scope.directory);
      if (Object.keys(original).some(key => current[key] !== original[key])) refused();
    } else if (scope.io.exists(scope.directory)) refused();
  };
  const retire = checkEngine => {
    if (flight) return flight;
    flight = Promise.resolve().then(async () => {
      assertCurrent(); await checkEngine(); assertCurrent(); resident.fail();
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      const wait = timeout => new Promise(resolve => {
        if (exited()) { resolve(); return; }
        const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(); };
        const timer = setTimeout(finish, timeout); child.once("exit", finish);
      });
      try {
        child.stdin.end(); await wait(12_000); await checkEngine(); assertCurrent(true);
        if (!exited()) {
          // This is the captured root launcher group, never a census PID.
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
          await wait(5000); await checkEngine(); assertCurrent(true);
          if (!exited()) throw new Error("legacy_resident_retirement_failed");
        }
        // Guard every kernel operation, including reads after the wait inside
        // retire; an inode replacement never receives the old kill/proof.
        const guardedIo = {
          exists: directory => { assertCurrent(true); return scope.io.exists(directory); },
          read: (directory, name) => { assertCurrent(true); return scope.io.read(directory, name); },
          write: (directory, name, value) => { assertCurrent(true); return scope.io.write(directory, name, value); },
          remove: directory => { assertCurrent(true); scope.io.remove(directory); pruned = true; },
        };
        await new CloudEngineCgroup({ runtime, directory: original.directory, io: guardedIo,
          now: scope.now, pause: scope.pause }).retire();
        await checkEngine(); assertCurrent(true);
        if (!pruned || !exited()) throw new Error("legacy_resident_retirement_failed");
        resident.removeServices(identity.hostId);
        return Object.freeze({ kind: "dedicated-resident-cgroup", populated: 0 });
      } finally { child.stdin.destroy(); child.stdout.destroy(); child.unref(); }
    });
    resident.stopFlight = flight;
    return flight;
  };
  return Object.freeze({ source, assertLive: assertCurrent, retire });
}

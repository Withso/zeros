import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { CloudEngineCgroup } from "./cloud-engine-cgroup.mjs";

const TIMEOUT_MS = 5000;

/** Root-owned lifetime controller. The child launcher owns a distinct workload
 * cgroup and private namespace; the replaceable engine owns only a socket. */
export class CloudResidentWorkload {
  constructor({ runtime, hostId, organizationId, workspaceId, spawnProcess = spawn,
    removeServices = id => rmSync(`/run/zeros/resident-workloads/${id}`, { recursive: true, force: true }) }) {
    if (runtime.profile !== "v4") throw new Error("Resident workloads require v4");
    this.scope = new CloudEngineCgroup({ runtime, kind: "workload", instanceId: hostId });
    this.runtime = runtime;
    this.identity = Object.freeze({ hostId, organizationId, workspaceId });
    this.spawnProcess = spawnProcess;
    this.removeServices = removeServices;
    this.child = null;
    this.authority = null;
    this.fence = 0;
    this.lastEngineId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stopFlight = null;
    this.healthy = false;
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
    try { await this.request({ op: "start", identity: this.identity }); }
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

  async witness() { await this.request({ op: "ping" }); return this.descriptor(); }

  async enroll(authority) {
    if (authority.organizationId !== this.identity.organizationId || authority.workspaceId !== this.identity.workspaceId ||
      authority.engineId === this.lastEngineId || authority.fence <= this.fence)
      throw new Error("Resident authority rejected");
    await this.request({ op: "authorize", authority });
    // Keep only public fencing identity in the root controller; the token goes
    // directly to the resident host and the freshly admitted engine.
    const { token: _token, ...publicAuthority } = authority;
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
      // Also handles a crashed launcher and detached jobs outside its PID group.
      await this.scope.retire();
      this.removeServices(this.identity.hostId);
    }
  }
}

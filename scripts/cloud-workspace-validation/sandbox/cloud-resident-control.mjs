import net from "node:net";
import { chmodSync, chownSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { captureCloudLegacyResident } from "./cloud-resident-workload.mjs";

const SOCKET = "/run/zeros/engine/resident-control.sock";
const MAX_BYTES = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");
const refused = () => { throw new Error("legacy_resident_control_refused"); };
const canonical = value => JSON.stringify(value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

function requestBody(value) {
  if (!keys(value, ["version", "operation", "requestId", "hostId", "authority"]) || value.version !== 1 ||
      value.operation !== "retire-legacy-resident" || !UUID.test(value.requestId) || !UUID.test(value.hostId) ||
      !keys(value.authority, ["organizationId", "workspaceId", "engineId", "generation", "fence", "token"]) ||
      ["organizationId", "workspaceId", "engineId"].some(key => !UUID.test(value.authority[key])) ||
      ["generation", "fence"].some(key => !Number.isSafeInteger(value.authority[key]) || value.authority[key] < 1) ||
      typeof value.authority.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.authority.token)) refused();
  const bytes = canonical(value);
  if (Buffer.byteLength(bytes) > MAX_BYTES) refused();
  return JSON.parse(bytes);
}
function matches(authority, expected) {
  if (!expected || ["organizationId", "workspaceId", "engineId", "generation", "fence"].some(key => authority[key] !== expected[key]) ||
      typeof expected.token !== "string") return false;
  const actual = Buffer.from(authority.token), trusted = Buffer.from(expected.token);
  return actual.length === trusted.length && timingSafeEqual(actual, trusted);
}

/** Root callbacks retain the actually issued token and ORIGINAL launcher. The
 * engine supplies only an immutable operation, never PID/cgroup authority. */
export class CloudLegacyResidentControl {
  /** @param {{current: () => any, assertEngine: (authority: any) => unknown,
   * clearResident: (resident: any, receipt: any) => unknown,
   * serialize: (operation: () => Promise<unknown>) => Promise<unknown>,
   * assertListenerLock?: () => void, maxRequests?: number}} options */
  constructor({ current, assertEngine, clearResident, serialize, assertListenerLock = undefined, maxRequests = 256 }) {
    if ([current, assertEngine, clearResident, serialize].some(value => typeof value !== "function") ||
        assertListenerLock !== undefined && typeof assertListenerLock !== "function" ||
        !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 256) refused();
    this.current = current; this.assertEngine = assertEngine; this.clearResident = clearResident;
    this.serialize = serialize; this.maxRequests = maxRequests; this.receipts = new Map();
    this.assertListenerLock = assertListenerLock;
    this.server = null; this.sockets = new Set(); this.socketIdentity = null; this.closed = false;
  }

  async recoverStaleSocket(socketPath) {
    let initial;
    try { initial = lstatSync(socketPath, { bigint: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    // Only the outside supervisor's captured lifetime flock can authorize
    // recovery. An alternate test socket path supplies no such authority.
    if (!this.assertListenerLock) refused();
    this.assertListenerLock();
    const fixed = socketPath === SOCKET, directory = path.dirname(socketPath);
    const uid = BigInt(fixed ? 0 : process.geteuid()), gid = BigInt(fixed ? 10003 : process.getegid());
    const owner = BigInt(fixed ? 10003 : process.geteuid());
    const mode = BigInt(fixed ? 0o620 : 0o600), parent = lstatSync(directory, { bigint: true });
    const safe = metadata => metadata.isSocket() && metadata.uid === uid && metadata.gid === gid &&
      (metadata.mode & 0o7777n) === mode && metadata.nlink === 1n && metadata.ino > 0n;
    if (!safe(initial) || !parent.isDirectory() || parent.uid !== owner || parent.gid !== gid ||
        (parent.mode & 0o7777n) !== 0o700n || realpathSync(directory) !== directory) refused();
    const dead = await new Promise(resolve => {
      const socket = net.createConnection(socketPath);
      let finished = false;
      const finish = value => { if (finished) return; finished = true; socket.destroy(); resolve(value); };
      socket.setTimeout(1000, () => finish(false));
      socket.once("connect", () => finish(false));
      socket.once("error", error => finish(error?.code === "ECONNREFUSED"));
    });
    this.assertListenerLock();
    const current = lstatSync(socketPath, { bigint: true }), currentParent = lstatSync(directory, { bigint: true });
    if (!dead || !safe(current) || current.dev !== initial.dev || current.ino !== initial.ino ||
        current.ctimeNs !== initial.ctimeNs || !currentParent.isDirectory() ||
        ["dev", "ino", "uid", "gid", "mode"].some(key => currentParent[key] !== parent[key]) ||
        realpathSync(directory) !== directory) refused();
    // No await separates the final original lock/birth check from unlink.
    unlinkSync(socketPath);
  }

  async request(raw) {
    if (this.closed) refused();
    const body = requestBody(raw), hash = createHash("sha256").update(canonical(body)).digest("hex");
    const prior = this.receipts.get(body.requestId);
    if (prior) {
      if (hash !== prior.hash) refused();
      await this.assertEngine(prior.authority);
      return prior.promise;
    }
    if (this.receipts.size >= this.maxRequests) refused();
    const current = this.current();
    if (!current || current.resident?.identity.hostId !== body.hostId || !matches(body.authority, current.authority)) refused();
    const original = current.resident, authority = Object.freeze({ ...current.authority });
    const captured = captureCloudLegacyResident(original);
    if (["organizationId", "workspaceId", "engineId", "generation", "fence"].some(key => captured.source.authority[key] !== authority[key])) refused();
    const check = async () => {
      await this.assertEngine(authority);
      const next = this.current();
      if (!next || next.resident !== original || !matches(authority, next.authority)) refused();
    };
    const promise = Promise.resolve().then(async () => {
      await check(); captured.assertLive();
      let proof;
      try { proof = await captured.retire(check); }
      catch { throw new Error("legacy_resident_retirement_failed"); }
      await check();
      const receipt = Object.freeze({ version: 1, operation: body.operation, requestId: body.requestId,
        source: captured.source, phase: "retired", proof, replacement: "fresh-view-required" });
      // The saved promise owns this positive result even if the socket is lost.
      await this.clearResident(original, receipt);
      return receipt;
    });
    this.receipts.set(body.requestId, { hash, authority, promise });
    return promise;
  }

  handle(socket) {
    this.sockets.add(socket); socket.setEncoding("utf8"); socket.setTimeout(5000, () => socket.destroy());
    let buffer = "", submitted = false;
    socket.on("error", () => {}); socket.on("close", () => this.sockets.delete(socket));
    socket.on("data", chunk => {
      if (submitted) { socket.destroy(); return; }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES) { socket.destroy(); return; }
      const end = buffer.indexOf("\n"); if (end < 0) return;
      submitted = true;
      if (end !== buffer.length - 1) { socket.destroy(); return; }
      let body;
      try { body = requestBody(JSON.parse(buffer.slice(0, end))); } catch { socket.end(JSON.stringify({ error: { code: "legacy_resident_control_refused" } }) + "\n"); return; }
      // The frame-read bound is separate from positive launcher and cgroup
      // retirement. A slow original Stop can legitimately exceed five seconds.
      socket.setTimeout(30_000, () => socket.destroy());
      // Same queue as start/stop/handoff; disconnection does not cancel custody.
      Promise.resolve().then(() => this.serialize(() => this.request(body))).then(result => {
        const bytes = JSON.stringify({ result });
        if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("legacy_resident_control_refused");
        if (!socket.destroyed) socket.end(bytes + "\n");
      }).catch(error => {
        const code = error?.message === "legacy_resident_retirement_failed" ? error.message : "legacy_resident_control_refused";
        if (!socket.destroyed) socket.end(JSON.stringify({ error: { code } }) + "\n");
      });
    });
  }

  async listen({ socketPath = SOCKET } = {}) {
    if (this.closed || this.server || typeof socketPath !== "string" || socketPath.includes("\0") ||
        !socketPath.startsWith("/") || path.resolve(socketPath) !== socketPath) refused();
    if (socketPath === SOCKET && process.geteuid?.() !== 0) refused();
    await this.recoverStaleSocket(socketPath);
    const server = net.createServer(socket => this.handle(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
      if (socketPath === SOCKET) chownSync(socketPath, 0, 10003);
      chmodSync(socketPath, socketPath === SOCKET ? 0o620 : 0o600);
      const identity = lstatSync(socketPath, { bigint: true });
      if (!identity.isSocket()) refused();
      this.socketIdentity = { path: socketPath, dev: identity.dev, ino: identity.ino };
      server.on("error", () => {});
    } catch (error) { this.server = null; server.close(); throw error; }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const server = this.server; this.server = null;
    for (const socket of this.sockets) socket.destroy();
    const closing = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    await Promise.allSettled([...this.receipts.values()].map(value => value.promise));
    await closing;
    const original = this.socketIdentity;
    if (original) {
      try { const current = lstatSync(original.path, { bigint: true });
        if (current.isSocket() && current.dev === original.dev && current.ino === original.ino) unlinkSync(original.path);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
  }
}

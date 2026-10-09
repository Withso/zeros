import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResidentPtyHost } from "../resident-host";
import { ResidentPtyClient } from "../resident-client";
import type { ResidentEngineAuthority } from "../resident-protocol";
import { HostExecutionBoundary } from "../../agents/containment/host-boundary";
import { sessionsRoot } from "../../agents/session-paths";
import type { PreparedBoundary } from "../../agents/containment/types";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const hosts: ResidentPtyHost[] = [];
const clients: ResidentPtyClient[] = [];
const children: ChildProcess[] = [];
const readinessServers: Server[] = [];
const authority = (fence: number, generation = fence): ResidentEngineAuthority => ({
  organizationId, workspaceId, engineId: randomUUID(), generation, fence,
  token: randomBytes(32).toString("base64url"),
});

async function setup(additionalRoots: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-pty-"));
  roots.push(root);
  const socketPath = path.join(root, "host.sock");
  const host = new ResidentPtyHost({
    root, socketPath, organizationId, workspaceId, additionalRoots,
    // Both tests and production inherit their original engine identity.
    shell: "/bin/bash", identity: { uid: process.getuid!(), gid: process.getgid!() },
  });
  hosts.push(host);
  await host.start();
  const initial = authority(1);
  host.authorize(initial);
  const connect = async (current = initial) => {
    const client = new ResidentPtyClient({ socketPath, authority: current });
    clients.push(client);
    await client.connect();
    return client;
  };
  return { root, socketPath, host, initial, connect };
}

async function interruptedSupervisorFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-claim-"));
  roots.push(root);
  const ready = path.join(root, "claimed");
  const script = path.join(root, "host-process-supervisor.mjs");
  const supervisor = await readFile(new URL("../../agents/containment/host-process-supervisor.mjs", import.meta.url), "utf8");
  const handoff = "renameSync(pendingPath, claimPath);";
  expect(supervisor.split(handoff)).toHaveLength(2);
  // Hold the real supervisor after its atomic claim, before domain publication.
  await writeFile(script, supervisor.replace(handoff,
    `${handoff}\nwriteFileSync(${JSON.stringify(ready)}, 'ready');\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`));
  return { root, ready, script };
}

async function localInterruptedLaunch() {
  const f = await interruptedSupervisorFixture();
  const executionId = `local-claim-${randomUUID()}`;
  const prepared = await new HostExecutionBoundary({ supervisorScript: f.script }).prepare({
    executionId, actor: "agent-code", cwd: f.root, workspaceRoot: f.root,
  });
  const process = await prepared.spawn({ command: "/bin/bash", args: ["-c", "read -r value"], cwd: f.root, env: {} });
  if (process.child) children.push(process.child);
  await expect.poll(() => readFile(f.ready, "utf8").catch(() => "")).toBe("ready");
  const claimsRoot = path.join(sessionsRoot(), executionId, "boundary", prepared.generation, "claims");
  const entries = await readdir(claimsRoot);
  expect(entries).toHaveLength(1);
  return { prepared, process, claim: path.join(claimsRoot, entries[0]) };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  for (const client of clients.splice(0)) client.disconnect();
  for (const host of hosts.splice(0)) await host.stop();
  for (const server of readinessServers.splice(0)) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("Local Host interrupted launches", () => {
  it("retires the exact original claim after its process group is proven empty", async () => {
    const f = await localInterruptedLaunch();
    try {
      await f.prepared.stopAndProve();
      expect(() => process.kill(f.process.pid, 0)).toThrow();
      await expect(readFile(f.claim)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.process.stopAndProve();
    }
  });

  it.each(["token", "generation", "ownerPid", "createdAt", "extraField"] as const)(
    "preserves an interrupted claim with changed %s despite original group emptiness", async field => {
      const f = await localInterruptedLaunch();
      await f.process.stopAndProve();
      const record = JSON.parse(await readFile(f.claim, "utf8"));
      record[field] = field === "ownerPid" || field === "createdAt" ? record[field] + 1 : "foreign";
      const changed = JSON.stringify(record);
      await writeFile(f.claim, changed);
      try {
        await expect(f.prepared.stopAndProve()).rejects.toThrow();
        expect(await readFile(f.claim, "utf8")).toBe(changed);
      } finally {
        // Remove only this deliberately corrupted fixture after refusal proof.
        await rm(f.claim, { force: true });
        await f.prepared.stopAndProve();
      }
    },
  );

  it("preserves a valid claim that has no original tracked launch", async () => {
    const f = await localInterruptedLaunch();
    await f.process.stopAndProve();
    const token = randomUUID();
    const foreign = path.join(path.dirname(f.claim), `${token}.json`);
    const record = { ...JSON.parse(await readFile(f.claim, "utf8")), token };
    const bytes = JSON.stringify(record);
    await writeFile(foreign, bytes, { mode: 0o600 });
    try {
      await expect(f.prepared.stopAndProve()).rejects.toThrow();
      expect(await readFile(foreign, "utf8")).toBe(bytes);
    } finally {
      await rm(foreign, { force: true });
      await f.prepared.stopAndProve();
    }
  });

  it("preserves the exact claim when original group-emptiness proof fails", async () => {
    const f = await localInterruptedLaunch();
    const bytes = await readFile(f.claim, "utf8");
    const refusal = new Error("synthetic original group proof refusal");
    const proving = vi.spyOn(f.process, "stopAndProve").mockRejectedValue(refusal);
    try {
      await expect(f.prepared.stopAndProve()).rejects.toBe(refusal);
      expect(await readFile(f.claim, "utf8")).toBe(bytes);
    } finally {
      proving.mockRestore();
      await f.prepared.stopAndProve();
    }
  });
});

describe.runIf(process.platform === "linux")("resident cloud terminals", () => {
  it("refuses a different Unix identity even if a caller supplies a valid resident scope", () => {
    expect(() => new ResidentPtyHost({root: '/tmp', socketPath: '/tmp/unused.sock', organizationId, workspaceId,
      shell: '/bin/bash', identity: {uid: process.getuid!() + 1, gid: process.getgid!()}})).toThrow('request_rejected');
  });
  it("runs resident terminal commands as the exact engine identity", async () => {
    const f = await setup(), client = await f.connect();
    await client.create({sessionId: 'engine-identity', cwd: f.root, cols: 80, rows: 24,
      env: {PATH: '/usr/bin:/bin'}, command: "printf 'uid=%s gid=%s\\n' \"$(id -u)\" \"$(id -g)\""});
    await expect.poll(async () => (await client.list())[0].exited).toBe(true);
    const output = (await client.snapshot('engine-identity')).data.replaceAll('\r', '');
    expect(output).toContain(`uid=${process.getuid!()} gid=${process.getgid!()}`);
  });
  it('reports original resident groups, including foreground commands, without changing session custody',async()=>{
    const f=await setup(),client=await f.connect();
    expect(await client.inspectWorkloads()).toEqual({version:1,complete:true,busy:false});
    const session=await client.create({sessionId:'observed-work',cwd:f.root,cols:80,rows:24,env:{PATH:'/usr/bin:/bin'},command:'sleep 60 & wait'});
    await expect.poll(async()=>await client.inspectWorkloads()).toEqual({version:1,complete:true,busy:true});
    const nextAuthority=authority(2);f.host.authorize(nextAuthority);const next=await f.connect(nextAuthority);
    expect((await next.list())[0].pid).toBe(session.pid);expect((await next.inspectWorkloads()).busy).toBe(true);
    await next.close(session.sessionId);expect(await next.inspectWorkloads()).toEqual({version:1,complete:true,busy:false});
  });
  it("rechecks session ownership after concurrent original preparation", async () => {
    const f = await setup(), client = await f.connect();
    const prepare = f.host["workloads"].prepare.bind(f.host["workloads"]);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const preparing = vi.spyOn(f.host["workloads"], "prepare").mockImplementation(async (...args) => {
      const scope = await prepare(...args); await held; return scope;
    });
    const launch = {sessionId: "same-original-session", cwd: f.root, cols: 80, rows: 24,
      env: {PATH: "/usr/bin:/bin"}, command: "exec sleep 60"};
    const first = client.create(launch), second = client.create(launch);
    try {
      await expect.poll(() => preparing.mock.calls.length).toBe(2);
      expect(await client.inspectWorkloads()).toMatchObject({busy: true});
    } finally { release(); }
    const [a, b] = await Promise.all([first, second]);
    expect(b.pid).toBe(a.pid);
    expect(await client.list()).toEqual([a]);
    await client.close(a.sessionId);
    expect(await client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: false});
  });
  it("distinguishes the original idle login shell from its background job", async () => {
    const f = await setup(), client = await f.connect();
    const session = await client.create({sessionId: "idle-login", cwd: f.root, cols: 80, rows: 24,
      env: {PATH: "/usr/bin:/bin", HOME: f.root}});
    await expect.poll(async () => client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: false});
    await client.write(session.sessionId, {producerId: randomUUID(), sequence: 1, data: "sleep 60 &\n"});
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      await expect.poll(async () => client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: true});
    } finally { clock.mockRestore(); }
    await client.close(session.sessionId);
    expect(await client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: false});
  });
 it("keeps an active builtin loop busy even with no exec or child process",async()=>{
  const f=await setup(),client=await f.connect();
  const session=await client.create({sessionId:"busy-original-shell",cwd:f.root,cols:80,rows:24,env:{PATH:"/usr/bin:/bin",HOME:f.root}});
  await expect.poll(()=>client.inspectWorkloads()).toEqual({version:1,complete:true,busy:false});
  await client.write(session.sessionId,{producerId:randomUUID(),sequence:1,data:"printf 'BUILTIN_%s\\n' READY; while :; do :; done\n"});
  await expect.poll(async()=>(await client.snapshot(session.sessionId)).data).toContain("BUILTIN_READY");
  const clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+11*60_000);
  try {expect(await client.inspectWorkloads()).toEqual({version:1,complete:true,busy:true});}
  finally {clock.mockRestore();}
 });

  it("keeps a foreground command that exec-replaced the terminal shell busy", async () => {
    const f = await setup(), client = await f.connect();
    const session = await client.create({sessionId: "exec-foreground", cwd: f.root, cols: 80, rows: 24,
      env: {PATH: "/usr/bin:/bin", HOME: f.root}});
    await expect.poll(async () => client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: false});
    await client.write(session.sessionId, {producerId: randomUUID(), sequence: 1, data: "exec sleep 60\n"});
    await expect.poll(async () => (await client.snapshot(session.sessionId)).data).toContain("exec sleep 60");
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try {
      await expect.poll(async () => client.inspectWorkloads()).toEqual({version: 1, complete: true, busy: true});
    } finally {clock.mockRestore();}
    await client.close(session.sessionId);
  });
  it("retains exit status across replacement without changing legacy snapshots", async () => {
    const f = await setup(), client = await f.connect();
    const sessionId = "exit-while-detached";
    await client.create({ sessionId, cwd: f.root, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin" },
      command: "stty -echo; printf 'READY\\n'; read -r value; printf 'LAST\\n'; exit 7" });
    await expect.poll(async () => (await client.snapshot(sessionId)).data).toContain("READY");
    await client.write(sessionId, { producerId: randomUUID(), sequence: 1, data: "go\n" });
    client.disconnect();
    const target = authority(2); f.host.authorize(target); const next = await f.connect(target);
    await expect.poll(async () => (await next.list())[0].exited).toBe(true);
    const snapshot = await next.snapshot(sessionId, true);
    expect(snapshot).toMatchObject({ exit: { exitCode: 7, signal: 0 } });
    expect(snapshot.data).toContain("LAST");
    expect(await next.snapshot(sessionId)).not.toHaveProperty("exit");
  });
  it("admits separately configured managed roots but rejects symlinks outside their physical boundary", async () => {
    const managed = await mkdtemp(path.join(tmpdir(), "zeros-resident-managed-")); roots.push(managed);
    const f = await setup([managed]), client = await f.connect();
    const created = await client.create({ sessionId: "managed", cwd: managed, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin" }, command: "exec sleep 1000" });
    expect(created.cwd).toBe(managed);
    await symlink(tmpdir(), path.join(managed, "outside"));
    await expect(client.create({ sessionId: "escape", cwd: path.join(managed, "outside"), cols: 80, rows: 24,
      env: {} })).rejects.toThrow("cwd_rejected");
  });
  it("acknowledges explicit close only after the PTY leader has exited", async () => {
    const f = await setup(), client = await f.connect();
    const created = await client.create({ sessionId: "close-proof", cwd: f.root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin" }, command: "exec sleep 1000" });
    await client.close(created.sessionId);
    expect(() => process.kill(created.pid, 0)).toThrow();
  });
  it("keeps a real shell and background server alive across engine death and rollback", async () => {
    const f = await setup();
    const serverFile = path.join(f.root, "server.cjs");
    const readinessSocket = path.join(f.root, "server-ready.sock");
    let server: { pid: number; port: number } | undefined;
    const readiness = createServer(connection => {
      connection.setEncoding("utf8");
      let message = "";
      connection.on("data", chunk => { message += chunk; });
      connection.on("end", () => {
        const value = JSON.parse(message) as { pid: number; port: number };
        if (Number.isSafeInteger(value.pid) && value.pid > 0 && Number.isSafeInteger(value.port) && value.port > 0 && value.port < 65536)
          server = value;
      });
    });
    readinessServers.push(readiness);
    await new Promise<void>((resolve, reject) => {
      readiness.once("error", reject);
      readiness.listen(readinessSocket, resolve);
    });
    await writeFile(serverFile, `const http = require('node:http');
const net = require('node:net');
let n = 0;
const server = http.createServer((_req, res) => res.end(String(++n)));
server.listen(0, '127.0.0.1', () => {
  const ready = net.createConnection(${JSON.stringify(readinessSocket)});
  ready.on('connect', () => ready.end(JSON.stringify({pid: process.pid, port: server.address().port})));
});
`);
    const sessionId = randomUUID();
    const engine = fork(fileURLToPath(new URL("./fixtures/resident-engine.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH },
    });
    children.push(engine);
    const created = new Promise<{ pid: number }>((resolve, reject) => {
      engine.once("error", () => reject(new Error("test engine failed to start")));
      engine.once("message", message => {
        const value = message as { ok?: boolean; pid: number };
        if (value.ok) resolve(value);
        else reject(new Error("test engine could not create terminal"));
      });
    });
    // Authority travels only on the fixture's private IPC pipe, never argv.
    engine.send({ socketPath: f.socketPath, authority: f.initial, sessionId, cwd: f.root,
      command: `stty -echo; setsid '${process.execPath}' '${serverFile}' &\nprintf 'BEFORE\\n'; while IFS= read -r value; do printf 'VALUE:%s\\n' "$value"; done` });
    const { pid } = await created;
    await expect.poll(() => Boolean(server)).toBe(true);
    const url = `http://127.0.0.1:${server!.port}`;
    expect(await (await fetch(url)).text()).toBe("1");
    const died = new Promise<void>(resolve => engine.once("exit", () => resolve()));
    engine.kill("SIGKILL");
    await died;
    expect(await (await fetch(url)).text()).toBe("2");

    const target = authority(2);
    f.host.authorize(target);
    const next = await f.connect(target);
    expect((await next.list())[0]?.pid).toBe(pid);
    expect((await next.snapshot(sessionId)).data).toContain("BEFORE");
    const producerId = randomUUID();
    await next.write(sessionId, { producerId, sequence: 1, data: "after\n" });
    await expect.poll(async () => (await next.snapshot(sessionId)).data).toContain("VALUE:after");

    // Rollback uses a fresh engine UUID and a higher fence, even though the
    // immutable source generation is older than the failed target's.
    const rollback = authority(3, 1);
    f.host.authorize(rollback);
    const restored = await f.connect(rollback);
    expect((await restored.list())[0]?.pid).toBe(pid);
    expect(await (await fetch(url)).text()).toBe("3");
    expect((await restored.snapshot(sessionId)).data).toContain("VALUE:after");
    await restored.close(sessionId);
    await expect.poll(async () => {
      try { await fetch(url, { signal: AbortSignal.timeout(200) }); return false; }
      catch { return true; }
    }).toBe(true);
    expect(await restored.list()).toEqual([]);
  });

  it("fences old engines, foreign workspaces and replayed enrollments", async () => {
    const f = await setup();
    const old = await f.connect();
    const target = authority(2);
    f.host.authorize(target);
    await expect(old.list()).rejects.toThrow(/unavailable|authority/);
    expect(() => f.host.authorize(f.initial)).toThrow(/authority/);
    expect(() => f.host.authorize({ ...target, workspaceId: randomUUID(), fence: 3 })).toThrow(/authority/);
    await expect(f.connect(f.initial)).rejects.toThrow(/authority/);
    const next = await f.connect(target);
    expect(await next.list()).toEqual([]);
    f.host.revoke(3);
    expect(() => f.host.authorize({ ...target, fence: 4 })).toThrow(/authority/);
  });

  it("ignores the retired socket's late close when the same adapter reconnects", async () => {
    const f = await setup(); const client = await f.connect();
    for (let attempt = 0; attempt < 3; attempt++) {
      client.disconnect();
      await client.connect();
      expect(await client.list()).toEqual([]);
    }
  });

  it("does not execute duplicate input again after a lost reply and replacement", async () => {
    const f = await setup();
    const source = await f.connect();
    const sessionId = randomUUID();
    await source.create({ sessionId, cwd: f.root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin" },
      command: "stty -echo; printf 'READY\\n'; while IFS= read -r value; do printf 'APPLIED:%s\\n' \"$value\"; done" });
    await expect.poll(async () => (await source.snapshot(sessionId)).data).toContain("READY");
    const input = { producerId: randomUUID(), sequence: 1, data: "once\n" };
    await source.write(sessionId, input);
    const target = authority(2); f.host.authorize(target);
    const next = await f.connect(target);
    expect(await next.write(sessionId, input)).toBe("duplicate");
    await expect(next.write(sessionId, { ...input, data: "changed\n" })).rejects.toThrow(/input_conflict/);
    await expect(next.write(sessionId, { ...input, sequence: 3 })).rejects.toThrow(/input_sequence/);
    await expect.poll(async () => (await next.snapshot(sessionId)).data).toContain("APPLIED:once");
    const snapshot = await next.snapshot(sessionId);
    expect(snapshot.data.match(/APPLIED:once/g)).toHaveLength(1);
    expect(snapshot.sequence).toBeGreaterThan(0);
    await next.write(sessionId, { ...input, sequence: 2, data: "\u0000control\n" });
    await expect.poll(async () => (await next.snapshot(sessionId)).data).toContain("APPLIED:control");
  });

  it("validates cwd and launch input before creating a shell", async () => {
    const f = await setup(); const client = await f.connect();
    await expect(client.create({ sessionId: randomUUID(), cwd: "/", cols: 80, rows: 24,
      env: {} })).rejects.toThrow(/cwd_rejected/);
    await expect(client.create({ sessionId: randomUUID(), cwd: f.root, cols: 0, rows: 24,
      env: {} })).rejects.toThrow(/request_rejected/);
    expect(await client.list()).toEqual([]);
  });

  it("does not rebind a surviving terminal's actor when a create is retried", async () => {
    const f = await setup(); const client = await f.connect();
    const launch = { sessionId: randomUUID(), cwd: f.root, cols: 80, rows: 24, env: {},
      actorUserId: "original-actor", command: "read -r value" };
    const original = await client.create(launch);
    await expect(client.create({ ...launch, actorUserId: "different-actor" })).rejects.toThrow(/authority/);
    expect((await client.create(launch)).pid).toBe(original.pid);
    expect((await client.list())[0].actorUserId).toBe("original-actor");
  });

  it("retires an original terminal whose supervisor is interrupted after claiming its launch", async () => {
    const fixture = await interruptedSupervisorFixture();
    vi.stubEnv("ZEROS_HOST_SUPERVISOR_SCRIPT", fixture.script);
    try {
      const f = await setup(), client = await f.connect();
      const terminal = await client.create({ sessionId: randomUUID(), cwd: f.root, cols: 80, rows: 24,
        env: {}, command: "read -r value" });
      await expect.poll(() => readFile(fixture.ready, "utf8").catch(() => "")).toBe("ready");
      await f.host.stop();
      expect(() => process.kill(terminal.pid, 0)).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retains failed automatic retirement for explicit stop callers without an unhandled rejection", async () => {
    const f = await setup(), client = await f.connect();
    const prepare = f.host["executionBoundary"].prepare.bind(f.host["executionBoundary"]);
    let prepared: PreparedBoundary | undefined;
    const preparing = vi.spyOn(f.host["executionBoundary"], "prepare").mockImplementation(async (...args) => {
      prepared = await prepare(...args);
      return prepared;
    });
    const terminal = await client.create({ sessionId: randomUUID(), cwd: f.root, cols: 80, rows: 24,
      env: {}, command: "printf 'READY\\n'; read -r value" });
    await expect.poll(async () => (await client.snapshot(terminal.sessionId)).data).toContain("READY");
    if (!prepared) throw new Error("fixture has no original preparation");
    const originalRetire = prepared.stopAndProve.bind(prepared);
    const failure = new Error("synthetic original retirement refusal");
    const retiring = vi.spyOn(prepared, "stopAndProve").mockImplementation(async () => {
      await originalRetire();
      throw failure;
    });
    const stop = f.host.stop.bind(f.host);
    let markStopped!: () => void;
    const stopped = new Promise<void>(resolve => { markStopped = resolve; });
    const stopping = vi.spyOn(f.host, "stop").mockImplementation(() => {
      const receipt = stop();
      // Observe the original receipt; the old event callback still leaks its
      // separate adopted rejection, which the test runner reports as RED.
      void receipt.catch(() => undefined);
      markStopped();
      return receipt;
    });
    try {
      await client.write(terminal.sessionId, { producerId: randomUUID(), sequence: 1, data: "go\n" });
      await stopped;
      const receipt = f.host.stop();
      await expect(receipt).rejects.toBe(failure);
      expect(f.host.stop()).toBe(receipt);
      expect(f.host["stopping"]).toBe(true);
      await expect(client.list()).rejects.toThrow(/unavailable/);
    } finally {
      preparing.mockRestore();
      retiring.mockRestore();
      stopping.mockRestore();
      await originalRetire();
      await f.host["workloads"].drain(f.host["workloads"].fence());
      for (const session of f.host["sessions"].values()) session.mirror.dispose();
      hosts.splice(hosts.indexOf(f.host), 1);
    }
  });

  it("retains bounded terminal state while disconnected and redacts before replay", async () => {
    const f = await setup(); const client = await f.connect();
    const sessionId = randomUUID();
    await client.create({ sessionId, cwd: f.root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin", SYNTHETIC_VALUE: "test-private-value" },
      redactValues: ["test-private-value"],
      command: "printf '%s\\n' \"$SYNTHETIC_VALUE\"; printf 'DONE\\n'; read -r value" });
    await expect.poll(async () => (await client.snapshot(sessionId)).data).toContain("DONE");
    client.disconnect();
    const target = authority(2); f.host.authorize(target);
    const next = await f.connect(target);
    const snapshot = await next.snapshot(sessionId);
    expect(snapshot.data.includes("test-private-value")).toBe(false);
    expect(snapshot.data).toContain("[redacted]");
    expect(snapshot.bytes).toBeLessThanOrEqual(256 * 1024);
    await f.host.stop();
    await expect(next.list()).rejects.toThrow(/unavailable/);
  });

  it("retains existing panel session IDs and bounded output while no engine is attached", async () => {
    const f = await setup(); const client = await f.connect();
    const sessionId = "pty-mtest-1";
    await client.create({ sessionId, cwd: f.root, cols: 120, rows: 24, env: { PATH: "/usr/bin:/bin" },
      command: "stty -echo; printf 'READY\\n'; read -r go; for ((i=0;i<10000;i++)); do printf '%080d\\n' \"$i\"; done; printf 'DONE\\n'; read -r hold" });
    await expect.poll(async () => (await client.snapshot(sessionId)).data).toContain("READY");
    await client.write(sessionId, { producerId: randomUUID(), sequence: 1, data: "go\n" });
    client.disconnect();
    const replacement = authority(2); f.host.authorize(replacement);
    const next = await f.connect(replacement);
    await expect.poll(async () => (await next.snapshot(sessionId)).data, { timeout: 5000 }).toContain("DONE");
    const snapshot = await next.snapshot(sessionId);
    expect(snapshot.bytes).toBeLessThanOrEqual(256 * 1024);
    expect(snapshot.data).not.toContain("READY");
    expect((await next.list())[0].sessionId).toBe(sessionId);
  });
});

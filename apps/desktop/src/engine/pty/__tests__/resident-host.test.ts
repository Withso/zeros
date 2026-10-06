import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResidentPtyHost } from "../resident-host";
import { ResidentPtyClient } from "../resident-client";
import type { ResidentEngineAuthority } from "../resident-protocol";

const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
const hosts: ResidentPtyHost[] = [];
const clients: ResidentPtyClient[] = [];
const children: ChildProcess[] = [];
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
    // These tests run as the sandbox user; production uses the attested
    // human-workload identity in its own resident namespace.
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

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const client of clients.splice(0)) client.disconnect();
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("resident cloud terminals", () => {
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
    const serverInfo = path.join(f.root, "server.json");
    await writeFile(serverFile, `const http = require('node:http');
const fs = require('node:fs');
let n = 0;
const server = http.createServer((_req, res) => res.end(String(++n)));
server.listen(0, '127.0.0.1', () => fs.writeFileSync(${JSON.stringify(serverInfo)},
  JSON.stringify({pid: process.pid, port: server.address().port})));
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
    let server: { pid: number; port: number } | undefined;
    await expect.poll(async () => {
      try { server = JSON.parse(await readFile(serverInfo, "utf8")); return true; }
      catch { return false; }
    }).toBe(true);
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

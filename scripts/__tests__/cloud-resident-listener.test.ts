import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { constants, closeSync, fstatSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudLegacyResidentControl } from "../cloud-workspace-validation/sandbox/cloud-resident-control.mjs";

async function listenerFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zeros-resident-listener-"));
  const socketPath = path.join(directory, "root.sock");
  const lock = openSync(path.join(directory, "root.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const original = fstatSync(lock, { bigint: true });
  const acquired = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
    stdio: ["ignore", "ignore", "pipe", lock], env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 5000,
  });
  if (acquired.status !== 0) throw new Error("fixture exclusive lock refused");
  const assertListenerLock = vi.fn(() => {
    const current = fstatSync(lock, { bigint: true });
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
        current.uid !== original.uid || current.nlink !== 1n) throw new Error("fixture original lock changed");
  });
  const control = (locked = true) => new CloudLegacyResidentControl({ current: () => null,
    assertEngine: async () => { throw new Error("no fixture engine"); },
    clearResident: async () => { throw new Error("no fixture resident"); },
    serialize: async (operation: () => Promise<unknown>) => operation(),
    ...(locked ? { assertListenerLock } : {}),
  });
  const children = new Set<ChildProcess>();
  const start = async () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      "import net from 'node:net'; import {chmodSync} from 'node:fs'; const server=net.createServer(); server.listen(process.argv[1],()=>{chmodSync(process.argv[1],0o600);process.stdout.write('ready\\n');});", socketPath],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const ready = await Promise.race([once(child.stdout!, "data"),
      once(child, "error").then(([error]) => { throw error; }),
      once(child, "exit").then(() => { throw new Error("fixture listener exited before ready"); })]);
    expect(String(ready[0])).toBe("ready\n");
    return child;
  };
  const kill = async (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    children.delete(child);
  };
  const stale = async () => {
    await kill(await start());
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    const code = await new Promise<string | undefined>(resolve => {
      const socket = net.connect(socketPath);
      socket.once("error", error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code); });
      socket.once("connect", () => { socket.destroy(); resolve(undefined); });
    });
    expect(code).toBe("ECONNREFUSED");
    return lstat(socketPath, { bigint: true });
  };
  return { socketPath, assertListenerLock, control, start, stale,
    async dispose() {
      for (const child of children) await kill(child);
      closeSync(lock); await rm(directory, { recursive: true, force: true });
    } };
}

describe("original exclusive root resident listener restart", () => {
  it("recovers a killed and positively reaped predecessor under the original lifetime lock", async () => {
    const f = await listenerFixture(), next = f.control();
    try {
      await f.stale();
      await expect(next.listen({ socketPath: f.socketPath })).resolves.toBeUndefined();
      expect(f.assertListenerLock.mock.calls.length).toBeGreaterThanOrEqual(2);
      const socket = net.connect(f.socketPath); socket.on("error", () => {});
      await once(socket, "connect"); socket.destroy();
    } finally { await next.close(); await f.dispose(); }
  });

  it("retains a live listener even when this caller holds an independent lock", async () => {
    const f = await listenerFixture(), next = f.control();
    try {
      await f.start(); const original = await lstat(f.socketPath, { bigint: true });
      await expect(next.listen({ socketPath: f.socketPath })).rejects.toThrow();
      const current = await lstat(f.socketPath, { bigint: true }); expect(current.ino).toBe(original.ino);
      const socket = net.connect(f.socketPath); socket.on("error", () => {});
      await once(socket, "connect"); socket.destroy();
    } finally { await next.close(); await f.dispose(); }
  });

  it("does not derive stale unlink authority from an alternate socket path", async () => {
    const f = await listenerFixture(), next = f.control(false);
    try {
      const original = await f.stale();
      await expect(next.listen({ socketPath: f.socketPath })).rejects.toThrow();
      expect((await lstat(f.socketPath, { bigint: true })).ino).toBe(original.ino);
    } finally { await next.close(); await f.dispose(); }
  });

  it.each(["file", "symlink", "mode"])("retains a foreign %s at the fixed selected path", async kind => {
    const f = await listenerFixture(), next = f.control();
    try {
      if (kind === "mode") { await f.stale(); await chmod(f.socketPath, 0o644); }
      else if (kind === "symlink") await symlink("foreign", f.socketPath);
      else writeFileSync(f.socketPath, "foreign");
      const original = await lstat(f.socketPath, { bigint: true });
      await expect(next.listen({ socketPath: f.socketPath })).rejects.toThrow();
      expect((await lstat(f.socketPath, { bigint: true })).ino).toBe(original.ino);
    } finally { await next.close(); await f.dispose(); }
  });

  it("refuses a replaced socket birth after the refusal probe", async () => {
    const f = await listenerFixture(), next = f.control();
    try {
      await f.stale();
      f.assertListenerLock.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
        unlinkSync(f.socketPath); writeFileSync(f.socketPath, "replacement");
      });
      await expect(next.listen({ socketPath: f.socketPath })).rejects.toThrow();
      expect((await lstat(f.socketPath)).isFile()).toBe(true);
    } finally { await next.close(); await f.dispose(); }
  });

  it("retains the stale inode when the original lifetime lock is lost across the probe", async () => {
    const f = await listenerFixture(), next = f.control();
    try {
      const original = await f.stale();
      f.assertListenerLock.mockImplementationOnce(() => undefined).mockImplementationOnce(() => {
        throw new Error("original lock lost");
      });
      await expect(next.listen({ socketPath: f.socketPath })).rejects.toThrow();
      expect((await lstat(f.socketPath, { bigint: true })).ino).toBe(original.ino);
    } finally { await next.close(); await f.dispose(); }
  });

  it("preserves graceful close and replacement without invoking stale recovery", async () => {
    const f = await listenerFixture(), first = f.control(), next = f.control();
    try {
      await first.listen({ socketPath: f.socketPath }); await first.close(); await next.listen({ socketPath: f.socketPath });
      expect(f.assertListenerLock).not.toHaveBeenCalled();
    } finally { await first.close(); await next.close(); await f.dispose(); }
  });
});

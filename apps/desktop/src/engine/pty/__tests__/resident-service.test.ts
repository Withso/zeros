import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentPtyHost } from "../resident-host";
import { ResidentTerminalService } from "../resident-service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

describe.runIf(process.platform === "linux")("cloud resident engine adapter", () => {
  it("returns the exited state when a shell exits before create is acknowledged", async () => {
    const service = new ResidentTerminalService({ hostId: randomUUID(), socketPath: "/unused",
      authority: { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(), generation: 1,
        fence: 1, token: randomBytes(32).toString("base64url") } });
    vi.spyOn(service["client"], "create").mockImplementation(async launch => {
      service["receive"]({ kind: "exit", sessionId: launch.sessionId, exitCode: 7, signal: null });
      return { ...launch, pid: 123, createdAt: 1, exited: false, actorUserId: null,
        registryWorkspaceId: null, environmentOwnerId: null, brokerId: null, githubShared: false, lastInputAtMs: 0 };
    });
    const session = await service.create({ sessionId: "short-lived", cwd: "/tmp", cols: 80, rows: 24, env: {} });
    expect(session.exited).toBe(true);
    expect(service.has(session.sessionId)).toBe(false);
  });
  it("treats an unexpected host disconnect as busy until attachment is restored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-health-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const authority = { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(), generation: 1,
      fence: 1, token: randomBytes(32).toString("base64url") };
    const socketPath = path.join(root, "host.sock");
    const host = new ResidentPtyHost({ root, socketPath, organizationId: authority.organizationId, workspaceId: authority.workspaceId,
      shell: "/bin/bash", identity: { uid: process.getuid!(), gid: process.getgid!() } });
    cleanup.push(() => host.stop()); await host.start(); host.authorize(authority);
    const service = new ResidentTerminalService({ hostId: randomUUID(), socketPath, authority });
    cleanup.push(async () => service.disconnect());
    await service.connect(); expect(service.busy()).toBe(false);
    host.revoke(2);
    await expect.poll(() => service.busy()).toBe(true);
  });
  it("counts resize/close requests before awaiting them and rejects a disconnected hydration", async () => {
    const service = new ResidentTerminalService({ hostId: randomUUID(), socketPath: "/unused",
      authority: { organizationId: randomUUID(), workspaceId: randomUUID(), engineId: randomUUID(), generation: 1,
        fence: 1, token: randomBytes(32).toString("base64url") } });
    vi.spyOn(service["client"], "isConnected").mockReturnValue(true);
    vi.spyOn(service["client"], "connect").mockResolvedValue();
    vi.spyOn(service["client"], "list").mockResolvedValue([]);
    await service.connect();
    let finish!: () => void;
    vi.spyOn(service["client"], "resize").mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const resize = service.resize("test", 80, 24);
    expect(service.busy()).toBe(true); finish(); await resize; expect(service.busy()).toBe(false);
    vi.spyOn(service["client"], "list").mockImplementation(() => new Promise(resolve => { finish = () => resolve([]); }));
    const connecting = service.connect();
    const failed = expect(connecting).rejects.toThrow("host_unavailable");
    await new Promise(resolve => setImmediate(resolve));
    service.disconnect(); finish(); await failed;
  });
  it("restores actor/registry state and input order after many engine replacements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-service-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const organizationId = randomUUID(), workspaceId = randomUUID(), hostId = randomUUID();
    const socketPath = path.join(root, "host.sock");
    const host = new ResidentPtyHost({ root, socketPath, organizationId, workspaceId,
      shell: "/bin/bash", identity: { uid: process.getuid!(), gid: process.getgid!() } });
    cleanup.push(() => host.stop()); await host.start();
    const connect = async (fence: number) => {
      const authority = { organizationId, workspaceId, engineId: randomUUID(), generation: fence,
        fence, token: randomBytes(32).toString("base64url") };
      host.authorize(authority);
      const service = new ResidentTerminalService({ hostId, socketPath, authority });
      cleanup.push(async () => service.disconnect());
      await service.connect(); return service;
    };
    let service = await connect(1);
    const sessionId = "pty-preserved-panel";
    const created = await service.create({ sessionId, cwd: root, cols: 80, rows: 24,
      env: { PATH: "/usr/bin:/bin" }, actorUserId: "actor-a", registryWorkspaceId: "local-main",
      environmentOwnerId: "actor-a", brokerId: randomUUID(),
      command: "stty -echo; printf 'READY\\n'; while IFS= read -r value; do printf 'VALUE:%s\\n' \"$value\"; done" });
    await expect.poll(async () => (await service.snapshot(sessionId)).data).toContain("READY");
    for (let fence = 2; fence <= 19; fence++) {
      await service.write(sessionId, `${fence}\n`, "actor-a");
      service.disconnect(); service = await connect(fence);
      expect(service.hasRecentInput()).toBe(true);
      expect(service.list()[0]).toMatchObject({ sessionId, pid: created.pid, actorUserId: "actor-a",
        registryWorkspaceId: "local-main", environmentOwnerId: "actor-a", brokerId: created.brokerId });
    }
    await expect.poll(async () => (await service.snapshot(sessionId)).data).toContain("VALUE:19");
    await service.resize(sessionId, 1000, 1);
    expect(service.get(sessionId)).toMatchObject({ cols: 500, rows: 2 });
    await expect(service.write(sessionId, "forbidden\n", "actor-b")).rejects.toThrow(/authority/);
    await service.close(sessionId);
    expect(service.list()).toEqual([]);
  });
});

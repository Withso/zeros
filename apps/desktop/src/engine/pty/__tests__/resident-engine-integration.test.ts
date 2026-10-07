import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { ZerosEngine } from "../../zeros-engine";
import { ResidentPtyHost } from "../resident-host";
import { ResidentTerminalService } from "../resident-service";
import type { TransportClient } from "../../transport/types";

it.runIf(process.platform === "linux")("reattaches the real engine terminal path with unchanged PID, redacted replay and a stable Git shim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-engine-resident-"));
  const hostId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID();
  const socketPath = path.join(root, "host.sock");
  const host = new ResidentPtyHost({ root, socketPath, organizationId, workspaceId, shell: "/bin/bash",
    identity: { uid: process.getuid!(), gid: process.getgid!() } });
  const engines: ZerosEngine[] = [];
  const client = (): TransportClient => ({ id: randomUUID(), kind: "cloud", accountUserId: "actor-a", authorized: () => true,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "developer", fingerprint: "a".repeat(64) },
    send: vi.fn(), close: vi.fn() });
  const connect = async (fence: number) => {
    const authority = { organizationId, workspaceId, engineId: randomUUID(), generation: fence, fence,
      token: randomBytes(32).toString("base64url") };
    host.authorize(authority);
    const resident = new ResidentTerminalService({ hostId, socketPath, authority });
    const engine = new ZerosEngine({ root, port: 0 }); engines.push(engine);
    Object.defineProperty(engine, "residentTerminals", { value: resident });
    Object.defineProperty(engine, "residentConfiguration", { value: { servicesRoot: root } });
    Object.defineProperty(engine, "cloudWorker", { value: { version: 4, uid: process.getuid!(), gid: process.getgid!(),
      toolchain: { node: process.execPath } } });
    const environment = vi.fn(async () => ({ version: 1, environment: { PRIVATE_VALUE: "synthetic-personal-value" } }));
    Object.defineProperty(engine, "cloudRuntimeRegistration", { value: { agentExecutionRequest: environment,
      gitAuthorRequest: async () => ({ name: "Test", email: "123+test@users.noreply.github.com" }) } });
    vi.spyOn(engine["workspace"], "workspaceIdForCwd").mockReturnValue(null);
    vi.spyOn(engine["pty"], "resolveCwd").mockReturnValue(root);
    vi.spyOn(engine["pty"], "isWithinAllowed").mockReturnValue(true);
    vi.spyOn(engine as unknown as { workspaceAllowsProcessStart(): boolean }, "workspaceAllowsProcessStart").mockReturnValue(true);
    vi.spyOn(engine as unknown as { terminalDesignWatchGuard(): Promise<null> }, "terminalDesignWatchGuard").mockResolvedValue(null);
    await engine["restoreResidentTerminals"]();
    return { engine, resident, environment };
  };
  try {
    await host.start();
    const first = await connect(1), a = client();
    const sessionId = "pty-engine-integration", message = { type: "PTY_CREATE" as const, sessionId,
      id: randomUUID(), source: "browser" as const, timestamp: Date.now(), cwd: root, cols: 80, rows: 24 };
    await first.engine["handlePtyCreate"](message, a);
    const original = first.resident.get(sessionId)!;
    expect(original.brokerId).not.toBeNull();
    await first.resident.write(sessionId, "stty -echo; printf '%s\\n' \"$PRIVATE_VALUE\"\n", "actor-a");
    await expect.poll(async () => (await first.resident.snapshot(sessionId)).data).toContain("[redacted]");
    const shimPath = path.join(root, `git-${original.brokerId}`, "git");
    const shim = await readFile(shimPath, "utf8");
    expect(shim).not.toContain("synthetic-personal-value");
    first.resident.disconnect();
    for (const broker of first.engine["residentGithubBrokers"].values()) await broker.stopAndProve();

    const second = await connect(2), next = client();
    await second.engine["handlePtyCreate"]({ ...message, id: randomUUID() }, next);
    expect(second.environment).not.toHaveBeenCalled();
    expect(second.resident.get(sessionId)?.pid).toBe(original.pid);
    expect(await readFile(shimPath, "utf8")).toBe(shim);
    expect(next.send).toHaveBeenCalledWith(expect.objectContaining({ type: "PTY_CREATED", pid: original.pid,
      reattached: true, replay: expect.stringContaining("[redacted]") }));
    expect(JSON.stringify(vi.mocked(next.send).mock.calls)).not.toContain("synthetic-personal-value");
    const other = { ...client(), accountUserId: "actor-b" };
    await second.engine["handlePtyCreate"](message, other);
    expect(other.send).toHaveBeenCalledWith(expect.objectContaining({ type: "PTY_EXIT" }));
    await second.engine["closeResidentTerminal"](sessionId);
    expect(() => process.kill(original.pid, 0)).toThrow();
    const create = second.resident.create.bind(second.resident);
    vi.spyOn(second.resident, "create").mockImplementationOnce(async launch => {
      const result = await create({ ...launch, command: "exit 7" });
      await expect.poll(() => second.resident.get(launch.sessionId)?.exited).toBe(true);
      return result;
    });
    const shortLived = "pty-exited-before-registry";
    await second.engine["handlePtyCreate"]({ ...message, sessionId: shortLived, id: randomUUID() }, next);
    expect(second.engine["terminals"].get(shortLived)?.exited).toBe(true);
    expect(next.send).toHaveBeenCalledWith(expect.objectContaining({ type: "PTY_EXIT", sessionId: shortLived, exitCode: 7 }));
  } finally {
    for (const engine of engines.reverse()) {
      engine["residentTerminals"]?.disconnect();
      for (const broker of engine["residentGithubBrokers"].values()) await broker.stopAndProve();
    }
    await host.stop(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks();
  }
});

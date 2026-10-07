import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ZerosEngine } from "../../zeros-engine";
import type { TransportClient } from "../../transport/types";
import type { ResidentTerminalService } from "../resident-service";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

it("routes qualified persistent cloud terminals through the resident and restores registry/privacy state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-routing-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const engine = new ZerosEngine({ root, port: 0 });
  const session = { sessionId: "pty-existing", pid: process.pid, cwd: root, cols: 80, rows: 24,
    createdAt: 1, actorUserId: "actor-a", registryWorkspaceId: "local-main", environmentOwnerId: "actor-a",
    brokerId: null, githubShared: false, exited: false };
  const resident = { connect: vi.fn(async () => {}), list: () => [session], get: () => session, has: () => true,
    events: vi.fn(), snapshot: vi.fn(async () => ({ data: "before", bytes: 6, truncated: false, sequence: 3 })),
    write: vi.fn(async () => {}), resize: vi.fn(async () => {}), close: vi.fn(async () => {}),
    create: vi.fn(async () => session), busy: () => false } as unknown as ResidentTerminalService;
  Object.defineProperty(engine, "residentTerminals", { value: resident });
  Object.defineProperty(engine, "cloudWorker", { value: { version: 4 } });
  const seam = engine as unknown as { restoreResidentTerminals(): Promise<void>; workspaceAllowsProcessStart(): boolean };
  vi.spyOn(seam, "workspaceAllowsProcessStart").mockReturnValue(true);
  vi.spyOn(engine["pty"], "resolveCwd").mockReturnValue(root);
  const localCreate = vi.spyOn(engine["pty"], "create");
  await seam.restoreResidentTerminals();
  expect(engine["terminals"].get(session.sessionId)).toMatchObject({ workspaceId: "local-main", createdAt: 1 });
  const a: TransportClient = { id: randomUUID(), kind: "cloud", accountUserId: "actor-a", authorized: () => true,
    cloudActor: { sessionId: randomUUID(), deviceId: randomUUID(), role: "developer", fingerprint: "a".repeat(64) },
    send: vi.fn(), close: vi.fn() };
  const b = { ...a, id: randomUUID(), accountUserId: "actor-b", send: vi.fn() };
  const base = { id: randomUUID(), source: "browser" as const, timestamp: Date.now(), sessionId: session.sessionId };
  await engine["handlePtyCreate"]({ ...base, type: "PTY_CREATE", cwd: root, cols: 80, rows: 24 }, a);
  expect(localCreate).not.toHaveBeenCalled();
  expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ type: "PTY_CREATED", reattached: true, replay: "before" }));
  // The shell can exit after has() admitted a reattach but before get(). Its
  // final snapshot still belongs to this request; do not close it underneath.
  session.exited = true;
  await engine["handlePtyCreate"]({ ...base, type: "PTY_CREATE", cwd: root, cols: 80, rows: 24 }, a);
  expect(resident.close).not.toHaveBeenCalled();
  session.exited = false;
  await engine["handlePtyCreate"]({ ...base, type: "PTY_CREATE", cwd: root, cols: 80, rows: 24 }, b);
  expect(b.send).toHaveBeenCalledWith(expect.objectContaining({ type: "PTY_EXIT" }));
  await engine["handleMessage"]({ ...base, type: "PTY_WRITE", data: "blocked" }, b);
  expect(resident.write).not.toHaveBeenCalled();
  await engine["handleMessage"]({ ...base, type: "PTY_WRITE", data: "allowed" }, a);
  expect(resident.write).toHaveBeenCalledWith(session.sessionId, "allowed", "actor-a");
  await engine["handleMessage"]({ ...base, type: "PTY_KILL" }, a);
  expect(resident.close).toHaveBeenCalledWith(session.sessionId);
  expect(engine["terminals"].get(session.sessionId)).toBeUndefined();
});

it("serializes credential preparation for the same resident terminal ID", async () => {
  const engine = new ZerosEngine({ root: process.cwd(), port: 0 });
  Object.defineProperty(engine, "residentTerminals", { value: { has: () => false } });
  const client: TransportClient = { id: "a", kind: "local", send: vi.fn(), close: vi.fn() };
  const message = { type: "PTY_CREATE" as const, id: randomUUID(), source: "browser" as const, timestamp: Date.now(), sessionId: "pty-race" };
  let finish!: () => void;
  const create = vi.spyOn(engine as unknown as { handlePtyCreateForWorkspace(): Promise<void> }, "handlePtyCreateForWorkspace")
    .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const first = engine["handlePtyCreate"](message, client);
  await new Promise(resolve => setImmediate(resolve));
  const second = engine["handlePtyCreate"](message, { ...client, id: "b" });
  await new Promise(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledTimes(1);
  finish(); await Promise.all([first, second]);
  expect(create).toHaveBeenCalledTimes(2);
});

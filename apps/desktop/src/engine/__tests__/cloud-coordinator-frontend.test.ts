import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudExecutionBoundary } from "../agents/containment/cloud-execution-boundary";
import { portableCloudWorkloads } from "../agents/containment/__tests__/helpers/portable-cloud-custody";
import { CloudTransport } from "../transport/cloud";
import { cloudCoordinatorFrontendSpawner } from "../cloud-coordinator-frontend";
import { CloudExecutionCoordinator } from "../cloud-execution-coordinator";

const configuration = vi.hoisted(() => ({ uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  version: 4 as const, backend: "cloud-worker" as const, profile: "zeros-cloud-worker-v4" as const,
  toolchain: { node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } }));
vi.mock("../agents/containment/cloud-worker-config", () => ({ isCloudWorkerConfiguration: (value: unknown) => value === configuration }));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => {
  const { testCloudRuntime } = await import("../agents/__tests__/helpers/test-cloud-runtime");
  return { ...await original<typeof import("../agents/containment/cloud-runtime-root.mjs")>(),
    resolveCloudRuntime: () => ({ ...testCloudRuntime(), node: process.execPath, workerRoot: process.cwd() }), assertCloudRuntimePath: vi.fn() };
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  const directory = mkdtempSync("/tmp/zeros-frontend-test-");
  const reserve = net.createServer(); await new Promise<void>(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = (reserve.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  const socket = path.join(directory, "public.sock"), loopback = path.join(directory, "loopback.sock");
  const token = `zwr_${"a".repeat(43)}`;
  const transport = new CloudTransport({ port, token: "qualification-only-token", internalReadiness: { token,
    read: () => ({ version: 1, instanceId: "11111111-1111-4111-8111-111111111111", protocolVersion: 1, health: "ready", durableRecordConnected: true }) } });
  transport.useCoordinatorSocket(socket, loopback); await transport.start();
  cleanup.push(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
  const workloads = portableCloudWorkloads(configuration), boundary = new CloudExecutionBoundary({ configuration, workloads });
  cleanup.push(async () => { await workloads.drain(workloads.fence()); });
  const originalPrepare = boundary.prepareOwned.bind(boundary);
  const prepare = vi.spyOn(boundary, "prepareOwned").mockImplementation(async (...args) => {
    const prepared = await originalPrepare(...args); vi.spyOn(prepared, "spawn"); return prepared;
  });
  const frames: unknown[] = [], exited = vi.fn();
  const launch = { frontendId: randomUUID(), signal: new AbortController().signal, message: (value: unknown) => frames.push(value), exited };
  const child = await cloudCoordinatorFrontendSpawner(boundary, socket, loopback, port)(launch);
  if (!child) throw new Error("unfenced frontend was deferred");
  cleanup.push(() => child.stopAndProve());
  await expect.poll(() => frames).toContainEqual({ type: "ready", frontendId: launch.frontendId });
  const request = (pathname: string, localAddress = "127.0.0.1") => new Promise<number>((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: pathname, localAddress,
      headers: { "x-zeros-readiness-token": token } }, response => { response.resume(); resolve(response.statusCode!); });
    req.on("error", reject);
  });
  return { child, request, prepare, frames, launch, exited, workloads, port, directory, socket, loopback, boundary };
}

describe.skipIf(process.platform !== "linux")("Host-owned cloud frontend (portable custody fixture, real processes)", () => {
  it("forwards unchanged authenticated bytes, retains the loopback probe boundary and owns no credential", async () => {
    const f = await fixture();
    expect(await f.request("/health")).toBe(200);
    expect(await f.request("/internal/readiness")).toBe(200);
    expect(await f.request("/internal/readiness", "127.0.0.2")).toBe(404);
    const prepared = await f.prepare.mock.results[0]!.value;
    // Host custody supervises the exact original child, and infrastructure
    // does not manufacture an active user workload in the idle census.
    expect(f.prepare.mock.calls[0]![1]).toMatchObject({ kind: "service", role: "infrastructure" });
    const spawn = vi.mocked(prepared.spawn).mock.calls[0]![0];
    // Assert names only: a future accidental inheritance must not print the
    // parent's credential values in assertion diagnostics.
    expect(Object.keys(spawn.env).sort()).toEqual(["LANG", "PATH"]);
    expect(spawn.args).toEqual([path.join(process.cwd(), "apps/desktop/src/engine/cloud-interactive-frontend.mjs")]);
    for (const filename of [f.socket, f.loopback]) {
      expect(lstatSync(filename).isSocket()).toBe(true);
      expect(lstatSync(filename).uid).toBe(process.geteuid!());
      expect(lstatSync(filename).mode & 0o777).toBe(0o600);
    }
    await expect.poll(async () => (await f.workloads.inspect()).complete).toBe(true);
    const census = await f.workloads.inspect(); expect(census.workloadPids).toEqual([]);
    const scope = f.workloads.snapshot().scopes[0]!;
    for (const pid of scope.processGroups) {
      const environment = readFileSync(`/proc/${pid}/environ`).toString().split("\0").filter(Boolean).map(value => value.split("=")[0]);
      expect(environment).not.toContain("ZEROS_CLOUD_RUNTIME");
      expect(environment).not.toContain("ZEROS_CLOUD_TOKEN");
      expect(environment).not.toContain("HOME");
    }
    expect(prepared).toBeDefined();
    const challengeId = randomUUID(); f.child.challenge(challengeId);
    await expect.poll(() => f.frames).toContainEqual({ type: "pong", frontendId: f.launch.frontendId, challengeId });
    await f.child.stopAndProve();
    await expect.poll(() => f.exited.mock.calls.length).toBeGreaterThan(0);
    await expect(f.request("/health")).rejects.toThrow();
    expect((await f.workloads.inspect()).workloadPids).toEqual([]);
  });

  it("rejects a forged boundary and cannot adopt a Local process", () => {
    expect(() => cloudCoordinatorFrontendSpawner(null, "/tmp/public.sock", "/tmp/loopback.sock", 12345)).toThrow();
  });

  it("recovers ingress after a reversible Host admission fence without attempting a fenced preparation", async () => {
    const f = await fixture(); await f.child.stopAndProve();
    const fence = f.workloads.fence({ preserveActive: true });
    const initialize = vi.fn(async () => {});
    const owner = new CloudExecutionCoordinator({ bootId: randomUUID(), initialize,
      spawn: cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port), changed() {} });
    cleanup.push(() => owner.stop());
    await owner.start();
    expect.soft(f.prepare).toHaveBeenCalledOnce();
    expect(owner.isInteractiveReady()).toBe(false);
    await f.workloads.joinPending(fence); f.workloads.resume(fence);
    await expect.poll(() => owner.isInteractiveReady(), { timeout: 3_000 }).toBe(true);
    expect(initialize).toHaveBeenCalledOnce();
    expect(await f.request("/health")).toBe(200);
  });

  it.each([true, false])("requires positive cleanup before retrying a failed native launch (proof=%s)", async proved => {
    const f = await fixture(); await f.child.stopAndProve();
    const originalPrepare = CloudExecutionBoundary.prototype.prepareOwned.bind(f.boundary);
    const retired = vi.fn();
    f.prepare.mockImplementation(async (...args) => {
      const prepared = await originalPrepare(...args), originalStop = prepared.stopAndProve.bind(prepared);
      vi.spyOn(prepared, "spawn").mockRejectedValue(new Error("native launch failed"));
      vi.spyOn(prepared, "stopAndProve").mockImplementation(async () => {
        retired();
        if (!proved) throw new Error("native retirement unknown");
        await originalStop();
      });
      return prepared;
    });
    const attempt = cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port)({
      ...f.launch, frontendId: randomUUID() });
    if (proved) {
      await expect(attempt).resolves.toBeNull();
      expect(f.workloads.snapshot().scopes).toHaveLength(0);
    } else await expect(attempt).rejects.toThrow("native retirement unknown");
    expect(retired).toHaveBeenCalledOnce();
  });

  it("refuses a private socket directory readable by another UID", async () => {
    const f = await fixture(); chmodSync(f.directory, 0o750);
    expect(() => cloudCoordinatorFrontendSpawner(f.boundary, f.socket, f.loopback, f.port)).toThrow("private owner directory");
    chmodSync(f.directory, 0o700);
  });

  it.each(["parent pipe loss", "oversized control frame", "foreign frontend"])("closes public ingress on %s", async kind => {
    const f = await fixture(), prepared = await f.prepare.mock.results[0]!.value;
    const process = await vi.mocked(prepared.spawn).mock.results[0]!.value;
    if (kind === "parent pipe loss") process.stdin!.end();
    else process.stdin!.write(kind === "oversized control frame" ? "x".repeat(4097) :
      `${JSON.stringify({ type: "ping", frontendId: randomUUID(), challengeId: randomUUID() })}\n`);
    await expect.poll(() => f.exited.mock.calls.length).toBeGreaterThan(0);
    await expect(f.request("/health")).rejects.toThrow();
    await f.child.stopAndProve();
  });
});

it("cleans the first private listener when the second listener cannot start", async () => {
  const directory = mkdtempSync("/tmp/zeros-frontend-listen-");
  const socket = path.join(directory, "public.sock"), loopback = path.join(directory, "loopback.sock");
  const transport = new CloudTransport({ port: 23456, token: "qualification-only-token" });
  cleanup.push(async () => { await transport.stop(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(socket, "occupied", { mode: 0o600 }); transport.useCoordinatorSocket(socket, loopback);
  await expect(transport.start()).rejects.toThrow();
  expect(existsSync(loopback)).toBe(false);
  expect(readFileSync(socket, "utf8")).toBe("occupied");
});

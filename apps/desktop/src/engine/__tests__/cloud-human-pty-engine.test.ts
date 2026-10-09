import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {ZerosEngine} from "../zeros-engine";
import {HostExecutionBoundary} from "../agents/containment/host-boundary";
import {CloudExecutionBoundary} from "../agents/containment/cloud-execution-boundary";
import {portableCloudWorkloads} from "../agents/containment/__tests__/helpers/portable-cloud-custody";
import type {EngineMessage} from "../types";
import type {TransportClient} from "../transport/types";

const configuration = vi.hoisted(() => ({version: 4 as const, backend: "cloud-worker" as const,
  profile: "zeros-cloud-worker-v4" as const, uid: process.geteuid?.() ?? 0, gid: process.getegid?.() ?? 0,
  toolchain: {node: process.execPath, supervisor: `${process.cwd()}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs`}}));
vi.mock("../agents/containment/cloud-worker-config", async original => ({
  ...await original<typeof import("../agents/containment/cloud-worker-config")>(),
  isCloudWorkerConfiguration: (value: unknown) => value === configuration,
}));
vi.mock("../agents/containment/cloud-runtime-root.mjs", async original => ({
  ...await original<typeof import("../agents/containment/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: (await import("../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime,
}));
vi.mock("../pty/node-pty-spawn", () => ({createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn()}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "engine-human-pty-")); cleanup.push(() => rm(root, {recursive: true, force: true}));
  const registry = portableCloudWorkloads(configuration); cleanup.push(() => registry.drain(registry.fence()));
  const boundary = new CloudExecutionBoundary({projectRoot: process.cwd(), configuration, workloads: registry});
  const engine = new ZerosEngine({root, executionBoundary: new HostExecutionBoundary({projectRoot: root})});
  Object.assign(engine, {cloudWorker: configuration, cloudWorkloads: registry, cloudExecutionBoundary: boundary});
  vi.spyOn(engine["workspace"], "workspaceIdForCwd").mockReturnValue("local-main");
  vi.spyOn(engine["pty"], "resolveCwd").mockReturnValue(root);
  Object.assign(engine, {workspaceAllowsProcessStart: vi.fn(() => true), terminalDesignWatchGuard: vi.fn(async () => null)});
  let live = false;
  vi.spyOn(engine["pty"], "has").mockImplementation(() => live);
  const create = vi.spyOn(engine["pty"], "create").mockImplementation(options => {
    const reattached = live; live = true;
    return {sessionId: options.sessionId, pid: 123, cwd: root, cols: 80, rows: 24, reattached};
  });
  const client: TransportClient = {id: "original-human", kind: "local", send: vi.fn(), close: vi.fn()};
  const message: Extract<EngineMessage, {type: "PTY_CREATE"}> = {type: "PTY_CREATE", id: "terminal-create",
    timestamp: 1, source: "browser", sessionId: "same-terminal", workspaceId: "local-main", cwd: root};
  return {root, registry, boundary, engine, create, client, message};
}
describe("original cloud human PTY admission", () => {
  it("owns the exact scope before exposing a native spawn wrapper", async () => {
    const f = await fixture(); await f.engine["handlePtyCreate"](f.message, f.client);
    expect(f.registry.snapshot().scopes).toHaveLength(1);
    expect(f.registry.snapshot().scopes[0]).toMatchObject({kind: "terminal", role: "workload", state: "active"});
    expect(f.create.mock.calls[0][0]).toMatchObject({wrapSpawn: expect.any(Function), onSpawned: expect.any(Function),
      onSpawnFailed: expect.any(Function), onExit: expect.any(Function)});
  });
  it("does not retain an unused second scope when concurrent creation becomes a reattach", async () => {
    const f = await fixture(), original = f.boundary.prepareOwned.bind(f.boundary);
    let release!: () => void; const held = new Promise<void>(resolve => {release = resolve;});
    const preparing = vi.spyOn(f.boundary, "prepareOwned").mockImplementation(async (...args) => {
      const scope = await original(...args); await held; return scope;
    });
    const a = f.engine["handlePtyCreate"](f.message, f.client), b = f.engine["handlePtyCreate"]({...f.message, id: "terminal-create-2"}, f.client);
    try {await expect.poll(() => preparing.mock.calls.length).toBe(2);} finally {release();}
    await Promise.all([a, b]);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.registry.snapshot().scopes).toHaveLength(1);
    expect(f.engine["cloudHumanPtyScopes"].get(f.message.sessionId)).toBeDefined();
  });
  it("does not launch when the original shared fence arrives during preparation", async () => {
    const f = await fixture(), original = f.boundary.prepareOwned.bind(f.boundary);
    let release!: () => void; const held = new Promise<void>(resolve => {release = resolve;});
    const preparing = vi.spyOn(f.boundary, "prepareOwned").mockImplementation(async (...args) => {
      const scope = await original(...args); await held; return scope;
    });
    const launch = f.engine["handlePtyCreate"](f.message, f.client);
    await expect.poll(() => preparing.mock.calls.length).toBe(1);
    const ticket = f.registry.fence(); await f.registry.drain(ticket); release();
    await launch.catch(() => {});
    expect(f.create).not.toHaveBeenCalled(); expect(f.registry.snapshot().scopes).toEqual([]);
  });
});

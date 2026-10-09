import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignCaptureService } from "../design/capture-service";

const capture = vi.hoisted(() => ({ start: vi.fn(), configure: vi.fn(), ensurePrimary: vi.fn() }));
const ownershipRecovery = vi.hoisted(() => vi.fn());
vi.mock("../files/cloud-workspace-ownership", async original => ({ ...await original<object>(), recoverCloudWorkspaceOwnership: ownershipRecovery }));
vi.mock("../design/capture-cloud", () => ({ startCloudDesignCapture: capture.start }));
vi.mock("../design/capture-client", async original => ({ ...await original<object>(), setDesignCaptureConfig: capture.configure }));
vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({ disposeCursorHost: vi.fn() }));
vi.mock("../git/credential-broker", () => ({ closeGitCredentialBroker: vi.fn(), prepareGitCredentialShellEnvironment: vi.fn(), setGitCredentialSource: vi.fn() }));
vi.mock("../settings/files", async original => ({ ...await original<object>(), seedUserSettingsFromLegacyRoot: vi.fn() }));
vi.mock("../settings/watch", () => ({ startSettingsWatcher: () => ({ stop: vi.fn() }) }));
vi.mock("../git/watch", () => ({ startGitWatcher: () => ({ stop: vi.fn() }) }));
vi.mock("../agents/session-paths", async original => ({ ...await original<object>(), sweepDeadSessions: async () => 0 }));
vi.mock("../framework-detector", async original => ({ ...await original<object>(), detectFramework: () => ({ framework: "unknown" }) }));
vi.mock("../git/cloud-primary-workspace", () => ({ ensureCloudPrimaryWorkspace: capture.ensurePrimary }));
vi.mock("../db/state-import", () => ({ migrateLegacyStateDb: vi.fn() }));
vi.mock("../db/legacy-import", () => ({ migrateLegacyAgentHistory: vi.fn() }));
vi.mock("../db/projects", async original => ({ ...await original<object>(), pruneWorktreeRepos: () => 0 }));
vi.mock("../db/chats", async original => ({ ...await original<object>(), backfillChatWorkspaceIds: () => 0 }));
vi.mock("../db/messages", async original => ({ ...await original<object>(), backfillChatMessageRevs: () => 0 }));
vi.mock("../git/state", async original => ({ ...await original<object>(),
  listWorkspaces: () => [], listWorkspaceLifecycles: () => [],
  worktreesRoot: () => "/unused/worktrees", legacyWorktreesRoot: () => "/unused/legacy-worktrees",
  seedFromDisk: () => ({ inserted: 0 }), migrateLegacyWorktreeSeeds: () => ({ migrated: 0 }),
}));
vi.mock("../git/worktree", async original => ({ ...await original<object>(),
  reconcileInterruptedWorkspaceLifecycles: async () => ({ recovered: 0, failed: 0 }),
  migrateWorktreesToNewRoot: vi.fn(), pruneOrphanArchiveSnapshots: vi.fn(), pruneOrphanWorkspaceBranchOwnershipRefs: vi.fn(),
}));
vi.mock("../git/cleanup", async original => ({ ...await original<object>(), pruneStaleHeavyDirTrash: async () => 0 }));
vi.mock("../git/turn-recovery", () => ({ settleOrphanRunningTurns: async () => 0, repairUnattributedFinishedTurns: async () => 0 }));

import { ZerosEngine } from "../zeros-engine";
import { RoutingExecutionBoundary } from "../agents/containment/routing-boundary";

function fixture(cloud = true) {
  const local = { start: vi.fn(), stop: vi.fn(), actualPort: 39393 };
  return Object.assign(Object.create(ZerosEngine.prototype), {
    running: false, root: "/unused/startup-fixture", port: 39393,
    cloudWorker: cloud ? {} : null, cloudRuntimeConfig: cloud ? { execution: {} } : null,
    executionBoundary: { recoverStaleProcesses: vi.fn(), recoverStaleMutableState: vi.fn() },
    workspace: { codeReviewOwnerRoots: vi.fn(() => ["/srv/zeros/workspace", "/srv/zeros/workspace/nested-owner"]) },
    restoreResidentTerminals: vi.fn(), publishLocalAuthorityToHost: vi.fn(),
    setupHostControlChannel: vi.fn(), setupParentDeathWatchdog: vi.fn(),
    local, transports: [local], setup: { reconcileStaleRuns: vi.fn() },
    activityHeartbeat: { start: vi.fn(), stop: vi.fn() },
    cloudRuntimeRegistration: cloud ? { start: vi.fn(), stop: vi.fn() } : null,
    cloudEvents: cloud ? { start: vi.fn(), close: vi.fn() } : null,
    cloudIdleStop: { close: vi.fn() }, startGateway: vi.fn(), writePortFile: vi.fn(),
    agents: { revokeSessionTools: vi.fn(), dispose: vi.fn() },
    pty: { killAll: vi.fn() }, terminals: { clear: vi.fn() }, watcher: { stop: vi.fn() },
    removePortFile: vi.fn(), clearBusy: vi.fn(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  capture.start.mockResolvedValue(undefined);
  capture.ensurePrimary.mockResolvedValue(undefined);
  ownershipRecovery.mockReset().mockReturnValue({ visited: 3, published: 2, skipped: 1, failed: 0, bounded: false });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("engine startup readiness", () => {
  it.each(["Personal", "organization"])("starts %s Local with valid and malformed legacy process records", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-legacy-"));
    const previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    const engine = fixture(false);
    try {
      const generation = path.join(dataRoot, "sessions", "valid", "boundary", "generation");
      const valid = path.join(generation, "commands", "process-domain.json");
      await mkdir(path.dirname(valid), { recursive: true });
      const descriptor = JSON.stringify({
        version: 1, platform: "darwin", generation: "generation",
        markerPath: path.join(generation, "tools", "process-domain.marker"),
        policyPath: path.join(generation, "policy.json"), ownerUid: process.getuid?.() ?? 0,
        engine: { version: 1, pid: process.pid, uid: process.getuid?.() ?? 0, startSec: "1", startUsec: "0" },
        createdAt: 1,
      });
      await writeFile(valid, descriptor, { mode: 0o600 });
      const malformed = path.join(dataRoot, "sessions", "malformed", "boundary", "generation", "commands", "process-domain.json");
      await mkdir(path.dirname(malformed), { recursive: true });
      await writeFile(malformed, "not JSON", { mode: 0o600 });
      const host = {
        backend: "none" as const, probe: vi.fn(), prepare: vi.fn(),
        recoverStaleProcesses: vi.fn(async () => ({ discovered: 0, recovered: 0, active: 0, preserved: 0 })),
      };
      engine.executionBoundary = new RoutingExecutionBoundary({ host });

      await expect(engine.start()).resolves.toBeUndefined();
      expect(host.recoverStaleProcesses).toHaveBeenCalledOnce();
      expect(engine.local.start).toHaveBeenCalledOnce();
      expect(engine.running).toBe(true);
      expect(console.warn).toHaveBeenCalled();
      expect(await readFile(valid, "utf8")).toBe(descriptor);
      expect(capture.start).not.toHaveBeenCalled();
      expect(ownershipRecovery).not.toHaveBeenCalled();
      await engine.stop();
    } finally {
      if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataDir;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("repairs v4 checkout ownership before restoring tenant processes or opening transports", async () => {
    const engine = fixture();
    engine.cloudWorker = { version: 4, uid: 10001, gid: 10001 };
    await engine.start();
    expect(ownershipRecovery).toHaveBeenCalledWith(engine.cloudWorker, {
      privateRoots: expect.arrayContaining([expect.any(String)]),
      ownerRoots: ["/srv/zeros/workspace", "/srv/zeros/workspace/nested-owner"],
    });
    expect(ownershipRecovery.mock.invocationCallOrder[0]).toBeLessThan(engine.restoreResidentTerminals.mock.invocationCallOrder[0]);
    expect(ownershipRecovery.mock.invocationCallOrder[0]).toBeLessThan(engine.local.start.mock.invocationCallOrder[0]);
    await engine.stop();
  });

  it("opens no authority when the v4 ownership root fails validation", async () => {
    const engine = fixture();
    engine.cloudWorker = { version: 4, uid: 10001, gid: 10001 };
    ownershipRecovery.mockImplementation(() => { throw new Error("Cloud checkout ownership root changed"); });
    await expect(engine.start()).rejects.toThrow("Cloud checkout ownership root changed");
    expect(engine.restoreResidentTerminals).not.toHaveBeenCalled();
    expect(engine.local.start).not.toHaveBeenCalled();
  });

  it("keeps readiness and tenant processes closed until every bounded repair slice completes", async () => {
    const engine = fixture();
    engine.cloudWorker = { version: 4, uid: 10001, gid: 10001 };
    let finish!: (value: object) => void;
    ownershipRecovery.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const startup = engine.start();
    await vi.waitFor(() => expect(ownershipRecovery).toHaveBeenCalledOnce());
    expect(engine.restoreResidentTerminals).not.toHaveBeenCalled();
    expect(engine.local.start).not.toHaveBeenCalled();
    expect(engine.cloudRuntimeRegistration.start).not.toHaveBeenCalled();
    finish({ visited: 8, published: 8, skipped: 0, failed: 0, bounded: false });
    await startup;
    expect(engine.local.start).toHaveBeenCalledOnce();
    await engine.stop();
  });

  it("lets a delayed optional cloud capture start after durable readiness", async () => {
    let release!: (service: DesignCaptureService) => void;
    capture.start.mockReturnValue(new Promise<DesignCaptureService>(resolve => { release = resolve; }));
    const engine = fixture();
    let ready = false;
    const failed = vi.fn();
    const startup = engine.start().then(() => { ready = true; }, failed);
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(ready).toBe(true);
    expect(failed).not.toHaveBeenCalled();
    expect(engine.cloudRuntimeRegistration.start).toHaveBeenCalledOnce();
    expect(engine.cloudEvents.start).toHaveBeenCalledOnce();
    const service = { url: "http://127.0.0.1:12345", token: "fixture", stop: vi.fn() };
    release(service);
    await startup;
    await vi.waitFor(() => expect(capture.configure).toHaveBeenCalledWith(service));
    await engine.stop();
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it("keeps initial durable synchronization mandatory and starts no optional task on failure", async () => {
    const engine = fixture();
    engine.cloudRuntimeRegistration.start.mockRejectedValue(new Error("durable sync failed"));
    await expect(engine.start()).rejects.toThrow("cloud engine durable registration failed");
    expect(engine.running).toBe(false);
    expect(engine.cloudEvents.start).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(capture.configure).not.toHaveBeenCalled();
  });

  it("cannot publish readiness after mandatory process recovery fails", async () => {
    const engine = fixture();
    engine.executionBoundary.recoverStaleProcesses.mockRejectedValue(new Error("unretired process"));
    await expect(engine.start()).rejects.toThrow("unretired process");
    expect(engine.local.start).not.toHaveBeenCalled();
    expect(engine.cloudRuntimeRegistration.start).not.toHaveBeenCalled();
    expect(engine.running).toBe(false);
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("retires a capture service that finishes after the engine stopped", async () => {
    let release!: (service: DesignCaptureService) => void;
    capture.start.mockReturnValue(new Promise<DesignCaptureService>(resolve => { release = resolve; }));
    const engine = fixture();
    await engine.start();
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
    await engine.stop();
    const service = { url: "http://127.0.0.1:12345", token: "fixture", stop: vi.fn() };
    release(service);
    await vi.waitFor(() => expect(service.stop).toHaveBeenCalledOnce());
    expect(capture.configure).not.toHaveBeenCalled();
  });

  it("leaves a failed optional capture unavailable while the durable engine stays ready", async () => {
    capture.start.mockRejectedValue(new Error("capture unavailable"));
    const engine = fixture();
    await engine.start();
    await vi.waitFor(() => expect(capture.start).toHaveBeenCalledOnce());
    expect(engine.running).toBe(true);
    expect(engine.cloudEvents.start).toHaveBeenCalledOnce();
    expect(capture.configure).not.toHaveBeenCalled();
    await engine.stop();
  });

  it.each(["Personal", "organization"])("keeps %s Local startup independent of cloud capture and registration", async () => {
    const engine = fixture(false);
    await engine.start();
    expect(engine.local.start).toHaveBeenCalledOnce();
    expect(engine.running).toBe(true);
    expect(capture.start).not.toHaveBeenCalled();
    expect(capture.ensurePrimary).not.toHaveBeenCalled();
    expect(ownershipRecovery).not.toHaveBeenCalled();
    await engine.stop();
  });
});

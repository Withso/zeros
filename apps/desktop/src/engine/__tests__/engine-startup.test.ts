import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty/node-pty-spawn", () => ({ createNodePtyShell: vi.fn(), createTerminalMirror: vi.fn(), disposePtyHost: vi.fn() }));
vi.mock("../agents/adapters/cursor-sdk/host/host-client", () => ({ disposeCursorHost: vi.fn() }));
vi.mock("../git/credential-broker", () => ({ closeGitCredentialBroker: vi.fn(), prepareGitCredentialShellEnvironment: vi.fn(), setGitCredentialSource: vi.fn() }));
vi.mock("../settings/files", async original => ({ ...await original<object>(), seedUserSettingsFromLegacyRoot: vi.fn() }));
vi.mock("../settings/watch", () => ({ startSettingsWatcher: () => ({ stop: vi.fn() }) }));
vi.mock("../git/watch", () => ({ startGitWatcher: () => ({ stop: vi.fn() }), onWorktreeContentChange: () => () => {} }));
vi.mock("../agents/session-paths", async original => ({ ...await original<object>(), sweepDeadSessions: async () => 0 }));
vi.mock("../framework-detector", async original => ({ ...await original<object>(), detectFramework: () => ({ framework: "unknown" }) }));
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

function fixture() {
  const local = { start: vi.fn(), stop: vi.fn(), actualPort: 39393 };
  return Object.assign(Object.create(ZerosEngine.prototype), {
    running: false, root: "/unused/startup-fixture", port: 39393,
    executionBoundary: { recoverStaleProcesses: vi.fn(), recoverStaleMutableState: vi.fn() },
    publishLocalAuthorityToHost: vi.fn(),
    setupHostControlChannel: vi.fn(), setupParentDeathWatchdog: vi.fn(),
    local, transports: [local], setup: { reconcileStaleRuns: vi.fn() },
    activityHeartbeat: { start: vi.fn(), stop: vi.fn() },
    startGateway: vi.fn(), writePortFile: vi.fn(),
    scopedMcpGateways: { stop: vi.fn() }, mcpCallback: { stop: vi.fn() },
    mcpHost: { close: vi.fn() }, vaultConfirmation: { close: vi.fn() },
    launchedMcp: { stop: vi.fn() }, organizationMcp: { reset: vi.fn() },
    mcpProbes: new Map<string, AbortController>(),
    agents: { revokeSessionTools: vi.fn(), dispose: vi.fn() },
    pty: { killAll: vi.fn() }, terminals: { clear: vi.fn() }, watcher: { stop: vi.fn() },
    removePortFile: vi.fn(), clearBusy: vi.fn(),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("engine startup readiness", () => {
  it.each(["Personal", "organization"])("starts %s Local with valid and malformed legacy process records", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-legacy-"));
    const previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = dataRoot;
    const engine = fixture();
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
      await engine.stop();
    } finally {
      if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataDir;
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it("cannot publish readiness after mandatory process recovery fails", async () => {
    const engine = fixture();
    engine.executionBoundary.recoverStaleProcesses.mockRejectedValue(new Error("unretired process"));
    await expect(engine.start()).rejects.toThrow("unretired process");
    expect(engine.local.start).not.toHaveBeenCalled();
    expect(engine.running).toBe(false);
  });

  it.each(["Personal", "organization"])("starts and stops %s Local", async () => {
    const engine = fixture();
    await engine.start();
    expect(engine.local.start).toHaveBeenCalledOnce();
    expect(engine.running).toBe(true);
    await engine.stop();
    expect(engine.scopedMcpGateways.stop).toHaveBeenCalledOnce();
    expect(engine.mcpCallback.stop).toHaveBeenCalledOnce();
    expect(engine.mcpHost.close).toHaveBeenCalledOnce();
    expect(engine.vaultConfirmation.close).toHaveBeenCalledOnce();
    expect(engine.launchedMcp.stop).toHaveBeenCalledOnce();
    expect(engine.organizationMcp.reset).toHaveBeenCalledOnce();
    expect(engine.running).toBe(false);
  });
});

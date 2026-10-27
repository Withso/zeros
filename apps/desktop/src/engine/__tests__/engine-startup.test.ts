import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../git/types";

const maintenance = vi.hoisted(() => ({
  archiveRefs: vi.fn(),
  branchRefs: vi.fn(),
  cleanup: vi.fn(),
  transition: vi.fn(),
  workspaces: [] as Workspace[],
}));

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
  listWorkspaces: () => maintenance.workspaces,
  getWorkspaceById: (id: string) => maintenance.workspaces.find((workspace) => workspace.id === id) ?? null,
  listWorkspaceLifecycles: () => [], getWorkspaceLifecycle: () => null,
  worktreesRoot: () => "/unused/worktrees", legacyWorktreesRoot: () => "/unused/legacy-worktrees",
  seedFromDisk: () => ({ inserted: 0 }), migrateLegacyWorktreeSeeds: () => ({ migrated: 0 }),
}));
vi.mock("../git/worktree", async original => ({ ...await original<object>(),
  reconcileInterruptedWorkspaceLifecycles: async () => ({ recovered: 0, failed: 0 }),
  migrateWorktreesToNewRoot: vi.fn(), pruneOrphanArchiveSnapshots: maintenance.archiveRefs, pruneOrphanWorkspaceBranchOwnershipRefs: maintenance.branchRefs,
}));
vi.mock("../git/cleanup", async original => ({ ...await original<object>(), pruneStaleHeavyDirTrash: async () => 0 }));
vi.mock("../git/turn-recovery", () => ({ settleOrphanRunningTurns: async () => 0, repairUnattributedFinishedTurns: async () => 0 }));
vi.mock("../git/design-mode", async original => ({ ...await original<object>(), reconcileDesignModeTransition: maintenance.transition }));
vi.mock("../design/workspace-lock", async original => ({ ...await original<object>(), cleanupLegacyDesignFilesystemGuards: maintenance.cleanup }));

import { ZerosEngine } from "../zeros-engine";
import { RoutingExecutionBoundary } from "../agents/containment/routing-boundary";
import * as mutations from "../git/mutation-lock";

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
    workspace: { stopDesignPreviews: vi.fn() },
    pty: { killAll: vi.fn() }, terminals: { clear: vi.fn() }, watcher: { stop: vi.fn() },
    removePortFile: vi.fn(), clearBusy: vi.fn(),
  });
}

function storedWorkspace(root: string, options: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_local", placement: "local", repoRoot: root, repoSlug: "repo", path: root,
    branch: "main", baseBranch: "main", status: "in-progress", createdAt: 1, archivedAt: null,
    stashRef: null, prNumber: null, prState: null, prUrl: null, agentId: null, lastActiveAt: null,
    ...options,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  maintenance.archiveRefs.mockReset().mockResolvedValue(0);
  maintenance.branchRefs.mockReset().mockResolvedValue(0);
  maintenance.cleanup.mockReset().mockResolvedValue(undefined);
  maintenance.transition.mockReset().mockResolvedValue(undefined);
  maintenance.workspaces = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("engine startup readiness", () => {
  it("keeps cloud rows out of Local transition and filesystem maintenance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-placement-"));
    const localPath = path.join(root, "local");
    await mkdir(localPath);
    maintenance.workspaces = [
      storedWorkspace(root, { id: "cloud-a", organizationId: "org-a", placement: "cloud" }),
      storedWorkspace(localPath),
    ];
    let finish!: () => void;
    const visitedLocal = new Promise<void>((resolve) => { finish = resolve; });
    maintenance.cleanup.mockImplementation(async (cwd: string) => { if (cwd === localPath) finish(); });
    const engine = fixture();
    try {
      await engine.start();
      await visitedLocal;
      expect(maintenance.transition).toHaveBeenCalledExactlyOnceWith("ws_local");
      expect(maintenance.cleanup).toHaveBeenCalledExactlyOnceWith(localPath);
    } finally {
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires active owners before joining maintenance waiting on their mutation lane", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-shutdown-"));
    maintenance.workspaces = [storedWorkspace(root)];
    let release!: () => void;
    let entered!: () => void;
    const owned = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const mutation = mutations.withWorkspaceMutation(root, async () => { entered(); await held; });
    await owned;
    const admission = vi.spyOn(mutations, "withWorkspaceMutation");
    const engine = fixture();
    engine.agents.dispose.mockImplementation(async () => { release(); await mutation; });
    await engine.start();
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
      stopping = engine.stop();
      await vi.waitFor(() => expect(engine.agents.dispose).toHaveBeenCalledOnce());
    } finally {
      release();
      await stopping;
      await engine.stop();
      await mutation;
      await rm(root, { recursive: true, force: true });
    }
    expect(maintenance.cleanup).not.toHaveBeenCalled();
  });

  it("cancels queued maintenance without waiting for an unrelated Git operation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-queued-stop-"));
    maintenance.workspaces = [storedWorkspace(root)];
    let release!: () => void;
    let entered!: () => void;
    const owned = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const mutation = mutations.withWorkspaceGitMutation(root, async () => { entered(); await held; });
    await owned;
    const admission = vi.spyOn(mutations, "withWorkspaceMutation");
    const engine = fixture();
    let stopping: Promise<void> | undefined;
    try {
      await engine.start();
      await vi.waitFor(() => expect(admission).toHaveBeenCalledOnce());
      stopping = engine.stop();
      await vi.waitFor(() => expect(engine.local.stop).toHaveBeenCalledOnce());
      expect(maintenance.cleanup).not.toHaveBeenCalled();
    } finally {
      release();
      await mutation;
      await stopping;
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
    expect(maintenance.cleanup).not.toHaveBeenCalled();
  });

  it.each([null, "organization-a"])("serves Local owner %s before legacy ACL cleanup finishes", async (organizationId) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-startup-acls-"));
    maintenance.workspaces = [storedWorkspace(root, { organizationId })];
    const engine = fixture();
    let release!: () => void;
    maintenance.cleanup.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    const started = engine.start();
    try {
      await vi.waitFor(() => expect(maintenance.cleanup).toHaveBeenCalledOnce());
      expect(maintenance.transition).toHaveBeenCalledOnce();
      expect(engine.local.start).toHaveBeenCalledOnce();
      expect(engine.running).toBe(true);
    } finally {
      release();
      await started;
      await engine.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["Personal", "organization"])("serves %s Local before slow archive maintenance completes", async () => {
    const engine = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    maintenance.archiveRefs.mockReturnValue(held);
    const started = engine.start();
    try {
      await vi.waitFor(() => expect(maintenance.archiveRefs).toHaveBeenCalledOnce());
      expect(engine.local.start).toHaveBeenCalledOnce();
      expect(engine.running).toBe(true);
    } finally {
      release();
      await started;
      await engine.stop();
    }
  });

  it("retires maintenance on shutdown before starting another repository scan", async () => {
    const engine = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    maintenance.archiveRefs.mockReturnValue(held);
    const started = engine.start();
    try {
      await vi.waitFor(() => expect(maintenance.archiveRefs).toHaveBeenCalledOnce());
      const stopped = engine.stop();
      release();
      await Promise.all([started, stopped]);
      expect(maintenance.branchRefs).not.toHaveBeenCalled();
      expect(engine.running).toBe(false);
    } finally {
      release();
      await started;
      await engine.stop();
    }
  });

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
    expect(engine.workspace.stopDesignPreviews).toHaveBeenCalledOnce();
  });
});

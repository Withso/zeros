import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclHarness = vi.hoisted(() => ({
  unfence: vi.fn<() => Promise<{ changed: number; failed: string[] }>>(),
  unlock: vi.fn<() => Promise<{ changed: number; failed: string[] }>>(),
  workspace: null as { id: string } | null,
  cleanupState: null as string | null,
}));

vi.mock("../../files/design-lock", () => ({
  designLockSupported: () => true,
  unfenceDesignDirFiles: aclHarness.unfence,
  unlockCodebase: aclHarness.unlock,
}));

vi.mock("../directory-registry", () => ({
  designDirectoryNameFor: () => "Zeros Design",
}));

vi.mock("../directory", () => ({
  discoverDesignDirectories: () => Promise.resolve([]),
}));

vi.mock("../../git/state", () => ({
  getWorkspaceByPath: () => aclHarness.workspace,
  getWorkspaceMeta: () => aclHarness.cleanupState,
  setWorkspaceMeta: (_id: string, _key: string, value: string) => { aclHarness.cleanupState = value; },
}));

import type { DesignLockTurn } from "../../files/design-lock";
import {
  LEGACY_DESIGN_ACL_RETRY_MS,
  legacyDesignAclCleanupDue,
  cleanupLegacyDesignFilesystemGuards,
  unfenceDesignDirectory,
  unlockLegacyDesignWorkspaceLock,
} from "../workspace-lock";

describe("Design filesystem compatibility cleanup", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-workspace-lock-"));
    aclHarness.unfence
      .mockReset()
      .mockResolvedValue({ changed: 0, failed: [] });
    aclHarness.unlock.mockReset().mockResolvedValue({ changed: 0, failed: [] });
    aclHarness.workspace = null;
    aclHarness.cleanupState = null;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("treats an absent first-use Design directory as already released", async () => {
    await unfenceDesignDirectory(root);

    expect(aclHarness.unfence).not.toHaveBeenCalled();
  });

  it("removes both historical whole-tree and Design-directory ACLs", async () => {
    await mkdir(path.join(root, "Zeros Design"));

    await cleanupLegacyDesignFilesystemGuards(root);

    expect(aclHarness.unlock).toHaveBeenCalledTimes(1);
    expect(aclHarness.unfence).toHaveBeenCalledTimes(1);
  });

  it("waits out the retry interval at launch after a sweep that could not finish, while explicit callers still sweep", async () => {
    aclHarness.workspace = { id: "ws_stuck" };
    await mkdir(path.join(root, "Zeros Design"));
    aclHarness.unlock.mockResolvedValue({ changed: 10, failed: ["locked.txt"] });
    expect(legacyDesignAclCleanupDue(root)).toBe(true);
    await expect(cleanupLegacyDesignFilesystemGuards(root)).rejects.toThrow(/1 path/);
    expect(aclHarness.cleanupState).toMatch(/^deferred:\d+$/);
    expect(legacyDesignAclCleanupDue(root)).toBe(false);
    expect(legacyDesignAclCleanupDue(root, Date.now() + LEGACY_DESIGN_ACL_RETRY_MS)).toBe(true);
    // Design mode and archive call it directly and still sweep.
    aclHarness.unlock.mockResolvedValue({ changed: 10, failed: [] });
    await cleanupLegacyDesignFilesystemGuards(root);
    expect(aclHarness.unlock).toHaveBeenCalledTimes(2);
    expect(aclHarness.cleanupState).toBe("complete");
    expect(legacyDesignAclCleanupDue(root)).toBe(false);
  });

  it("runs both phases of the sweep in the caller's turns", async () => {
    await mkdir(path.join(root, "Zeros Design"));
    const turn: DesignLockTurn = (step) => step();
    await cleanupLegacyDesignFilesystemGuards(root, turn);
    expect(aclHarness.unlock).toHaveBeenCalledWith(root, turn);
    expect(aclHarness.unfence).toHaveBeenCalledWith(root, "Zeros Design", turn);
  });

  it("does not rescan a workspace after its durable cleanup completed", async () => {
    aclHarness.workspace = { id: "ws_clean" };
    aclHarness.cleanupState = "complete";
    await mkdir(path.join(root, "Zeros Design"));

    await cleanupLegacyDesignFilesystemGuards(root);
    await unfenceDesignDirectory(root);
    await unlockLegacyDesignWorkspaceLock(root);

    expect(aclHarness.unlock).not.toHaveBeenCalled();
    expect(aclHarness.unfence).not.toHaveBeenCalled();
  });
});

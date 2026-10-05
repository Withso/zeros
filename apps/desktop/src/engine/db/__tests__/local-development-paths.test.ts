import path from "node:path";
import { homedir } from "node:os";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  appIdentity,
  zerosDataDir,
  zerosDbPath,
  zerosStateRoot,
  zerosWorkspacesRoot,
} from "../paths";
import { userSettingsDir } from "../../settings/files";
import {
  detachLockPath,
  legacyWorktreesRoot,
  stateDbPath,
  zerosStateRoot as gitStateRoot,
} from "../../git/state";
import { closeZerosDb } from "../index";
import {
  listKnownRepoRoots,
  pruneWorktreeRepos,
  upsertRepoByRoot,
} from "../projects";
import {
  cloudWorkspaceDesktopCapabilityEnabled,
  seedCloudWorkspaceDesktopCapabilityEnvironment,
} from "../../cloud-workspace-capability";

afterEach(() => vi.unstubAllEnvs());

describe("Local storage compatibility and isolation", () => {
  it("isolates detach, legacy import and legacy worktrees for each Local instance", () => {
    vi.stubEnv("ZEROS_DEV", "1");
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
    const roots = ["a123456789abcdef", "b123456789abcdef"].map((instance) => {
      vi.stubEnv("ZEROS_INSTANCE", instance);
      const root = zerosStateRoot();
      expect(gitStateRoot()).toBe(root);
      expect(detachLockPath()).toBe(path.join(root, "detach.lock"));
      expect(stateDbPath()).toBe(path.join(root, "state.db"));
      expect(legacyWorktreesRoot()).toBe(path.join(root, "worktrees"));
      return root;
    });
    expect(roots[0]).not.toBe(roots[1]);
  });

  it.each(["stable", "beta", "alpha", "dev"])(
    "preserves %s state paths with or without an instance",
    (channel) => {
      vi.stubEnv("ZEROS_DEV", "1");
      vi.stubEnv("ZEROS_CHANNEL", channel);
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", undefined);
      const root = path.join(
        homedir(),
        channel === "stable" ? ".zeros" : `.zeros-${channel}`,
      );
      for (const instance of [undefined, "a123456789abcdef"]) {
        vi.stubEnv("ZEROS_INSTANCE", instance);
        expect(gitStateRoot()).toBe(root);
        expect(zerosStateRoot()).toBe(root);
        expect(detachLockPath()).toBe(path.join(root, "detach.lock"));
        expect(stateDbPath()).toBe(path.join(root, "state.db"));
        expect(legacyWorktreesRoot()).toBe(path.join(root, "worktrees"));
      }
    },
  );

  it("prunes only this Local instance's legacy worktree projects", () => {
    vi.stubEnv("ZEROS_DEV", "1");
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
    vi.stubEnv("ZEROS_INSTANCE", "a123456789abcdef");
    const phantom = path.join(
      zerosStateRoot(),
      "worktrees",
      "repo",
      "ws_local",
    );
    vi.stubEnv("ZEROS_INSTANCE", "b123456789abcdef");
    const other = path.join(zerosStateRoot(), "worktrees", "repo", "ws_other");
    vi.stubEnv("ZEROS_INSTANCE", "a123456789abcdef");
    try {
      for (const repoRoot of [phantom, other, "/tmp/real-local-repo"]) {
        upsertRepoByRoot({ repoRoot, repoSlug: "repo" });
      }
      expect(pruneWorktreeRepos()).toBe(1);
      expect(listKnownRepoRoots().sort()).toEqual(
        [other, "/tmp/real-local-repo"].sort(),
      );
    } finally {
      closeZerosDb();
    }
  });

  it("keeps DB, settings, workspace and instance identities separate from every app channel", () => {
    vi.stubEnv("ZEROS_DATA_DIR", undefined);
    vi.stubEnv("ZEROS_USER_SETTINGS_DIR", undefined);
    vi.stubEnv("ZEROS_WORKSPACES_DIR", undefined);
    vi.stubEnv("ZEROS_DEV", "1");
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
    vi.stubEnv("ZEROS_INSTANCE", "a123456789abcdef");
    const first = {
      id: appIdentity(),
      data: zerosDataDir(),
      db: zerosDbPath(),
      settings: userSettingsDir(),
      state: zerosStateRoot(),
      workspaces: zerosWorkspacesRoot(),
    };
    expect(first.id).toBe("com.zeros.local.a123456789abcdef");
    expect(first.db).toBe(path.join(first.data, "zeros.db"));
    expect(first.settings).toBe(first.state);
    vi.stubEnv("ZEROS_INSTANCE", "b123456789abcdef");
    expect(zerosDataDir()).not.toBe(first.data);
    expect(userSettingsDir()).not.toBe(first.settings);
    expect(zerosWorkspacesRoot()).not.toBe(first.workspaces);
    vi.stubEnv("ZEROS_INSTANCE", "a123456789abcdef");
    expect(zerosDbPath()).toBe(first.db);
    for (const channel of ["dev", "alpha", "beta", "stable"]) {
      vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", undefined);
      vi.stubEnv("ZEROS_CHANNEL", channel);
      expect(appIdentity()).not.toBe(first.id);
      expect(zerosDataDir()).not.toBe(first.data);
      expect(userSettingsDir()).not.toBe(first.settings);
      expect(zerosWorkspacesRoot()).not.toBe(first.workspaces);
    }
  });

  it("turns off cloud pipelines even when an older bundle baked the capability on", () => {
    vi.stubEnv("ZEROS_CLOUD_WORKSPACES_ENABLED", undefined);
    vi.stubEnv("ZEROS_DEV", "1");
    vi.stubEnv("ZEROS_CHANNEL", "dev");
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", "1");
    expect(
      cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true }),
    ).toBe(false);
    expect(
      seedCloudWorkspaceDesktopCapabilityEnvironment({ bakedCapability: true }),
    ).toBe(false);
    expect(process.env.ZEROS_CLOUD_WORKSPACES_ENABLED).toBe("false");
    vi.stubEnv("ZEROS_LOCAL_DEVELOPMENT", undefined);
    expect(
      cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true }),
    ).toBe(true);
  });
});

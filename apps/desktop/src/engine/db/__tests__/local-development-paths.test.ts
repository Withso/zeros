import path from "node:path";
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
  cloudWorkspaceDesktopCapabilityEnabled,
  seedCloudWorkspaceDesktopCapabilityEnvironment,
} from "../../cloud-workspace-capability";

afterEach(() => vi.unstubAllEnvs());

describe("Local storage compatibility and isolation", () => {
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

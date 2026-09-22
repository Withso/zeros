import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectFolderResult } from "../../platform/git";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  inspect: vi.fn(),
  register: vi.fn(),
  bridgeUpsert: vi.fn(),
  notify: vi.fn(),
  bridge: {},
}));
vi.mock("../../platform/git", () => ({
  gitInitInPlace: mocks.init,
  workspaceInspectFolder: mocks.inspect,
}));
vi.mock("../../state/projects-store", () => ({
  upsertProject: mocks.register,
  normalizeProjectRoot: (root: string) => root.replace(/\/$/, ""),
}));
vi.mock("../../state/use-projects", () => ({
  notifyProjectsChanged: mocks.notify,
}));
vi.mock("../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => mocks.bridge,
}));
vi.mock("../../platform/bridge/workspace-bridge", () => ({
  bridgeProjectUpsert: mocks.bridgeUpsert,
}));

import { prepareProjectFolder } from "../project-folder-setup";

const plain: InspectFolderResult = {
  isRepo: false,
  hasCommits: false,
  isWorktree: false,
  originUrl: null,
  branch: null,
  mainRoot: null,
  sourceTool: "unknown",
};
const ready = { ...plain, isRepo: true, hasCommits: true, branch: "main" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.register.mockImplementation((project) => ({
    ...project,
    repoSlug: "folder",
    name: "Folder",
    originUrl: project.originUrl ?? null,
  }));
  mocks.inspect.mockResolvedValue(ready);
});

describe("automatic folder Git setup", () => {
  it("waits for registration, initializes the folder and confirms a worktree base", async () => {
    let finish!: () => void;
    mocks.bridgeUpsert.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = prepareProjectFolder("/folder", plain);
    expect(mocks.init).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.bridgeUpsert).toHaveBeenCalledTimes(1));
    finish();
    expect(await pending).toEqual(ready);
    expect(mocks.init).toHaveBeenCalledExactlyOnceWith("/folder");
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith("/folder");
    expect(mocks.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ isGitRepository: true }),
    );
  });

  it("creates the initial commit for Git without commits", async () => {
    expect(
      await prepareProjectFolder("/folder", { ...plain, isRepo: true }),
    ).toEqual(ready);
    expect(mocks.init).toHaveBeenCalledTimes(1);
  });

  it("leaves existing Git history and uncommitted files untouched", async () => {
    expect(await prepareProjectFolder("/folder", ready)).toEqual(ready);
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.bridgeUpsert).toHaveBeenCalledTimes(1);
  });

  it("inspects unknown folders and never turns an inspection error into initialization", async () => {
    mocks.inspect.mockRejectedValue(new Error("Permission denied"));
    await expect(prepareProjectFolder("/folder")).rejects.toThrow(
      "Permission denied",
    );
    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("coalesces setup for one exact root and keeps different roots independent", async () => {
    const results = await Promise.all([
      prepareProjectFolder("/folder", plain),
      prepareProjectFolder("/folder/", plain),
      prepareProjectFolder("/other", plain),
    ]);
    expect(results).toEqual([ready, ready, ready]);
    expect(mocks.init.mock.calls).toEqual([["/folder"], ["/other"]]);
  });

  it("does not initialize when registration fails and allows a retry", async () => {
    mocks.bridgeUpsert.mockRejectedValueOnce(new Error("Disconnected"));
    await expect(prepareProjectFolder("/folder", plain)).rejects.toThrow(
      "Disconnected",
    );
    expect(mocks.init).not.toHaveBeenCalled();
    expect(await prepareProjectFolder("/folder", plain)).toEqual(ready);
  });

  it("preserves initialization errors and refuses an incomplete result", async () => {
    mocks.init.mockRejectedValueOnce(new Error("Git unavailable"));
    await expect(prepareProjectFolder("/folder", plain)).rejects.toThrow(
      "Git unavailable",
    );
    expect(mocks.inspect).not.toHaveBeenCalled();
    mocks.inspect.mockResolvedValue(plain);
    await expect(prepareProjectFolder("/folder", plain)).rejects.toThrow(
      "Git setup is incomplete",
    );
  });
});

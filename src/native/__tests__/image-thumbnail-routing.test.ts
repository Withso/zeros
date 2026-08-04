import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: { request: vi.fn() },
  bridgeFileRead: vi.fn(),
  bridgeFileWrite: vi.fn(),
  isKnownProjectRoot: vi.fn(() => false),
  isNativeRuntime: vi.fn(() => true),
  nativeInvoke: vi.fn(),
  resolveWorkspaceId: vi.fn(async () => null as string | null),
}));

vi.mock("../runtime", () => ({
  isNativeRuntime: mocks.isNativeRuntime,
  nativeInvoke: mocks.nativeInvoke,
}));
vi.mock("../../zeros/bridge/active-bridge", () => ({
  getActiveBridge: () => mocks.bridge,
}));
vi.mock("../../zeros/bridge/workspace-bridge", () => ({
  bridgeFileRead: mocks.bridgeFileRead,
  bridgeFileWrite: mocks.bridgeFileWrite,
}));
vi.mock("../../zeros/bridge/workspace-id-resolver", () => ({
  resolveBridgeWorkspaceIdForCwd: mocks.resolveWorkspaceId,
}));
vi.mock("../../zeros/store/projects-store", () => ({
  isKnownProjectRoot: mocks.isKnownProjectRoot,
}));

import { readWorkspaceImageThumbnail } from "../files";

describe("readWorkspaceImageThumbnail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isKnownProjectRoot.mockReturnValue(false);
    mocks.isNativeRuntime.mockReturnValue(true);
    mocks.resolveWorkspaceId.mockResolvedValue(null);
  });

  it("keeps Local main reads on the trusted engine route", async () => {
    mocks.isKnownProjectRoot.mockReturnValue(true);
    mocks.bridgeFileRead.mockResolvedValue({
      kind: "image",
      path: "shot.png",
      bytes: 1_024,
      dataUrl: "data:image/png;base64,TRUNK",
      fullResolution: true,
    });

    await expect(
      readWorkspaceImageThumbnail("/repo/main", "shot.png"),
    ).resolves.toMatchObject({
      kind: "image",
      path: "shot.png",
      bytes: 1_024,
      dataUrl: "data:image/png;base64,TRUNK",
    });
    expect(mocks.bridgeFileRead).toHaveBeenCalledWith(
      mocks.bridge,
      "/repo/main",
      "shot.png",
    );
    expect(mocks.nativeInvoke).not.toHaveBeenCalled();
  });

  it("uses the bounded native command for a managed worktree", async () => {
    mocks.nativeInvoke.mockResolvedValue({
      kind: "image",
      path: "shot.png",
      bytes: 8_000_000,
      width: 256,
      height: 144,
      dataUrl: "data:image/png;base64,THUMB",
    });

    await readWorkspaceImageThumbnail(
      "/zeros/workspaces/repo/a",
      "shot.png",
      1_536,
    );

    expect(mocks.nativeInvoke).toHaveBeenCalledWith("read_image_thumbnail", {
      cwd: "/zeros/workspaces/repo/a",
      path: "shot.png",
      maxDimension: 1_536,
    });
    expect(mocks.bridgeFileRead).not.toHaveBeenCalled();
  });
});

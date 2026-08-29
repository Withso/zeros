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
vi.mock("../bridge/active-bridge", () => ({
  getActiveBridge: () => mocks.bridge,
}));
vi.mock("../bridge/workspace-bridge", () => ({
  bridgeFileRead: mocks.bridgeFileRead,
  bridgeFileWrite: mocks.bridgeFileWrite,
}));
vi.mock("../bridge/workspace-id-resolver", () => ({
  resolveBridgeWorkspaceIdForCwd: mocks.resolveWorkspaceId,
}));
vi.mock("../../state/projects-store", () => ({
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

  it("falls back to the workspace engine when the local thumbnail command cannot reach the file", async () => {
    mocks.nativeInvoke.mockRejectedValue(new Error("unknown native command"));
    mocks.resolveWorkspaceId.mockResolvedValue("ws_cloud-preview");
    mocks.bridgeFileRead.mockResolvedValue({
      kind: "image",
      path: ".context-graph/local/attachments/att-1/shot.png",
      bytes: 42_000,
      dataUrl: "data:image/png;base64,REMOTE",
    });

    await expect(
      readWorkspaceImageThumbnail(
        "/workspace/cloud",
        ".context-graph/local/attachments/att-1/shot.png",
        64,
      ),
    ).resolves.toMatchObject({
      kind: "image",
      dataUrl: "data:image/png;base64,REMOTE",
      fullResolution: true,
    });
    expect(mocks.bridgeFileRead).toHaveBeenCalledWith(
      mocks.bridge,
      "ws_cloud-preview",
      ".context-graph/local/attachments/att-1/shot.png",
    );
  });

  it("retains the engine's deterministic size refusal after a native decode error", async () => {
    mocks.nativeInvoke.mockResolvedValue({
      kind: "error",
      path: "large.png",
      bytes: 8_000_000,
      error: "native format could not be decoded",
    });
    mocks.resolveWorkspaceId.mockResolvedValue("ws_cloud-preview");
    mocks.bridgeFileRead.mockResolvedValue({
      kind: "too-large",
      path: "large.png",
      bytes: 8_000_000,
      error: "file is too large to preview",
    });

    await expect(
      readWorkspaceImageThumbnail(
        "/workspace/cloud",
        ".context-graph/local/attachments/att-1/large.png",
        64,
      ),
    ).resolves.toMatchObject({
      kind: "too-large",
      error: "file is too large to preview",
    });
  });
});

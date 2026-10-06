import { describe, expect, it, vi } from "vitest";
import {
  bridgeCloudDesignBrowseDirectories,
  bridgeCloudDesignCreateDirectory,
  bridgeCloudDesignSelectDirectory,
  rememberDesignDirectoryIdentity,
} from "../design-bridge";
import type { RuntimeClient } from "../ws-client";

describe("cloud Design lifecycle bridge", () => {
  it("sends the explicit selected identity, never the cached canvas identity or a settings patch", async () => {
    const request = vi.fn(async () => ({
      type: "WORKSPACE_RESPONSE",
      result: { directory: "Brand", directories: [], truncated: false },
    }));
    const bridge = { request } as unknown as RuntimeClient;
    const workspaceId = "cloud:org:workspace";
    rememberDesignDirectoryIdentity(workspaceId, "design_old");
    await bridgeCloudDesignSelectDirectory(
      bridge,
      workspaceId,
      "design_new",
      "design_old",
    );
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "design.selectDirectory",
        params: {
          workspaceId,
          directoryId: "design_new",
          expectedDirectoryId: "design_old",
        },
      }),
      expect.anything(),
    );
    await bridgeCloudDesignCreateDirectory(bridge, workspaceId, "Brand");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "design.createDirectory",
        params: { workspaceId, directory: "Brand" },
      }),
      expect.anything(),
    );
    await bridgeCloudDesignBrowseDirectories(bridge, workspaceId, "Brand");
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        op: "design.browseDirectories",
        params: { workspaceId, directory: "Brand" },
      }),
      expect.anything(),
    );
  });
});

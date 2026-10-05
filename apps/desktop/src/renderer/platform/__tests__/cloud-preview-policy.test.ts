import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  nativeInvoke: vi.fn(async () => ({ accessId: "synthetic-access" })),
}));
vi.mock("../runtime", () => native);
const folder =
  "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  vi.resetModules();
  native.nativeInvoke.mockClear();
  vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("cloud preview opt-in", () => {
  it("shares read-only intent metadata and consumes it without pre-admitting a frame", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "preview.example.test");
    const context = { authorityId: "11111111-1111-4111-8111-111111111111", deviceId: "33333333-3333-4333-8333-333333333333", keyVersion: 1 };
    const invoke = native.nativeInvoke as ReturnType<typeof vi.fn>;
    invoke.mockReset().mockResolvedValue(context);
    const policy = await import("../cloud-workspace-access");
    await Promise.all([policy.warmCloudPreviewContext(), policy.warmCloudPreviewContext()]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("cloud_workspace_access_context", {});
    invoke.mockResolvedValueOnce({ accessId: "access-warmed", expiresAt: new Date(Date.now() + 60_000).toISOString() }).mockResolvedValueOnce(context);
    await policy.openCloudWorkspacePreview({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", port: 5173, frameName: "zeros-browser-warmed" });
    expect(invoke.mock.calls.map(call => call[0])).toEqual(["cloud_workspace_access_context", "browser:open-cloud-preview", "cloud_workspace_access_context"]);
  });

  it("retires a late preview response after the device authority changes", async () => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", "preview.example.test");
    const first = { authorityId: "11111111-1111-4111-8111-111111111111", deviceId: "33333333-3333-4333-8333-333333333333", keyVersion: 1 };
    const invoke = native.nativeInvoke as ReturnType<typeof vi.fn>;
    invoke.mockReset();
    invoke.mockResolvedValueOnce(first).mockResolvedValueOnce({ accessId: "access-issued", logicalUrl: "http://localhost:5173/", origin: "https://preview.example.test", admissionUrl: "https://preview.example.test/", expiresAt: new Date(Date.now() + 60_000).toISOString() }).mockResolvedValueOnce({ ...first, keyVersion: 2 }).mockResolvedValueOnce(true);
    const policy = await import("../cloud-workspace-access");
    await expect(policy.openCloudWorkspacePreview({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", port: 5173, frameName: "zeros-browser-test" })).rejects.toThrow("device changed");
    expect(invoke).toHaveBeenLastCalledWith("cloud_workspace_access_revoke", { accessId: "access-issued" });
    invoke.mockReset().mockResolvedValue({ accessId: "synthetic-access" });
  });
  it("hides only cloud preview surfaces when suffixes are unset", async () => {
    const policy = await import("../cloud-workspace-access");
    expect(policy.cloudWorkspacePreviewsConfigured()).toBe(false);
    expect(policy.workspacePreviewAvailable(folder)).toBe(false);
    expect(policy.workspacePreviewAvailable("/local/repo")).toBe(true);
  });
  it.each([
    "https://preview.example.test",
    "*.preview.example.test",
    "Preview.example.test",
    "preview.example.test:443",
    "localhost",
  ])("fails closed on invalid suffix %s", async (suffix) => {
    vi.stubEnv("VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES", suffix);
    expect(
      (
        await import("../cloud-workspace-access")
      ).cloudWorkspacePreviewsConfigured(),
    ).toBe(false);
  });
  it("enables previews with exact, qualified DNS suffixes", async () => {
    vi.stubEnv(
      "VITE_CLOUD_WORKSPACE_PREVIEW_HOST_SUFFIXES",
      "preview.example.test,preview-beta.example.test",
    );
    const policy = await import("../cloud-workspace-access");
    expect(policy.cloudWorkspacePreviewsConfigured()).toBe(true);
    expect(policy.workspacePreviewAvailable(folder)).toBe(true);
  });
  it("rejects direct preview attempts before requesting a grant, but leaves localhost tunnels available", async () => {
    const policy = await import("../cloud-workspace-access");
    const target = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      port: 3000,
    };
    await expect(
      policy.openCloudWorkspacePreview({
        ...target,
        frameName: "zeros-browser-test",
      }),
    ).rejects.toThrow(/preview.*not configured/i);
    expect(native.nativeInvoke).not.toHaveBeenCalled();
    const tunnel = {
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      remotePort: 3000,
      localPort: 3001,
    };
    await policy.startCloudWorkspaceTunnel(tunnel);
    expect(native.nativeInvoke).toHaveBeenCalledWith(
      "cloud_workspace_tunnel_start",
      tunnel,
    );
  });
  it("does not read, retain or publish broken run previews for a cloud workspace", async () => {
    const { RunPreviewCache } =
      await import("../../shell/terminal/run-preview-cache");
    const cache = new RunPreviewCache();
    const target = {
      folderKey: folder,
      workspaceId: "workspace",
      sessionId: "run",
      startedAt: 1,
    };
    const read = vi.fn(async () => ({ log: "http://localhost:3000/\n" }));
    cache.append(target, "http://localhost:3000/\n");
    await cache.warm(target, read);
    expect(cache.peek(target)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(cache.getVersion()).toBe(0);
  });
});

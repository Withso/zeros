// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { CLOUD_FOCUS_PING_MS, cloudFocusPingDue } from "../use-cloud-focus-activity";

describe("cloud focus activity", () => {
  const base = { visible: true, focused: true, status: "ready", lastPingAt: 0, now: CLOUD_FOCUS_PING_MS };
  it("pings for a focused, visible, running workspace at most once a minute", () => {
    expect(cloudFocusPingDue(base)).toBe(true);
    expect(cloudFocusPingDue({ ...base, status: "busy" })).toBe(true);
    expect(cloudFocusPingDue({ ...base, now: CLOUD_FOCUS_PING_MS - 1 })).toBe(false);
  });
  it("never pings a hidden or blurred window, or a VM that is not running", () => {
    expect(cloudFocusPingDue({ ...base, visible: false })).toBe(false);
    expect(cloudFocusPingDue({ ...base, focused: false })).toBe(false);
    for (const status of ["stopped", "starting", "archived", undefined]) expect(cloudFocusPingDue({ ...base, status })).toBe(false);
  });
});

describe("cloud focus activity under Team sharing", () => {
  it("never pings for a teammate's workspace this account only reads (member or admin), and still pings for its Creator", async () => {
    vi.resetModules();
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
    const ping = vi.fn(async () => {});
    let sharing: Record<string, unknown> | undefined;
    vi.doMock("../../platform/cloud-v2", () => ({ pingCloudV2WorkspaceActivity: ping }));
    vi.doMock("../cloud-workspace-catalog", () => ({ cloudWorkspaceDocument: () => ({ id: target.workspaceId, status: "ready", ...(sharing ? { sharing } : {}) }) }));
    vi.doMock("../use-active-workspace", () => ({ useActiveWorkspace: () => ({ folder }) }));
    vi.doMock("../workspace-store", () => ({ useActivePage: () => "workspace" }));
    const { useCloudFocusActivity } = await import("../use-cloud-focus-activity");
    const { createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const mount = async () => {
      const root = createRoot(document.createElement("div"));
      await act(async () => { root.render(createElement(() => { useCloudFocusActivity(); return null; })); });
      root.unmount();
    };
    for (const viewerRole of ["member", "admin"]) {
      sharing = { viewerRole, readOnly: true, canManage: viewerRole === "admin" };
      await mount();
    }
    expect(ping).not.toHaveBeenCalled();
    sharing = { viewerRole: "creator", readOnly: false, canManage: true };
    await mount();
    expect(ping).toHaveBeenCalledOnce();
  });
});

describe("R1 relay-presence-v1", () => {
  it("never pings while the workspace's live relay connection counts as presence; pings again once it does not", () => {
    const base = { visible: true, focused: true, status: "ready", lastPingAt: Number.NEGATIVE_INFINITY, now: 1 };
    expect(cloudFocusPingDue({ ...base, relayPresence: true })).toBe(false);
    expect(cloudFocusPingDue({ ...base, relayPresence: false })).toBe(true);
    expect(cloudFocusPingDue(base)).toBe(true);
  });
});

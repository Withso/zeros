import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { BLANK, useSessionsStore } from "../sessions-store";
import { trackCloudChatMutation } from "../cloud-chat-mutation";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";

const boundary = vi.hoisted(() => ({ account: 1, owner: 1 as number | undefined, stop: 0 }));
vi.mock("../../../state/cloud-workspace-catalog", () => ({ cloudCatalogGeneration: () => boundary.account,
  cloudWorkspaceOwnerGeneration: () => boundary.owner, cloudWorkspaceStopVersion: () => boundary.stop }));
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const id = cloudScopedId(target, "chat"), folder = cloudWorkspaceKey(target);
beforeEach(() => {
  setActiveBridge(null);
  boundary.account = 1; boundary.owner = 1; boundary.stop = 0;
  useSessionsStore.getState().clearAll();
  useSessionsStore.getState().setSession(id, { ...BLANK, cwd: folder, agentId: "codex" });
});
afterEach(() => { setActiveBridge(null); vi.restoreAllMocks(); });
it.each(["account", "owner", "workspace Stop", "chat Stop", "cancel", "agent"])("retires an awaiting cloud mutation after %s, including A-B-A", boundaryName => {
  const action = trackCloudChatMutation(id, folder);
  try {
    expect(action.isCurrent()).toBe(true);
    if (boundaryName === "account") boundary.account += 2;
    else if (boundaryName === "owner") boundary.owner! += 2;
    else if (boundaryName === "workspace Stop") boundary.stop++;
    else if (boundaryName === "chat Stop") {
      useSessionsStore.getState().patchSession(id, { cloudStop: { operationId: "stop", turnId: null, state: "pending" } });
      useSessionsStore.getState().patchSession(id, { cloudStop: undefined });
    } else if (boundaryName === "cancel") {
      useSessionsStore.getState().setCancelling(id, true); useSessionsStore.getState().setCancelling(id, false);
    } else {
      useSessionsStore.getState().patchSession(id, { agentId: "claude" });
      useSessionsStore.getState().patchSession(id, { agentId: "codex" });
    }
    expect(action.isCurrent()).toBe(false);
  } finally { action.dispose(); }
});
it("keeps native-route replacement and other chats independent", () => {
  const action = trackCloudChatMutation(id, folder);
  try {
    useSessionsStore.getState().patchSession(id, { sessionId: null, executionId: null });
    useSessionsStore.getState().setCancelling("unrelated", true);
    expect(action.isCurrent()).toBe(true);
  } finally { action.dispose(); }
});
it.each(["/personal/repo", "/organization/repo"])("leaves Local mutation behavior independent of cloud ownership in %s", cwd => {
  const action = trackCloudChatMutation("local-chat", cwd);
  boundary.account++; boundary.owner = undefined; boundary.stop++;
  expect(action.isCurrent()).toBe(true); action.dispose();
});

it.each(["bridge", "peer"])("retires an awaiting cloud mutation across a %s replacement, including A-B-A", boundaryName => {
  const bridge = new WorkspaceRuntimeClient({ open: async () => { throw new Error("No passive open"); }, workspaces: () => [] });
  let connected = true, changed = () => {};
  vi.spyOn(bridge, "statusForWorkspace").mockImplementation(() => connected ? "connected" : "disconnected");
  vi.spyOn(bridge, "onWorkspaceStatusChange").mockImplementation((_folder, listener) => { changed = listener; return () => {}; });
  setActiveBridge(bridge);
  const action = trackCloudChatMutation(id, folder);
  try {
    expect(action.isCurrent()).toBe(true);
    if (boundaryName === "bridge") { setActiveBridge(null); setActiveBridge(bridge); }
    else { connected = false; changed(); connected = true; changed(); }
    expect(action.isCurrent()).toBe(false);
  } finally { action.dispose(); bridge.dispose(); }
});

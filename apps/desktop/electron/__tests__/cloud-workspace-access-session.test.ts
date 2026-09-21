import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  account: "account-a",
  session: "session-a",
  listener: (() => {}) as () => void,
  events: vi.fn(),
  revoke: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/zeros-cloud-test" },
  clipboard: { writeText: vi.fn() },
}));
vi.mock("../../src/engine/cloud-workspace-capability", () => ({
  cloudWorkspaceDesktopCapabilityEnabled: () => true,
}));
vi.mock("../runtime-mode", () => ({ IS_DEV: true }));
vi.mock("../ipc/events", () => ({ emitEvent: state.events }));
vi.mock("../preview-frame-authorizations", () => ({
  previewFrameAuthorizations: { clear: vi.fn() },
}));
vi.mock("../cloud-replica-host-runtime", () => ({
  ensureCloudAccessDeviceForMain: vi.fn(),
  signCloudEngineAdmissionForMain: vi.fn(),
}));
vi.mock("../ipc/commands/auth-session", () => ({
  getValidAccessTokenForMain: async () => `token-${state.account}`,
  getSessionUserForMain: () => ({
    provider: "workos",
    accountId: state.account,
    sessionId: state.session,
    sub: "workos-sub",
  }),
  onMainAuthSessionChanged: (listener: () => void) => {
    state.listener = listener;
  },
}));
vi.mock("../cloud-workspace-ssh-runtime", () => ({
  CloudWorkspaceSshRuntime: class {
    constructor() {
      throw new Error("SSH is deliberately unconfigured");
    }
    async dispose() {}
  },
}));
vi.mock("../cloud-workspace-access-client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  CloudWorkspaceAccessClient: class {
    async issueEngineAdmission() {
      return {
        version: 2,
        audience: "zeros-cloud-workspace-engine-client-admission-v2",
        organizationId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        generation: 1,
        authorityEpoch: 1,
        engineInstanceId: "33333333-3333-4333-8333-333333333333",
        remotePort: 47891,
        grantToken: `zwa_${"a".repeat(43)}`,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
        bridgeUrl: "wss://api.zeros.test/v1/cloud-workspaces/bridge",
      };
    }
    revokeEngineAdmission = state.revoke;
  },
}));
import {
  disposeCloudWorkspaceAccessBroker,
  getCloudWorkspaceAccessBroker,
  reconcileCloudWorkspaceAccessSession,
  handleSharedCloudAccessSessionChange,
} from "../cloud-workspace-access-runtime";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
afterEach(async () => {
  await disposeCloudWorkspaceAccessBroker();
  state.account = "account-a";
  state.session = "session-a";
  vi.clearAllMocks();
});
describe("main cloud access source-session lifecycle", () => {
  it.each(["local", "shared"])(
    "retires %s store replacement synchronously even when remote revocation fails",
    async (source) => {
      const broker = getCloudWorkspaceAccessBroker(),
        runtime = await broker.openRuntime(target);
      state.revoke.mockRejectedValueOnce(new Error("offline"));
      state.account = "account-b";
      state.session = "session-b";
      if (source === "local") state.listener();
      else
        handleSharedCloudAccessSessionChange(() => {
          expect(state.events).toHaveBeenCalledWith(
            "cloud-workspace-access-retired",
            { runtimeIds: [runtime.runtimeId] },
          );
        });
      expect(state.events).toHaveBeenCalledWith(
        "cloud-workspace-access-retired",
        { runtimeIds: [runtime.runtimeId] },
      );
      expect(getCloudWorkspaceAccessBroker()).not.toBe(broker);
      await expect(broker.refreshRuntime(runtime)).rejects.toMatchObject({
        code: "cloud_workspace_access_superseded",
      });
    },
  );
  it("preserves grants on unchanged session/token rotation but retires a new sign-in for the same account", async () => {
    const broker = getCloudWorkspaceAccessBroker(),
      runtime = await broker.openRuntime(target);
    state.listener();
    reconcileCloudWorkspaceAccessSession();
    expect(getCloudWorkspaceAccessBroker()).toBe(broker);
    expect(state.events).not.toHaveBeenCalled();
    state.session = "session-new";
    state.listener();
    expect(state.events).toHaveBeenCalledWith(
      "cloud-workspace-access-retired",
      { runtimeIds: [runtime.runtimeId] },
    );
  });
});

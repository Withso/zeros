import { beforeEach, describe, expect, it, vi } from "vitest";

const broker = vi.hoisted(() => ({
  serviceContext: vi.fn(),
  listServices: vi.fn(),
  copySshCommand: vi.fn(),
  openSshTerminal: vi.fn(),
  startTunnel: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../cloud-workspace-access-runtime", () => ({
  getCloudWorkspaceAccessBroker: () => broker,
}));
import {
  cloudWorkspaceAccessContext,
  cloudWorkspaceAccessList,
  cloudWorkspaceAccessRevoke,
  cloudWorkspaceSshCopy,
  cloudWorkspaceSshTerminal,
  cloudWorkspaceTunnelStart,
} from "../ipc/commands/cloud-workspace-access";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const context = {
  authorityId: "33333333-3333-4333-8333-333333333333",
  deviceId: "44444444-4444-4444-8444-444444444444",
  keyVersion: 1,
};
const event = {} as Parameters<typeof cloudWorkspaceAccessContext>[1];
beforeEach(() => {
  vi.resetAllMocks();
  broker.serviceContext.mockReturnValue(context);
  broker.listServices.mockReturnValue([]);
});

describe("native cloud access IPC", () => {
  it("reads only safe local context and exact-device metadata", () => {
    expect(cloudWorkspaceAccessContext({}, event)).toEqual(context);
    expect(cloudWorkspaceAccessList({ ...target, ...context }, event)).toEqual(
      [],
    );
    expect(broker.listServices).toHaveBeenCalledWith({ ...target, ...context });
    expect(broker.copySshCommand).not.toHaveBeenCalled();
    expect(broker.startTunnel).not.toHaveBeenCalled();
  });

  it.each([
    cloudWorkspaceSshCopy,
    cloudWorkspaceSshTerminal,
    cloudWorkspaceTunnelStart,
  ])("rejects a stale staff action before issuing any authority", (action) => {
    broker.listServices.mockImplementation(() => {
      throw new Error("Cloud service authority changed.");
    });
    expect(() =>
      action(
        { ...target, ...context, localPort: 5173, remotePort: 4173 },
        event,
      ),
    ).toThrow(/authority changed/);
    expect(broker.copySshCommand).not.toHaveBeenCalled();
    expect(broker.openSshTerminal).not.toHaveBeenCalled();
    expect(broker.startTunnel).not.toHaveBeenCalled();
  });

  it.each([
    { ...context, deviceId: null },
    { ...context, keyVersion: null },
    { ...context, keyVersion: 0 },
    { ...context, authorityId: "" },
  ])("refuses malformed device context", (invalid) => {
    expect(() =>
      cloudWorkspaceAccessList({ ...target, ...invalid }, event),
    ).toThrow(/invalid/);
    expect(broker.listServices).not.toHaveBeenCalled();
  });

  it("preserves legacy IPC targets and sends native secrets to no renderer action", () => {
    cloudWorkspaceSshCopy(target, event);
    expect(broker.copySshCommand).toHaveBeenCalledWith(target);
    expect(broker.listServices).not.toHaveBeenCalled();
    cloudWorkspaceTunnelStart(
      { ...target, ...context, localPort: 5173, remotePort: 4173 },
      event,
    );
    expect(broker.startTunnel).toHaveBeenCalledWith({
      ...target,
      localPort: 5173,
      remotePort: 4173,
    });
    cloudWorkspaceAccessRevoke({ accessId: context.authorityId }, event);
    expect(broker.revoke).toHaveBeenCalledWith(context.authorityId);
  });
});

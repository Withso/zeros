import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ epoch: 1, invoke: vi.fn() }));
vi.mock("../runtime", () => ({ nativeInvoke: state.invoke }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => state.epoch,
}));
import {
  cloudServiceAccessKey,
  cloudServiceContextKey,
  readCloudServiceAccess,
  readCloudServiceContext,
  warmCloudServiceAccess,
} from "../cloud-workspace-access";
import {
  cloudServiceAccessCache,
  cloudServiceContextCache,
} from "../../state/read-caches";

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const context = {
  authorityId: "33333333-3333-4333-8333-333333333333",
  deviceId: "44444444-4444-4444-8444-444444444444",
  keyVersion: 1,
};
const row = {
  accessId: "55555555-5555-4555-8555-555555555555",
  kind: "tunnel",
  generation: 1,
  expiresAt: "2027-01-01T00:00:00.000Z",
  localPort: 5173,
  remotePort: 4173,
  closing: false,
};
beforeEach(() => {
  state.epoch = 1;
  state.invoke.mockReset();
  cloudServiceAccessCache.clear();
  cloudServiceContextCache.clear();
  state.invoke.mockImplementation(async (command: string) =>
    command === "cloud_workspace_access_context" ? context : [row],
  );
});

describe("native cloud access metadata", () => {
  it("warms read-only metadata once and keys it by account, device key and workspace", async () => {
    await Promise.all([
      warmCloudServiceAccess(target),
      warmCloudServiceAccess(target),
    ]);
    expect(state.invoke.mock.calls.map((call) => call[0])).toEqual([
      "cloud_workspace_access_context",
      "cloud_workspace_access_list",
    ]);
    const key = cloudServiceAccessKey(target, context);
    expect(cloudServiceAccessCache.peekSnapshot(key).data).toEqual([row]);
    expect(
      cloudServiceAccessKey(
        { ...target, workspaceId: target.organizationId },
        context,
      ),
    ).not.toBe(key);
    expect(
      cloudServiceAccessKey(target, { ...context, keyVersion: 2 }),
    ).not.toBe(key);
    expect(
      cloudServiceAccessKey(target, {
        ...context,
        deviceId: target.organizationId,
      }),
    ).not.toBe(key);
    state.epoch++;
    expect(cloudServiceAccessKey(target, context)).not.toBe(key);
  });
  it("retains an exact-key snapshot through refresh and keeps identical rows stable", async () => {
    await warmCloudServiceAccess(target);
    const key = cloudServiceAccessKey(target, context);
    const previous = cloudServiceAccessCache.peekSnapshot(key).data;
    let resolve!: (value: unknown) => void;
    state.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = cloudServiceAccessCache.load(
      key,
      () => readCloudServiceAccess(key),
      { force: true },
    );
    expect(cloudServiceAccessCache.peekSnapshot(key).data).toBe(previous);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve([{ ...row }]);
    await pending;
    expect(cloudServiceAccessCache.peekSnapshot(key).data).toBe(previous);
  });
  it("rejects reads completed under a replacement account or device", async () => {
    await warmCloudServiceAccess(target);
    let resolve!: (value: unknown) => void;
    state.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const read = readCloudServiceAccess(cloudServiceAccessKey(target, context));
    const rejected = expect(read).rejects.toThrow(/authority|account/);
    cloudServiceContextCache.setData(cloudServiceContextKey(), {
      ...context,
      keyVersion: 2,
    });
    resolve([row]);
    await rejected;
    state.invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const contextRead = readCloudServiceContext(cloudServiceContextKey());
    const rejectedContext = expect(contextRead).rejects.toThrow(/account/);
    state.epoch++;
    resolve(context);
    await rejectedContext;
  });
  it("never admits capability fields from native metadata to the cache", async () => {
    state.invoke.mockResolvedValueOnce({
      ...context,
      capability: "unexpected",
    });
    await expect(
      readCloudServiceContext(cloudServiceContextKey()),
    ).rejects.toThrow();
  });
});

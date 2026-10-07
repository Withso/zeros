import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../../platform/cloud-workspaces";
import {
  computerBuild,
  computerOperationId,
  computerOrg,
  computerState,
  computerUser,
  deferred,
  otherComputerOrg,
} from "./cloud-computer-v2-fixtures";

const transport = vi.hoisted(() => ({
  epoch: 0,
  user: "44444444-4444-4444-8444-444444444444",
  org: "11111111-1111-4111-8111-111111111111",
  role: "admin",
  feature: true,
  request: vi.fn(),
  warm: vi.fn(),
}));
vi.mock("../../team/team-store", () => ({
  getOrganizationStoreGeneration: () => transport.epoch,
  getTeamStoreState: () => ({
    me: {
      user: { id: transport.user },
      organizations: [computerOrg, otherComputerOrg].map((id) => ({
        id,
        role: transport.role,
        isPersonal: false,
      })),
    },
  }),
  getActiveOrganizationSnapshot: () => ({
    id: transport.org,
    role: transport.role,
    isPersonal: false,
  }),
}));
vi.mock("../../../platform/cloud-workspaces", async (original) => ({
  ...(await original<typeof import("../../../platform/cloud-workspaces")>()),
  cloudAccountRequest: transport.request,
}));
vi.mock("../../../state/cloud-workspace-warmup", () => ({
  warmCloudWorkspaceDestination: transport.warm,
}));

import {
  clearCloudComputersV2,
  cloudComputerV2Cache,
  cloudComputerV2Key,
  configureCloudComputerV2AdminWorkspace,
} from "../cloud-computer-v2-client";
import {
  openCloudComputerV2AdminWorkspace,
  warmCloudComputerV2AdminWorkspace,
} from "../cloud-computer-v2-admin-flow";
import { CloudComputerAdminBadge } from "../cloud-computer-admin-badge";
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  cloudWorkspaceDetails,
  getCloudWorkspaceRows,
} from "../../../state/cloud-workspace-catalog";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import {
  selectActiveFolder,
  useWorkspaceStore,
} from "../../../state/workspace-store";

const key = cloudComputerV2Key(computerUser, computerOrg);
const otherKey = cloudComputerV2Key(computerUser, otherComputerOrg);
function workspace(
  overrides: Partial<CloudWorkspaceDocument> = {},
): CloudWorkspaceDocument {
  return {
    id: computerOperationId,
    organizationId: computerOrg,
    teamId: computerOrg,
    name: "Private workspace",
    createdBy: computerUser,
    ownerUserId: computerUser,
    adminWorkspace: { creatorUserId: computerUser },
    placement: "cloud",
    status: "provisioning",
    capabilities: {
      canWrite: true,
      canManage: true,
      canStart: true,
      startUnavailableReason: null,
    },
    repository: {
      forge: "github.com",
      owner: "example",
      name: "project",
      revision: "refs/heads/main",
    },
    generation: {
      number: 1,
      architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "provisioning",
      lastObservedAt: null,
    },
    version: 1,
    error: null,
    createdAt: "2026-10-04T10:00:00Z",
    updatedAt: "2026-10-04T10:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}
const ready = (version = 1) =>
  computerState({ state: "active", active: computerBuild({ version }) });
const result = (doc = workspace(), reused = false) => ({
  workspace: doc,
  reused,
  replayed: false,
});
beforeAll(() => {
  vi.stubGlobal("window", {
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
  });
});
beforeEach(() => {
  Object.assign(transport, {
    epoch: 0,
    user: computerUser,
    org: computerOrg,
    role: "admin",
    feature: true,
  });
  transport.request.mockReset();
  transport.warm.mockReset().mockResolvedValue(undefined);
  clearCloudComputersV2();
  clearCloudWorkspaceCatalog();
  cloudComputerV2Cache.setData(key, ready());
  cloudComputerV2Cache.setData(otherKey, ready(2));
  useWorkspaceStore.setState({
    chats: [],
    activeChatId: null,
    activePage: "settings",
    lastWorkspaceFolder: null,
  });
  transport.request.mockImplementation(async (_path, schema) =>
    schema.parse(result()),
  );
});

describe("Cloud Computer admin client and destination", () => {
  it("refuses writes with a warm snapshot after demotion, missing build or account replacement", async () => {
    for (const change of [
      () => {
        transport.role = "member";
      },
      () => {
        cloudComputerV2Cache.setData(key, computerState());
      },
      () => {
        transport.user = otherComputerOrg;
      },
    ]) {
      transport.role = "admin";
      transport.feature = true;
      transport.user = computerUser;
      cloudComputerV2Cache.setData(key, ready());
      change();
      await expect(
        configureCloudComputerV2AdminWorkspace(key, 1, computerOperationId),
      ).rejects.toThrow();
    }
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("allows current organization admins with the retired rollout flag off", async () => {
    transport.feature = false;
    await expect(configureCloudComputerV2AdminWorkspace(key, 1, computerOperationId)).resolves.toMatchObject(result());
    expect(transport.request).toHaveBeenCalledOnce();
  });

  it("shares concurrent exact-operation requests and sends only D1's current-version contract", async () => {
    const confirmed = cloudComputerV2Cache.peekSnapshot(key).data;
    const pending = deferred<ReturnType<typeof result>>();
    transport.request.mockReturnValue(pending.promise);
    const first = configureCloudComputerV2AdminWorkspace(
      key,
      1,
      computerOperationId,
    );
    const second = configureCloudComputerV2AdminWorkspace(
      key,
      1,
      computerOperationId,
    );
    expect(transport.request).toHaveBeenCalledTimes(1);
    pending.resolve(result());
    expect(await second).toEqual(await first);
    expect(cloudComputerV2Cache.peekSnapshot(key).data).toBe(confirmed);
    expect(transport.request).toHaveBeenCalledWith(
      `/v1/organizations/${computerOrg}/cloud-computer/v2/admin-workspaces`,
      expect.anything(),
      {
        body: { expectedActiveVersion: 1, operationId: computerOperationId },
        idempotencyKey: computerOperationId,
      },
    );
  });

  it("isolates org requests and publishes returned metadata into the exact workspace key", async () => {
    transport.request.mockImplementation(async (path, schema) =>
      schema.parse(
        result(
          workspace({
            id: path.includes(otherComputerOrg)
              ? otherComputerOrg
              : computerOperationId,
            organizationId: path.includes(otherComputerOrg)
              ? otherComputerOrg
              : computerOrg,
          }),
        ),
      ),
    );
    const a = await configureCloudComputerV2AdminWorkspace(
      key,
      1,
      computerOperationId,
    );
    const b = await configureCloudComputerV2AdminWorkspace(
      otherKey,
      2,
      computerOperationId,
    );
    expect(transport.request).toHaveBeenCalledTimes(2);
    openCloudComputerV2AdminWorkspace(key, a.workspace);
    const aFolder = cloudWorkspaceKey({
      organizationId: computerOrg,
      workspaceId: a.workspace.id,
    });
    const bFolder = cloudWorkspaceKey({
      organizationId: otherComputerOrg,
      workspaceId: b.workspace.id,
    });
    const confirmed = cloudWorkspaceDetails.peekSnapshot(aFolder).data;
    transport.org = otherComputerOrg;
    openCloudComputerV2AdminWorkspace(otherKey, b.workspace);
    expect(cloudWorkspaceDetails.peekSnapshot(aFolder).data).toBe(confirmed);
    expect(
      cloudWorkspaceDetails.peekSnapshot(bFolder).data?.organizationId,
    ).toBe(otherComputerOrg);
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(bFolder);
  });

  it("reopens the server-reused workspace with a fresh conversation and uses the newly active version on the next request", async () => {
    transport.request
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result(workspace(), true));
    for (let i = 0; i < 2; i++) {
      const response = await configureCloudComputerV2AdminWorkspace(
        key,
        1,
        crypto.randomUUID(),
      );
      openCloudComputerV2AdminWorkspace(key, response.workspace);
    }
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(useWorkspaceStore.getState().chats).toHaveLength(2);
    expect(
      new Set(useWorkspaceStore.getState().chats.map((chat) => chat.id)).size,
    ).toBe(2);
    cloudComputerV2Cache.setData(key, ready(2));
    const next = workspace({ id: otherComputerOrg });
    transport.request.mockResolvedValueOnce(result(next));
    openCloudComputerV2AdminWorkspace(
      key,
      (
        await configureCloudComputerV2AdminWorkspace(
          key,
          2,
          crypto.randomUUID(),
        )
      ).workspace,
    );
    expect(getCloudWorkspaceRows()).toHaveLength(2);
    expect(
      transport.request.mock.lastCall?.[2].body.expectedActiveVersion,
    ).toBe(2);
  });

  it("publishes route, workspace and new chat in one transition from settings without waiting for hydration", async () => {
    const snapshots: Array<{
      page: string;
      folder: string | null;
      chat: string | null;
    }> = [];
    const off = useWorkspaceStore.subscribe((state) =>
      snapshots.push({
        page: state.activePage,
        folder: selectActiveFolder(state),
        chat: state.activeChatId,
      }),
    );
    try {
      const response = await configureCloudComputerV2AdminWorkspace(
        key,
        1,
        computerOperationId,
      );
      expect(openCloudComputerV2AdminWorkspace(key, response.workspace)).toBe(
        true,
      );
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toEqual({
        page: "workspace",
        folder: cloudWorkspaceKey({
          organizationId: computerOrg,
          workspaceId: computerOperationId,
        }),
        chat: useWorkspaceStore.getState().chats[0].id,
      });
      expect(transport.warm).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it.each([
    { organizationId: otherComputerOrg },
    { adminWorkspace: undefined },
    { adminWorkspace: { creatorUserId: otherComputerOrg } },
    { createdBy: otherComputerOrg },
    { ownerUserId: otherComputerOrg },
  ])(
    "rejects mismatched server identity %j before publishing",
    async (overrides) => {
      transport.request.mockResolvedValueOnce(result(workspace(overrides)));
      await expect(
        configureCloudComputerV2AdminWorkspace(key, 1, computerOperationId),
      ).rejects.toThrow(/identity/i);
      expect(getCloudWorkspaceRows()).toHaveLength(0);
    },
  );

  it("rejects role loss and account replacement during a request, including the same account signing back in", async () => {
    for (const change of [
      () => {
        transport.role = "member";
      },
      () => {
        transport.epoch++;
      },
    ]) {
      transport.role = "admin";
      transport.feature = true;
      const pending = deferred<ReturnType<typeof result>>();
      transport.request.mockReturnValueOnce(pending.promise);
      const read = configureCloudComputerV2AdminWorkspace(
        key,
        1,
        crypto.randomUUID(),
      );
      change();
      pending.resolve(result());
      await expect(read).rejects.toThrow();
      expect(getCloudWorkspaceRows()).toHaveLength(0);
    }
  });

  it("does not let an org A reply pull the selected org B into A's workspace", async () => {
    const pending = deferred<ReturnType<typeof result>>();
    transport.request.mockReturnValueOnce(pending.promise);
    const read = configureCloudComputerV2AdminWorkspace(
      key,
      1,
      computerOperationId,
    );
    transport.org = otherComputerOrg;
    pending.resolve(result());
    expect(openCloudComputerV2AdminWorkspace(key, (await read).workspace)).toBe(
      false,
    );
    expect(useWorkspaceStore.getState().activePage).toBe("settings");
    expect(useWorkspaceStore.getState().chats).toHaveLength(0);
  });

  it("warms the creator's marked destination on intent without allocating or using another org's workspace", () => {
    acceptCloudWorkspaceDocument(workspace({ name: "Unrelated name" }));
    acceptCloudWorkspaceDocument(
      workspace({
        id: computerOrg,
        adminWorkspace: undefined,
        name: "Configure Cloud Computer",
      }),
    );
    acceptCloudWorkspaceDocument(
      workspace({ id: otherComputerOrg, organizationId: otherComputerOrg }),
    );
    const latestId = "88888888-8888-4888-8888-888888888888";
    acceptCloudWorkspaceDocument(
      workspace({ id: latestId, createdAt: "2026-10-04T11:00:00Z" }),
    );
    warmCloudComputerV2AdminWorkspace(key);
    expect(transport.request).not.toHaveBeenCalled();
    expect(transport.warm).toHaveBeenCalledOnce();
    expect(transport.warm).toHaveBeenCalledWith(
      cloudWorkspaceKey({
        organizationId: computerOrg,
        workspaceId: latestId,
      }),
      true,
    );
    transport.role = "member";
    warmCloudComputerV2AdminWorkspace(key);
    expect(transport.warm).toHaveBeenCalledOnce();
  });
});

describe("server-derived Admin badge", () => {
  it("uses only server-marked cloud metadata independently of the retired rollout flag", () => {
    const folder = cloudWorkspaceKey({
      organizationId: computerOrg,
      workspaceId: computerOperationId,
    });
    const render = () =>
      renderToStaticMarkup(createElement(CloudComputerAdminBadge, { folder }));
    acceptCloudWorkspaceDocument(
      workspace({
        adminWorkspace: undefined,
        name: "Configure Cloud Computer — Admin",
      }),
    );
    expect(render()).toBe("");
    acceptCloudWorkspaceDocument(
      workspace({ name: "Unrelated name", version: 2 }),
    );
    expect(render()).toContain(">Admin<");
    transport.feature = false;
    expect(render()).toContain(">Admin<");
    transport.feature = true;
    expect(
      renderToStaticMarkup(
        createElement(CloudComputerAdminBadge, { folder: "/local/Admin" }),
      ),
    ).toBe("");
  });
});

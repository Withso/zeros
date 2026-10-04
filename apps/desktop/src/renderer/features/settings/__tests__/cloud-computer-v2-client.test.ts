import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerV2State } from "@zeros/protocol/cloud-computer-v2";
import {
  computerBuild,
  computerBuildId,
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
  request: vi.fn(),
  source: vi.fn(),
}));
vi.mock("../../team/team-store", () => ({
  getOrganizationStoreGeneration: () => transport.epoch,
  getTeamStoreState: () => ({ me: { user: { id: transport.user } } }),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: transport.request,
}));
vi.mock("../../../platform/cloud-github", () => ({
  authorizeCloudGithubSource: transport.source,
}));

import {
  activateCloudComputerV2,
  buildCloudComputerV2,
  cancelCloudComputerV2Build,
  clearCloudComputersV2,
  cloudComputerV2BuildCache,
  cloudComputerV2BuildKey,
  cloudComputerV2Cache,
  cloudComputerV2Key,
  cloudComputerV2LogsCache,
  discardCloudComputerV2,
  loadCloudComputerV2,
  loadCloudComputerV2Build,
  loadCloudComputerV2Logs,
  loadCloudComputerV2History,
  prefetchCloudComputerV2,
  rebuildCloudComputerV2,
  refreshCloudComputerV2,
  saveCloudComputerV2Draft,
} from "../cloud-computer-v2-client";

const key = cloudComputerV2Key(computerUser, computerOrg);
const buildKey = cloudComputerV2BuildKey(
  computerUser,
  computerOrg,
  computerBuildId,
);
const root = `/v1/organizations/${computerOrg}/cloud-computer/v2`;
const draft = { repositories: [], installScript: "true", timeoutSeconds: 30 };

beforeEach(() => {
  transport.epoch = 0;
  transport.user = computerUser;
  transport.request.mockReset();
  transport.source.mockReset();
  clearCloudComputersV2();
});

describe("Cloud Computer v2 exact-key server state", () => {
  it("shares intent and panel reads, restores A → B → A synchronously, and keeps unchanged references", async () => {
    const pending = deferred<CloudComputerV2State>();
    transport.request.mockReturnValueOnce(pending.promise);
    const warm = prefetchCloudComputerV2(computerUser, computerOrg);
    const mount = loadCloudComputerV2(key);
    await Promise.resolve();
    expect(transport.request).toHaveBeenCalledTimes(1);
    pending.resolve(computerState({ revision: 1 }));
    await Promise.all([warm, mount]);
    const a = cloudComputerV2Cache.getSnapshot(key).data;
    transport.request.mockResolvedValueOnce(computerState({ revision: 7 }));
    await prefetchCloudComputerV2(computerUser, otherComputerOrg);
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(a);
    await loadCloudComputerV2(key);
    expect(transport.request).toHaveBeenCalledTimes(2);
    transport.request.mockResolvedValueOnce(computerState({ revision: 1 }));
    await loadCloudComputerV2(key, { force: true });
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(a);
  });

  it("retains the last confirmed snapshot during slow and failed revalidation", async () => {
    transport.request.mockResolvedValueOnce(computerState({ revision: 1 }));
    await loadCloudComputerV2(key);
    const previous = cloudComputerV2Cache.getSnapshot(key).data;
    const pending = deferred<CloudComputerV2State>();
    transport.request.mockReturnValueOnce(pending.promise);
    const read = loadCloudComputerV2(key, { force: true });
    expect(cloudComputerV2Cache.getSnapshot(key)).toMatchObject({
      data: previous,
      refreshing: true,
      loading: false,
    });
    pending.reject(new Error("offline"));
    await expect(read).rejects.toThrow("offline");
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(previous);
  });

  it("rejects an old account epoch, including a late reply after the same account signs back in", async () => {
    const pending = deferred<CloudComputerV2State>();
    transport.request.mockReturnValueOnce(pending.promise);
    const old = loadCloudComputerV2(key);
    await Promise.resolve();
    transport.epoch++;
    clearCloudComputersV2();
    transport.request.mockResolvedValueOnce(computerState({ revision: 9 }));
    await loadCloudComputerV2(key);
    pending.resolve(computerState({ revision: 1 }));
    await expect(old).rejects.toThrow(/account changed/i);
    expect(cloudComputerV2Cache.getSnapshot(key).data?.revision).toBe(9);
  });

  it("does not request account A's key using account B's transport", async () => {
    transport.user = "55555555-5555-4555-8555-555555555555";
    await expect(loadCloudComputerV2(key)).rejects.toThrow(/account changed/i);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("does not serve a warm account A snapshot after replacement", async () => {
    transport.request.mockResolvedValueOnce(computerState());
    await loadCloudComputerV2(key);
    transport.user = "55555555-5555-4555-8555-555555555555";
    await expect(loadCloudComputerV2(key)).rejects.toThrow(/account changed/i);
  });

  it("fences the write's initiating epoch even when empty repository preparation yields", async () => {
    const old = saveCloudComputerV2Draft(key, 0, draft);
    transport.epoch++;
    await expect(old).rejects.toThrow(/account changed/i);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it("fences reads begun before a write and revisions below the accepted mutation", async () => {
    transport.request.mockResolvedValueOnce(computerState({ revision: 1 }));
    await loadCloudComputerV2(key);
    const previous = cloudComputerV2Cache.getSnapshot(key).data;
    const pending = deferred<CloudComputerV2State>();
    transport.request.mockReturnValueOnce(pending.promise);
    const old = loadCloudComputerV2(key, { force: true });
    await Promise.resolve();
    transport.request.mockResolvedValueOnce({
      revision: 2,
      configId: computerOperationId,
      unbuiltChanges: true,
    });
    await saveCloudComputerV2Draft(key, 1, draft);
    pending.resolve(computerState({ revision: 1 }));
    await expect(old).rejects.toThrow(/changed/i);
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(previous);
    transport.request.mockResolvedValueOnce(computerState({ revision: 1 }));
    await expect(refreshCloudComputerV2(key)).rejects.toThrow(/changed/i);
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(previous);
    transport.request.mockResolvedValueOnce(computerState({ revision: 2 }));
    await refreshCloudComputerV2(key);
    expect(cloudComputerV2Cache.getSnapshot(key).data?.revision).toBe(2);
  });

  it("ignores out-of-order mutation replies and never lets the older revision become authoritative", async () => {
    const first = deferred<{
      revision: number;
      configId: string;
      unbuiltChanges: boolean;
    }>();
    transport.request
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        revision: 3,
        configId: computerOperationId,
        unbuiltChanges: true,
      });
    const old = saveCloudComputerV2Draft(key, 1, draft);
    await saveCloudComputerV2Draft(key, 2, draft);
    first.resolve({
      revision: 2,
      configId: computerOperationId,
      unbuiltChanges: true,
    });
    await expect(old).rejects.toThrow(/changed/i);
    transport.request.mockResolvedValueOnce(computerState({ revision: 2 }));
    await expect(loadCloudComputerV2(key)).rejects.toThrow(/changed/i);
  });

  it("validates response metadata without hydrating secret values or provider fields", async () => {
    transport.request.mockImplementation(async (_path, schema) =>
      schema.parse({
        ...computerState(),
        draft: {
          ...computerState().draft,
          environment: [
            { name: "EXAMPLE", set: true, value: "unexpected-plaintext" },
          ],
        },
      }),
    );
    await expect(loadCloudComputerV2(key)).rejects.toThrow();
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBeUndefined();
  });

  it("retains unchanged history rows when progress changes and bounds inactive org entries", async () => {
    const build = computerBuild();
    transport.request.mockResolvedValueOnce(
      computerState({
        active: build,
        history: { builds: [build], nextCursor: null },
      }),
    );
    await loadCloudComputerV2(key);
    const row = cloudComputerV2Cache.getSnapshot(key).data!.history.builds[0];
    transport.request.mockResolvedValueOnce(
      computerState({
        revision: 1,
        active: { ...build },
        history: { builds: [{ ...build }], nextCursor: null },
      }),
    );
    await loadCloudComputerV2(key, { force: true });
    expect(cloudComputerV2Cache.getSnapshot(key).data!.history.builds[0]).toBe(
      row,
    );
    transport.request.mockResolvedValue(computerState());
    for (let n = 0; n < 40; n++) {
      await loadCloudComputerV2(
        cloudComputerV2Key(
          computerUser,
          `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
        ),
      );
    }
    expect(cloudComputerV2Cache.keys().length).toBeLessThanOrEqual(32);
  });
});

describe("Cloud Computer v2 typed API", () => {
  it("revalidates an exact older cursor after same-revision template retirement", async () => {
    const row = computerBuild();
    transport.request.mockResolvedValueOnce(
      computerState({
        revision: 31,
        history: { builds: [row], nextCursor: null },
      }),
    );
    await loadCloudComputerV2History(key, "older-v1");
    transport.request.mockResolvedValueOnce(
      computerState({
        revision: 31,
        history: {
          builds: [{ ...row, templateState: "retired" }],
          nextCursor: null,
        },
      }),
    );
    const [first, second] = await Promise.all([
      loadCloudComputerV2History(key, "older-v1", { force: true }),
      loadCloudComputerV2History(key, "older-v1", { force: true }),
    ]);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(first).toBe(second);
    expect(first.revision).toBe(31);
    expect(first.history.builds[0].templateState).toBe("retired");
    expect(cloudComputerV2Cache.peekSnapshot(key).data).toBeUndefined();
  });
  it("shares exact-cursor history reads without replacing the current state page", async () => {
    transport.request.mockResolvedValueOnce(computerState({ revision: 1 }));
    await loadCloudComputerV2(key);
    const current = cloudComputerV2Cache.getSnapshot(key).data;
    transport.request.mockResolvedValueOnce(
      computerState({
        revision: 1,
        history: { builds: [computerBuild()], nextCursor: null },
      }),
    );
    await Promise.all([
      loadCloudComputerV2History(key, "older/page"),
      loadCloudComputerV2History(key, "older/page"),
    ]);
    expect(transport.request).toHaveBeenCalledTimes(2);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}?cursor=older%2Fpage&limit=30`,
      expect.anything(),
    );
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBe(current);
  });

  it("proves new selections using the saving admin, while preserving already approved org-shared repositories", async () => {
    const repository = {
      id: "123",
      owner: "example",
      name: "project",
      installationId: computerOperationId,
      requestedRef: null,
    };
    transport.source.mockResolvedValueOnce({
      repository: { id: "123" },
      installationId: computerOperationId,
    });
    transport.request.mockResolvedValueOnce({
      revision: 1,
      configId: computerOperationId,
      unbuiltChanges: true,
    });
    await saveCloudComputerV2Draft(key, 0, {
      ...draft,
      repositories: [repository],
    });
    expect(transport.source).toHaveBeenCalledWith(
      computerOrg,
      "example",
      "project",
      computerOperationId,
    );
    transport.source.mockClear();
    cloudComputerV2Cache.setData(
      key,
      computerState({
        revision: 1,
        draft: { ...computerState().draft, repositories: [repository] },
      }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 2,
      configId: computerOperationId,
      unbuiltChanges: true,
    });
    await saveCloudComputerV2Draft(key, 1, {
      ...draft,
      repositories: [repository],
    });
    expect(transport.source).not.toHaveBeenCalled();
  });
  it("sends the C1 CAS contracts and uses operation IDs only for build/version actions", async () => {
    const build = computerBuild();
    transport.request.mockResolvedValueOnce({
      revision: 1,
      configId: computerOperationId,
      unbuiltChanges: true,
    });
    await saveCloudComputerV2Draft(key, 0, draft);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/draft`,
      expect.anything(),
      expect.objectContaining({
        method: "PUT",
        body: { ...draft, expectedRevision: 0 },
      }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 2,
      configId: computerOperationId,
      unbuiltChanges: false,
    });
    await discardCloudComputerV2(key, 1);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/discard`,
      expect.anything(),
      expect.objectContaining({ body: { expectedRevision: 1 } }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 3,
      build,
      replayed: false,
    });
    await buildCloudComputerV2(key, 2, computerOperationId, draft);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/builds`,
      expect.anything(),
      expect.objectContaining({
        body: { expectedRevision: 2, operationId: computerOperationId, draft },
        idempotencyKey: computerOperationId,
      }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 4,
      build,
      cancelled: false,
      cancelRequested: true,
      alreadyCompleted: false,
    });
    await cancelCloudComputerV2Build(key, 3, computerBuildId);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/builds/${computerBuildId}/cancel`,
      expect.anything(),
      expect.objectContaining({ body: { expectedRevision: 3 } }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 5,
      activeBuildId: computerBuildId,
      activated: true,
      replayed: false,
    });
    await activateCloudComputerV2(key, 4, 1, computerOperationId);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/versions/1/activate`,
      expect.anything(),
      expect.objectContaining({
        body: { expectedRevision: 4, operationId: computerOperationId },
      }),
    );
    transport.request.mockResolvedValueOnce({
      revision: 6,
      build,
      replayed: false,
    });
    await rebuildCloudComputerV2(key, 5, 1, computerOperationId);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/versions/1/rebuild`,
      expect.anything(),
      expect.objectContaining({
        body: { expectedRevision: 5, operationId: computerOperationId },
      }),
    );
  });

  it("shares per-build reads and incremental cursors, while keeping build identities isolated", async () => {
    transport.request.mockResolvedValueOnce(computerBuild());
    await Promise.all([
      loadCloudComputerV2Build(buildKey),
      loadCloudComputerV2Build(buildKey),
    ]);
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(cloudComputerV2BuildCache.getSnapshot(buildKey).data?.id).toBe(
      computerBuildId,
    );
    const entry = {
      seq: 1,
      stream: "stdout",
      stage: "install",
      text: "ready\n",
      createdAt: "2026-10-04T10:00:00.000Z",
    };
    transport.request.mockResolvedValueOnce({
      entries: [entry],
      firstSeq: 1,
      lastSeq: 1,
      nextAfter: 1,
      truncated: false,
      complete: false,
    });
    await Promise.all([
      loadCloudComputerV2Logs(buildKey),
      loadCloudComputerV2Logs(buildKey),
    ]);
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/builds/${computerBuildId}/log?after=0&limit=100`,
      expect.anything(),
    );
    const log = cloudComputerV2LogsCache.getSnapshot(buildKey).data;
    transport.request.mockResolvedValueOnce({
      entries: [],
      firstSeq: 1,
      lastSeq: 1,
      nextAfter: 1,
      truncated: false,
      complete: false,
    });
    await loadCloudComputerV2Logs(buildKey, { force: true });
    expect(transport.request).toHaveBeenLastCalledWith(
      `${root}/builds/${computerBuildId}/log?after=1&limit=100`,
      expect.anything(),
    );
    expect(cloudComputerV2LogsCache.getSnapshot(buildKey).data).toBe(log);
    const otherKey = cloudComputerV2BuildKey(
      computerUser,
      otherComputerOrg,
      computerBuildId,
    );
    expect(cloudComputerV2LogsCache.getSnapshot(otherKey).data).toBeUndefined();
  });

  it("clears state, build and log snapshots, fencing a late log response", async () => {
    const pending = deferred<unknown>();
    transport.request.mockReturnValueOnce(pending.promise);
    const old = loadCloudComputerV2Logs(buildKey);
    await Promise.resolve();
    transport.epoch++;
    clearCloudComputersV2();
    pending.resolve({
      entries: [],
      firstSeq: null,
      lastSeq: null,
      nextAfter: 0,
      truncated: false,
      complete: true,
    });
    await expect(old).rejects.toThrow(/account changed/i);
    expect(cloudComputerV2LogsCache.getSnapshot(buildKey).data).toBeUndefined();
    expect(
      cloudComputerV2BuildCache.getSnapshot(buildKey).data,
    ).toBeUndefined();
    expect(cloudComputerV2Cache.getSnapshot(key).data).toBeUndefined();
  });
});

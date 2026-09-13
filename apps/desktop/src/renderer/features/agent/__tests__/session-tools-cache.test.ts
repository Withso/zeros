import { providerAuthChanged } from "../../../platform/provider-auth-state";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionToolsResource,
  warmPreparedSessionTools,
  createSessionInventoryReader,
} from "../session-tools-cache";
import type { SessionToolQuery } from "@zeros/protocol/agent-extensions";

const query: SessionToolQuery = {
  agentId: "codex",
  sessionId: "session-a",
  workspaceId: "workspace-a",
};
const connected = {
  state: "ready",
  entries: [{ id: "codex_apps", name: "codex_apps", status: "connected" }],
};

describe("composer tools cache", () => {
  it("merges partial categories independently and preserves unchanged group references", async () => {
    const initial = {
      ...connected,
      groups: [
        {
          kind: "plugins",
          state: "ready",
          entries: [{ id: "p", name: "Plugin", status: "enabled" }],
        },
        {
          kind: "apps",
          state: "ready",
          entries: [{ id: "a", name: "App", status: "available" }],
        },
        { kind: "mcp", state: "ready", entries: connected.entries },
      ],
    };
    const read = vi.fn().mockResolvedValue(initial);
    const resource = createSessionToolsResource(read);
    const key = resource.key(query);
    await resource.cache.load(key, () => resource.fetch(key));
    const previous = resource.cache.getSnapshot(key).data!;
    await resource.cache.load(key, () => resource.fetch(key), { maxAgeMs: -1 });
    expect(resource.cache.getSnapshot(key).data).toBe(previous);
    read.mockResolvedValue({
      state: "partial",
      entries: [],
      groups: [
        { kind: "plugins", state: "partial", entries: [] },
        { kind: "apps", state: "ready", entries: [] },
        { kind: "mcp", state: "ready", entries: [] },
      ],
    });
    await resource.cache.load(key, () => resource.fetch(key), { maxAgeMs: -1 });
    const current = resource.cache.getSnapshot(key).data!;
    expect(current.entries).toEqual([]);
    expect(current.groups![1].entries).toEqual([]);
    expect(current.groups![2].entries).toEqual([]);
    expect(current.groups![0].entries).toEqual([
      expect.objectContaining({
        id: "p",
        status: "unverified",
        canAuthenticate: false,
      }),
    ]);
    read.mockResolvedValue(initial);
    await resource.cache.load(key, () => resource.fetch(key), { maxAgeMs: -1 });
    expect(
      resource.cache.getSnapshot(key).data?.groups?.[0].entries[0].status,
    ).toBe("enabled");
  });

  it("deduplicates rows within a category without conflating equal IDs across categories", async () => {
    const read = vi.fn().mockResolvedValue({
      ...connected,
      groups: [
        {
          kind: "plugins",
          state: "ready",
          entries: [
            { id: "same", name: "Old plugin", status: "enabled" },
            { id: "same", name: "Plugin", status: "disabled" },
          ],
        },
        {
          kind: "apps",
          state: "ready",
          entries: [{ id: "same", name: "App", status: "available" }],
        },
      ],
    });
    const resource = createSessionToolsResource(read);
    const result = await resource.fetch(resource.key(query));
    expect(result.groups?.map((group) => group.entries.length)).toEqual([1, 1]);
    expect(result.groups?.[0].entries[0].name).toBe("Plugin");
  });

  it("rejects grouped results from a previous account", async () => {
    let finish!: (value: unknown) => void;
    const resource = createSessionToolsResource(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const key = resource.key(query);
    const pending = resource.cache.load(key, () => resource.fetch(key));
    await Promise.resolve();
    providerAuthChanged();
    finish({
      ...connected,
      groups: [
        {
          kind: "apps",
          state: "ready",
          entries: [
            { id: "private-app", name: "Old account", status: "available" },
          ],
        },
      ],
    });
    await expect(pending).rejects.toThrow("connection changed");
    expect(
      resource.cache.getSnapshot(resource.key(query)).data,
    ).toBeUndefined();
  });
  it("warms capabilities only after admission and shares the Tools cache", async () => {
    let finish!: () => void;
    const admission = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = vi.fn().mockResolvedValue(connected);
    const resource = createSessionToolsResource(read);
    const load = warmPreparedSessionTools(
      resource,
      () => admission,
      () => query,
    );
    expect(read).not.toHaveBeenCalled();
    finish();
    await load;
    await resource.cache.load(
      resource.key(query),
      () => resource.fetch(resource.key(query)),
      { maxAgeMs: 5_000 },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(query);
  });

  it.each(["account", "bridge", "hidden", "removed"])(
    "does not warm capabilities when %s changes during admission",
    async (change) => {
      let finish!: () => void;
      const admission = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let identity = "engine-a";
      let selection: SessionToolQuery | null = query;
      const read = vi.fn().mockResolvedValue(connected);
      const resource = createSessionToolsResource(read, () => identity);
      const load = warmPreparedSessionTools(
        resource,
        () => admission,
        () => selection,
      );
      if (change === "account") providerAuthChanged();
      else if (change === "bridge") identity = "engine-b";
      else selection = null;
      finish();
      await load;
      expect(read).not.toHaveBeenCalled();
    },
  );

  it("shares intent/open reads and keeps confirmed rows during refresh and failures", async () => {
    const read = vi.fn().mockResolvedValue(connected);
    const resource = createSessionToolsResource(read);
    const key = resource.key(query);
    await Promise.all([
      resource.cache.load(key, () => resource.fetch(key)),
      resource.cache.load(key, () => resource.fetch(key)),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    const previous = resource.cache.getSnapshot(key).data;
    read.mockRejectedValue(new Error("offline"));
    const refresh = resource.cache.load(key, () => resource.fetch(key), {
      maxAgeMs: -1,
    });
    expect(resource.cache.getSnapshot(key).data).toBe(previous);
    await expect(refresh).rejects.toThrow();
    expect(resource.cache.getSnapshot(key).data).toBe(previous);
  });
  it("retains references for unchanged status and marks missing partial rows unverified", async () => {
    const read = vi.fn().mockResolvedValue(connected);
    const resource = createSessionToolsResource(read);
    const key = resource.key(query);
    await resource.cache.load(key, () => resource.fetch(key));
    const previous = resource.cache.getSnapshot(key).data;
    await resource.cache.load(key, () => resource.fetch(key), { maxAgeMs: -1 });
    expect(resource.cache.getSnapshot(key).data).toBe(previous);
    read.mockResolvedValue({ state: "partial", entries: [] });
    await resource.cache.load(key, () => resource.fetch(key), { maxAgeMs: -1 });
    expect(resource.cache.getSnapshot(key).data?.entries).toEqual([
      expect.objectContaining({
        id: "codex_apps",
        status: "error",
        canAuthenticate: false,
      }),
    ]);
  });
  it("isolates workspace/provider/execution and rejects an old bridge or account result", async () => {
    let identity = "engine-a";
    let finish!: (value: unknown) => void;
    const resource = createSessionToolsResource(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      () => identity,
    );
    const key = resource.key(query);
    expect(resource.key({ ...query, workspaceId: "workspace-b" })).not.toBe(
      key,
    );
    expect(resource.key({ ...query, agentId: "claude" })).not.toBe(key);
    expect(resource.key({ ...query, sessionId: "session-b" })).not.toBe(key);
    const load = resource.cache.load(key, () => resource.fetch(key));
    await Promise.resolve();
    identity = "engine-b";
    finish(connected);
    await expect(load).rejects.toThrow("connection changed");
    expect(resource.cache.getSnapshot(key).data).toBeUndefined();
    expect(
      resource.cache.getSnapshot(resource.key(query)).data,
    ).toBeUndefined();
  });
  it("isolates provider sign-in changes and bounds inactive chat snapshots", async () => {
    const resource = createSessionToolsResource(async () => connected);
    const before = resource.key(query);
    providerAuthChanged();
    expect(resource.key(query)).not.toBe(before);
    await expect(resource.fetch(before)).rejects.toThrow("connection changed");
    for (let index = 0; index < 40; index++) {
      const key = resource.key({ ...query, sessionId: `session-${index}` });
      await resource.cache.load(key, () => resource.fetch(key));
    }
    expect(resource.cache.keys().length).toBeLessThanOrEqual(32);
  });
  it("keeps A → B → A snapshots and applies authoritative deletions", async () => {
    const read = vi.fn().mockResolvedValue(connected);
    const resource = createSessionToolsResource(read);
    const a = resource.key(query),
      b = resource.key({ ...query, workspaceId: "b" });
    await resource.cache.load(a, () => resource.fetch(a));
    const previous = resource.cache.getSnapshot(a).data;
    await resource.cache.load(b, () => resource.fetch(b));
    expect(resource.cache.getSnapshot(a).data).toBe(previous);
    read.mockResolvedValue({ state: "ready", entries: [] });
    await resource.cache.load(a, () => resource.fetch(a), { maxAgeMs: -1 });
    expect(resource.cache.getSnapshot(a).data?.entries).toEqual([]);
  });
});

describe("session inventory compatibility", () => {
  it.each(["VALIDATION_FAILED", "REMOTE_OP_NOT_ALLOWED"])(
    "falls back only for an unsupported operation (%s), once per engine identity",
    async (code) => {
      let identity = "engine-a";
      const read = vi.fn(async (op: string) => {
        if (op === "tools.session.inventory")
          throw Object.assign(
            new Error("unknown workspace op: tools.session.inventory"),
            { code },
          );
        return connected;
      });
      const inventory = createSessionInventoryReader(read, () => identity);
      expect(await inventory(query)).toBe(connected);
      expect(await inventory(query)).toBe(connected);
      expect(read.mock.calls.map(([op]) => op)).toEqual([
        "tools.session.inventory",
        "tools.session.list",
        "tools.session.list",
      ]);
      identity = "engine-b";
      await inventory(query);
      expect(read.mock.calls.at(-2)?.[0]).toBe("tools.session.inventory");
    },
  );

  it.each(["AUTH_REQUIRED", "TIMEOUT", "VALIDATION_FAILED"])(
    "does not hide genuine inventory errors (%s) with a legacy fallback",
    async (code) => {
      const error = Object.assign(new Error("Could not read this chat"), {
        code,
      });
      const read = vi.fn().mockRejectedValue(error);
      await expect(
        createSessionInventoryReader(read, () => "engine")(query),
      ).rejects.toBe(error);
      expect(read).toHaveBeenCalledOnce();
    },
  );
});

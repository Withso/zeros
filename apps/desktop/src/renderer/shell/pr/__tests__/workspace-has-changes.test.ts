import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../platform/git";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refreshKey: 1,
  gitHasChanges: vi.fn(),
  setLive: vi.fn(),
  refresh: vi.fn(),
  surface: "default",
  live: new Map<string, unknown>(),
}));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: (effect: () => void | (() => void)) =>
    fixture.effects.push(effect),
  // Retain each surface's own local state independently of the shared cache.
  // Effect cleanup below supplies the lifecycle guarding late responses.
  useState: (initial: unknown) => {
    const surface = fixture.surface;
    return [
      fixture.live.get(surface) ?? initial,
      (update: unknown) => {
        fixture.setLive(update);
        const previous = fixture.live.get(surface) ?? initial;
        fixture.live.set(
          surface,
          typeof update === "function" ? update(previous) : update,
        );
      },
    ];
  },
}));
vi.mock("../../../platform/git", () => ({
  gitHasChanges: fixture.gitHasChanges,
}));
vi.mock("../../use-git-refresh-key", () => ({
  useGitRefreshKey: (...args: unknown[]) => {
    fixture.refresh(...args);
    return fixture.refreshKey;
  },
}));

let useWorkspaceHasChanges: typeof import("../use-workspace-has-changes").useWorkspaceHasChanges;
const cleanups: Array<() => void> = [];
const workspace = (id: string) => ({ id, path: `/repo/${id}` }) as Workspace;

function mount(id = "ws-a", active = true, surface = "default") {
  fixture.surface = surface;
  fixture.effects.length = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- this deterministic harness supplies the mocked state and effect lifecycle
  const value = useWorkspaceHasChanges(workspace(id), active);
  for (const effect of fixture.effects) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  return value;
}

function unmount() {
  for (const cleanup of cleanups.splice(0)) cleanup();
}

async function flush() {
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.gitHasChanges.mockReset();
  fixture.refreshKey = 1;
  fixture.live.clear();
  ({ useWorkspaceHasChanges } = await import("../use-workspace-has-changes"));
});
afterEach(unmount);

describe("workspace PR availability reads", () => {
  it("shares concurrent surfaces and coalesces rapid refreshes without blocking another workspace", async () => {
    let resolve!: (value: boolean) => void;
    fixture.gitHasChanges
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(true);
    mount();
    mount("ws-a", true, "peer");
    await flush();
    for (let generation = 2; generation <= 30; generation++) {
      unmount();
      fixture.refreshKey = generation;
      mount();
    }
    mount("ws-b");
    await flush();
    const started = fixture.gitHasChanges.mock.calls.map(([id]) => id);
    resolve(false);
    await flush();

    expect(started).toEqual(["ws-a", "ws-b"]);
    expect(fixture.gitHasChanges.mock.calls.map(([id]) => id)).toEqual([
      "ws-a",
      "ws-b",
      "ws-a",
    ]);
    expect(mount()).toBe(true);
  });

  it("does not replace a confirmed result with a superseded response", async () => {
    fixture.gitHasChanges.mockResolvedValue(true);
    mount();
    await flush();
    unmount();

    let resolve!: (value: boolean) => void;
    fixture.gitHasChanges.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fixture.refreshKey = 2;
    expect(mount()).toBe(true);
    await flush();
    unmount();
    resolve(false);
    await flush();

    expect(mount("ws-b", false)).toBeUndefined();
    expect(mount("ws-a", false, "remounted")).toBe(true);
  });

  it("restores another surface's newer confirmation when a retained row fails to refresh", async () => {
    fixture.gitHasChanges.mockResolvedValueOnce(false);
    mount("ws-a", true, "row");
    await flush();
    unmount();

    fixture.refreshKey++;
    fixture.gitHasChanges.mockResolvedValueOnce(true);
    mount("ws-a", true, "dashboard");
    await flush();
    unmount();

    fixture.refreshKey++;
    fixture.gitHasChanges.mockRejectedValueOnce(new Error("bridge down"));
    expect(mount("ws-a", true, "row")).toBe(false);
    await flush();
    expect(mount("ws-a", false, "row")).toBe(true);
  });

  it("retains a confirmed result on failure and recovers on the next refresh", async () => {
    fixture.gitHasChanges.mockResolvedValue(true);
    mount();
    await flush();
    unmount();
    fixture.gitHasChanges.mockRejectedValueOnce(new Error("bridge down"));
    fixture.refreshKey++;
    mount();
    await flush();
    unmount();
    expect(mount("ws-a", false)).toBe(true);

    fixture.gitHasChanges.mockResolvedValue(false);
    fixture.refreshKey++;
    mount();
    await flush();
    expect(mount("ws-a", false)).toBe(false);
  });

  it("keeps a failed cold read unknown and hidden surfaces unsubscribed", async () => {
    fixture.gitHasChanges.mockRejectedValue(new Error("bridge down"));
    expect(mount()).toBeUndefined();
    await flush();
    expect(fixture.setLive).not.toHaveBeenCalled();
    expect(mount("ws-b", false)).toBeUndefined();
    expect(fixture.refresh).toHaveBeenLastCalledWith(
      "/repo/ws-b",
      "ws-b",
      false,
    );
    expect(fixture.gitHasChanges).toHaveBeenCalledTimes(1);
  });
});

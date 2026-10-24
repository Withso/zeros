import { describe, expect, it, vi } from "vitest";
import type { CloudV2Build } from "../../../platform/cloud-v2";
import { computerChanges, computerStatus, describeChanges, editableRepositories, historyNote, relativeAge } from "../cloud-computer-model";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const DAY = 86_400_000;
function build(version: number, patch: Partial<CloudV2Build> = {}): CloudV2Build {
  return {
    id: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`, organizationId: "11111111-1111-4111-8111-111111111111",
    version, recipe: { repositories: [{ repository: "iamarunrk/0kit", commit: "a".repeat(40), branch: "main" }] },
    state: "succeeded", snapshotId: null, errorCode: null, createdAt: ago(13 * DAY), startedAt: ago(13 * DAY), finishedAt: ago(13 * DAY),
    ...patch,
  };
}

describe("Cloud Computer model", () => {
  it("keeps only what an admin edits from a build", () => {
    expect(editableRepositories(build(1, { recipe: { repositories: [
      { repository: "iamarunrk/0kit", commit: "a".repeat(40), branch: "main", setup: "pnpm install" },
      { repository: "withso/zeros", ref: "release" },
    ], rebuiltFrom: 1 } }))).toEqual([
      { repository: "iamarunrk/0kit", setup: "pnpm install" },
      { repository: "withso/zeros", ref: "release" },
    ]);
    expect(editableRepositories(undefined)).toEqual([]);
  });

  it("reports an added repository beside the installed one as unbuilt repositories", () => {
    const live = [{ repository: "iamarunrk/0kit" }];
    expect(computerChanges(live, live)).toEqual([]);
    expect(computerChanges([{ repository: "IAMARUNRK/0kit" }], live)).toEqual([]);
    const added = [...live, { repository: "withso/zeros-dev-fixture" }];
    expect(computerChanges(added, live)).toEqual(["repositories"]);
    expect(describeChanges(computerChanges(added, live))).toBe("Changed: repositories");
    // Removal only happens when the admin removes it, and it is unbuilt too.
    expect(computerChanges([], live)).toEqual(["repositories"]);
    expect(computerChanges([{ repository: "iamarunrk/0kit", ref: "dev", setup: "make" }], live)).toEqual(["branches", "setup"]);
    expect(computerChanges([{ repository: "b/b" }, { repository: "a/a" }], [{ repository: "a/a" }, { repository: "b/b" }])).toEqual([]);
  });

  it("summarizes the computer the way the settings card shows it", () => {
    const active = build(5);
    const base = { builds: [active], activeBuildId: active.id, changes: [], configuredCount: 1, now };
    expect(computerStatus(base)).toEqual({ kind: "built", title: "Last build 13d ago", detail: null });
    expect(computerStatus({ ...base, changes: ["repositories"] })).toEqual({ kind: "unbuilt", title: "Unbuilt changes", detail: "Changed: repositories" });
    const running = build(6, { state: "building", finishedAt: null, reason: "runtime" });
    expect(computerStatus({ ...base, builds: [running, active], changes: ["repositories"] }))
      .toEqual({ kind: "building", title: "Building computer…", detail: "Build #6 · runtime update" });
    const failed = build(6, { state: "failed", errorCode: "computer_setup_failed", finishedAt: ago(2 * 3_600_000) });
    expect(computerStatus({ ...base, builds: [failed, active] }))
      .toEqual({ kind: "failed", title: "Last build failed 2h ago", detail: "A setup script failed." });
    expect(computerStatus({ builds: [], activeBuildId: null, changes: [], configuredCount: 0, now }).kind).toBe("empty");
  });

  it("formats ages and history notes briefly", () => {
    expect(relativeAge(ago(10_000), now)).toBe("just now");
    expect(relativeAge(ago(5 * 60_000), now)).toBe("5m ago");
    expect(relativeAge(ago(13 * DAY), now)).toBe("13d ago");
    expect(relativeAge(ago(95 * DAY), now)).toBe("3mo ago");
    expect(relativeAge(null, now)).toBeNull();
    expect(historyNote(build(7, { reason: "refresh" }))).toBe("Daily refresh");
    expect(historyNote(build(8, { recipe: { repositories: [], rebuiltFrom: 4 } }))).toBe("From #4");
    expect(historyNote(build(9))).toBeNull();
  });
});

describe("Cloud Computer recipe saves", () => {
  it("saves in order, coalescing edits made during a save into the next one", async () => {
    const { RecipeSaveQueue } = await import("../cloud-computer-model");
    const saved: { value: string[]; revision: number }[] = [];
    let release!: () => void;
    const onSaved = vi.fn(), onError = vi.fn();
    const queue = new RecipeSaveQueue<string[]>({
      save: async (value, revision) => {
        saved.push({ value, revision });
        if (saved.length === 1) await new Promise<void>(resolve => { release = resolve; });
        return revision + 1;
      },
      serverRevision: () => 3, onSaved, onError,
    });
    queue.push(["a"]);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    queue.push(["a", "b"]); queue.push(["a", "b", "c"]);
    release();
    await queue.settle();
    expect(saved).toEqual([{ value: ["a"], revision: 3 }, { value: ["a", "b", "c"], revision: 4 }]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the revision an edit started from when a refresh brings another admin's revision", async () => {
    const { RecipeSaveQueue } = await import("../cloud-computer-model");
    let server = 3;
    const save = vi.fn(async (_value: string, revision: number) => revision + 1);
    const queue = new RecipeSaveQueue<string>({ save, serverRevision: () => server, onSaved: () => {}, onError: () => {} });
    vi.useFakeTimers();
    try {
      queue.push("typed", 600);
      server = 9; // a poll replaced the cached overview meanwhile
      expect(queue.revision()).toBe(3);
      await queue.settle();
      expect(save).toHaveBeenCalledExactlyOnceWith("typed", 3);
      // Idle again: the next edit starts from what the view now shows.
      expect(queue.revision()).toBe(9);
    } finally { vi.useRealTimers(); }
  });

  it("waits out a typing pause on settle and drops queued edits after a conflict", async () => {
    vi.useFakeTimers();
    try {
      const { RecipeSaveQueue } = await import("../cloud-computer-model");
      const save = vi.fn(async (_value: string, revision: number) => revision + 1), onError = vi.fn();
      const queue = new RecipeSaveQueue<string>({ save, serverRevision: () => 1, onSaved: () => {}, onError });
      queue.push("typed", 600);
      expect(queue.waiting).toBe(true);
      expect(save).not.toHaveBeenCalled();
      await queue.settle();
      expect(save).toHaveBeenCalledExactlyOnceWith("typed", 1);
      save.mockRejectedValueOnce(new Error("computer_recipe_changed"));
      queue.push("stale");
      await expect(queue.settle()).rejects.toThrow("computer_recipe_changed");
      expect(onError).toHaveBeenCalledOnce();
      queue.push("later", 600); queue.cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("reports a failed save to whoever waits to build, so an older configuration is never built", async () => {
    const { RecipeSaveQueue } = await import("../cloud-computer-model");
    const onError = vi.fn();
    const queue = new RecipeSaveQueue<string>({ save: async () => { throw new Error("offline"); }, serverRevision: () => 1, onSaved: () => {}, onError });
    queue.push("edited");
    await expect(queue.settle()).rejects.toThrow("offline");
    expect(onError).toHaveBeenCalledOnce();
    // Reported once: the server's version is what is shown and may be built.
    await expect(queue.settle()).resolves.toBeUndefined();
  });

  it("completes once when a typing pause's edit is saved by the save already running", async () => {
    vi.useFakeTimers();
    try {
      const { RecipeSaveQueue } = await import("../cloud-computer-model");
      let release!: () => void;
      const save = vi.fn(async (_value: string, revision: number) => {
        if (save.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
        return revision + 1;
      });
      const onSaved = vi.fn();
      const queue = new RecipeSaveQueue<string>({ save, serverRevision: () => 1, onSaved, onError: () => {} });
      queue.push("first");
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      queue.push("typed", 600);
      release();
      await queue.settle();
      expect(save).toHaveBeenLastCalledWith("typed", 2);
      expect(onSaved).toHaveBeenCalledOnce();
      expect(queue.waiting).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(2);
      expect(onSaved).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("lets the next edit take the shown revision after a failed save dropped a typing pause", async () => {
    vi.useFakeTimers();
    try {
      const { RecipeSaveQueue } = await import("../cloud-computer-model");
      let server = 1, fail!: (error: Error) => void;
      const save = vi.fn((_value: string, revision: number) => save.mock.calls.length === 1
        ? new Promise<number>((_, reject) => { fail = reject; }) : Promise.resolve(revision + 1));
      const queue = new RecipeSaveQueue<string>({ save, serverRevision: () => server, onSaved: () => {}, onError: () => {} });
      queue.push("A");
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      queue.push("B", 600);
      fail(new Error("offline"));
      await expect(queue.settle()).rejects.toThrow("offline");
      expect(queue.waiting).toBe(false);
      server = 2; // the refreshed view after the failure
      queue.push("C", 600);
      server = 3; // another admin saves before C is sent
      await queue.settle();
      expect(save).toHaveBeenLastCalledWith("C", 2);
    } finally { vi.useRealTimers(); }
  });
});

describe("Cloud Computer recipe replies", () => {
  it("never let a late reply replace a newer revision, and merge into the freshest overview", async () => {
    const { newerRecipe } = await import("../cloud-computer-model");
    const fresh = { activeBuildId: "build-3", recipeRevision: 3, recipe: { repositories: [{ repository: "a/a" }] } };
    expect(newerRecipe(fresh, { recipe: { repositories: [] }, recipeRevision: 2 })).toBeNull();
    expect(newerRecipe(fresh, { recipe: { repositories: [] }, recipeRevision: 3 })).toBeNull();
    expect(newerRecipe(fresh, { recipe: { repositories: [{ repository: "b/b" }] }, recipeRevision: 4 }))
      .toEqual({ activeBuildId: "build-3", recipeRevision: 4, recipe: { repositories: [{ repository: "b/b" }] } });
    expect(newerRecipe(undefined, { recipe: { repositories: [] }, recipeRevision: 1 })).toBeNull();
  });
});

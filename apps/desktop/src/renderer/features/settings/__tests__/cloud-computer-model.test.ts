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
    const saved: string[][] = [];
    let release!: () => void;
    const onSaved = vi.fn(), onError = vi.fn();
    const queue = new RecipeSaveQueue<string[]>({
      save: async value => { saved.push(value); if (saved.length === 1) await new Promise<void>(resolve => { release = resolve; }); },
      onSaved, onError,
    });
    queue.push(["a"]);
    await vi.waitFor(() => expect(saved).toEqual([["a"]]));
    queue.push(["a", "b"]); queue.push(["a", "b", "c"]);
    release();
    await queue.settle();
    expect(saved).toEqual([["a"], ["a", "b", "c"]]);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits out a typing pause on settle and drops queued edits after a conflict", async () => {
    vi.useFakeTimers();
    try {
      const { RecipeSaveQueue } = await import("../cloud-computer-model");
      const save = vi.fn(async (_value: string) => {}), onError = vi.fn();
      const queue = new RecipeSaveQueue<string>({ save, onSaved: () => {}, onError });
      queue.push("typed", 600);
      expect(queue.waiting).toBe(true);
      expect(save).not.toHaveBeenCalled();
      await queue.settle();
      expect(save).toHaveBeenCalledExactlyOnceWith("typed");
      save.mockRejectedValueOnce(new Error("computer_recipe_changed"));
      queue.push("stale");
      await queue.settle();
      expect(onError).toHaveBeenCalledOnce();
      queue.push("later", 600); queue.cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(save).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

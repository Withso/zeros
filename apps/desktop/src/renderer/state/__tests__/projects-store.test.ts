// Regression test for "removing the only repo doesn't delete it".
//
// Root cause: removeProject of the LAST project wrote an empty primary list
// but left the `projects-v1-backup` snapshot intact, so loadProjects() restored
// the just-removed repo from the backup on the next read. The fix clears the
// backup when an explicit removal empties the list. These tests pin both the
// multi-repo path (already worked) and the last-repo path (the bug).
//
// The node test env has no DOM, so we install a tiny in-memory localStorage
// before importing the store (getSetting/setSetting are localStorage-backed).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadProjects,
  removeProject,
  upsertProject,
} from "../projects-store";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return Array.from(this.m.keys())[i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage =
    new MemStorage() as unknown as Storage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

// projects-store only touches localStorage at call time (inside the tests,
// after beforeEach installs the polyfill) — the top-level import is safe.
const BACKUP_KEY = "zeros-projects-v1-backup"; // PREFIX + BACKUP_KEY

describe("removeProject — backup recovery", () => {
  it("removing one of several repos leaves the rest (no resurrection)", () => {
    const a = upsertProject({ repoRoot: "/repo/a" });
    upsertProject({ repoRoot: "/repo/b" });

    removeProject(a.id);

    expect(loadProjects().map((p) => p.repoRoot)).toEqual(["/repo/b"]);
    // A second read (simulating a reload) must stay stable.
    expect(loadProjects().map((p) => p.repoRoot)).toEqual(["/repo/b"]);
  });

  it("removing the LAST repo keeps it removed across reloads", () => {
    const a = upsertProject({ repoRoot: "/repo/only" });

    removeProject(a.id);

    // First read after removal.
    expect(loadProjects()).toEqual([]);
    // The backup must also be cleared — otherwise the NEXT loadProjects()
    // (a reload) would restore the removed repo from it. This is the bug.
    expect(localStorage.getItem(BACKUP_KEY)).toBe(JSON.stringify([]));
    // Simulated reload: must NOT resurrect the repo.
    expect(loadProjects()).toEqual([]);
  });

  it("re-adding after removing the last repo works (fresh, not a ghost)", () => {
    const a = upsertProject({ repoRoot: "/repo/only" });
    removeProject(a.id);
    expect(loadProjects()).toEqual([]);

    const b = upsertProject({ repoRoot: "/repo/fresh" });
    expect(loadProjects().map((p) => p.repoRoot)).toEqual(["/repo/fresh"]);
    expect(b.repoRoot).toBe("/repo/fresh");
  });
});

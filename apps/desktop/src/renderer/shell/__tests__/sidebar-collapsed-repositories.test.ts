import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetRepositoryCollapsed,
  repositoryCollapsed,
  resetCollapsedRepositoriesForTests,
  setRepositoryCollapsed,
} from "../sidebar-collapsed-repositories";

const STORAGE_KEY = "zeros-sidebar-collapsed-repositories-v1";
let values: Map<string, string>;

function installStorage(): void {
  values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}

function stored(): unknown {
  const raw = values.get(STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

beforeEach(() => {
  installStorage();
  resetCollapsedRepositoriesForTests();
});

describe("sidebar repository collapse", () => {
  it("is expanded until a repository is collapsed, per repository", () => {
    expect(repositoryCollapsed("project-a")).toBe(false);

    setRepositoryCollapsed("project-a", true);

    expect(repositoryCollapsed("project-a")).toBe(true);
    expect(repositoryCollapsed("project-b")).toBe(false);
    expect(stored()).toEqual(["project-a"]);
  });

  it("restores the persisted state on the next read", () => {
    values.set(STORAGE_KEY, JSON.stringify(["project-a", "project-b"]));
    resetCollapsedRepositoriesForTests();

    expect(repositoryCollapsed("project-b")).toBe(true);
  });

  it("expands and forgets a removed repository", () => {
    setRepositoryCollapsed("project-a", true);
    setRepositoryCollapsed("project-b", true);

    setRepositoryCollapsed("project-a", false);
    forgetRepositoryCollapsed("project-b");

    expect(repositoryCollapsed("project-a")).toBe(false);
    expect(repositoryCollapsed("project-b")).toBe(false);
    expect(stored()).toEqual([]);
  });

  it("ignores corrupt stored values instead of collapsing anything", () => {
    values.set(
      STORAGE_KEY,
      JSON.stringify(["project-a", 7, "", null, "x".repeat(600)]),
    );
    resetCollapsedRepositoriesForTests();
    expect(repositoryCollapsed("project-a")).toBe(true);
    expect(repositoryCollapsed("")).toBe(false);

    values.set(STORAGE_KEY, JSON.stringify({ project: true }));
    resetCollapsedRepositoriesForTests();
    expect(repositoryCollapsed("project")).toBe(false);
  });

  it("keeps the most recent 256 repositories", () => {
    for (let index = 0; index < 300; index += 1) {
      setRepositoryCollapsed(`project-${index}`, true);
    }

    expect((stored() as string[]).length).toBe(256);
    expect(repositoryCollapsed("project-299")).toBe(true);
    expect(repositoryCollapsed("project-0")).toBe(false);
  });

  it("does not write when the state is unchanged", () => {
    setRepositoryCollapsed("project-a", false);
    expect(stored()).toBeUndefined();
  });
});

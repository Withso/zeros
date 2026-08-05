import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoBranchCatalog } from "@/renderer/platform/git";

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/renderer/platform/settings", () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    (settings.get(key) as T | undefined) ?? fallback,
  setSetting: (key: string, value: unknown) => void settings.set(key, value),
  removeSetting: (key: string) => void settings.delete(key),
}));

import {
  forgetRepoBranchCatalog,
  readRepoBranchCatalog,
  repoBranchCatalogCacheLimit,
  resetRepoBranchCatalogCacheForTests,
  writeRepoBranchCatalog,
} from "../repo-branch-catalog-cache";

function catalog(name: string): RepoBranchCatalog {
  return {
    remotes: [
      {
        name: "origin",
        url: `https://github.com/example/${name}.git`,
        isGitHub: true,
      },
    ],
    effectiveRemote: "origin",
    remoteExists: true,
    baseExplicit: false,
    effectiveBase: name,
    detectedDefault: name,
    listedRemote: "origin",
    branchSource: "remote",
    branches: [{ name, lastCommitDate: 42 }],
  };
}

describe("persisted repository branch catalogs", () => {
  beforeEach(() => {
    settings.clear();
    resetRepoBranchCatalogCacheForTests();
  });

  it("restores the last exact-key catalog across a cold module reset", () => {
    writeRepoBranchCatalog("/repo/a", catalog("develop"));

    resetRepoBranchCatalogCacheForTests();

    expect(readRepoBranchCatalog("/repo/a")).toEqual(catalog("develop"));
    expect(readRepoBranchCatalog("/repo/b")).toBeNull();
  });

  it("bounds old repositories and forgets a deleted owner", () => {
    for (let index = 0; index <= repoBranchCatalogCacheLimit; index += 1) {
      writeRepoBranchCatalog(`/repo/${index}`, catalog(`branch-${index}`));
    }
    expect(readRepoBranchCatalog("/repo/0")).toBeNull();
    expect(
      readRepoBranchCatalog(`/repo/${repoBranchCatalogCacheLimit}`),
    ).not.toBeNull();

    forgetRepoBranchCatalog(`/repo/${repoBranchCatalogCacheLimit}`);
    resetRepoBranchCatalogCacheForTests();
    expect(
      readRepoBranchCatalog(`/repo/${repoBranchCatalogCacheLimit}`),
    ).toBeNull();
  });

  it("rejects malformed persisted rows rather than inventing dropdown data", () => {
    settings.set("repo-branch-catalogs:v1", {
      version: 1,
      entries: [
        {
          repoRoot: "/repo/a",
          savedAt: 1,
          catalog: { remotes: [], branches: "not-an-array" },
        },
      ],
    });

    resetRepoBranchCatalogCacheForTests();

    expect(readRepoBranchCatalog("/repo/a")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { Branch, RepoBranchCatalog } from "../../../platform/git";
import {
  branchBase,
  defaultDispatcherBase,
  sourceForProject,
} from "../dispatcher-source";

const catalog: RepoBranchCatalog = {
  remotes: [
    {
      name: "upstream",
      url: "https://github.com/example/project.git",
      isGitHub: true,
    },
  ],
  effectiveRemote: "upstream",
  remoteExists: true,
  baseExplicit: false,
  effectiveBase: "trunk",
  detectedDefault: "trunk",
  listedRemote: "upstream",
  branchSource: "remote",
  branches: [{ name: "trunk", lastCommitDate: 1 }],
};
const local: Branch[] = [
  {
    name: "topic/local",
    worktreePath: "/repo",
    isCheckedOut: true,
    tipSha: "abc",
    lastCommitDate: 1,
    origin: "unknown",
    prUrl: null,
  },
];

describe("Create source identity", () => {
  it("uses the actual remote default and preserves full refs for disambiguation", () => {
    expect(defaultDispatcherBase(catalog, local, "/repo")).toMatchObject({
      branch: "refs/remotes/upstream/trunk",
      label: "trunk",
      source: "github",
    });
    expect(branchBase("trunk")).toMatchObject({
      branch: "refs/heads/trunk",
      source: "local",
    });
    expect(branchBase("feature/a", catalog.remotes[0])).toMatchObject({
      branch: "refs/remotes/upstream/feature/a",
      label: "feature/a",
      source: "github",
    });
  });

  it("honors configured bases and distinguishes non-GitHub remotes", () => {
    const other = { ...catalog.remotes[0], isGitHub: false };
    expect(branchBase("trunk", other).source).toBe("remote");
    expect(
      defaultDispatcherBase(
        {
          ...catalog,
          effectiveBase: "release",
          baseExplicit: true,
          branches: [{ name: "release", lastCommitDate: 1 }],
        },
        local,
        "/repo",
      )?.label,
    ).toBe("release");
  });

  it("falls back to the matching local default, then the root checkout's HEAD", () => {
    const noRemote = {
      ...catalog,
      remoteExists: false,
      listedRemote: null,
      branchSource: "local" as const,
      branches: local,
    };
    expect(defaultDispatcherBase(noRemote, local, "/repo")).toMatchObject({
      label: "topic/local",
      source: "local",
    });
    expect(
      defaultDispatcherBase(
        catalog,
        [{ ...local[0], name: "release" }],
        "/repo",
      ),
    ).toMatchObject({ label: "trunk", source: "github" });
    expect(
      defaultDispatcherBase(
        { ...noRemote, effectiveBase: "topic/local" },
        local,
        "/other",
      )?.label,
    ).toBe("topic/local");
    expect(defaultDispatcherBase(undefined, [], "/repo")).toBeNull();
  });

  it("never applies a selection to a different checkout or changed remote", () => {
    const project = {
      id: "a",
      repoRoot: "/repo",
      repoSlug: "shared",
      originUrl: "https://github.com/example/project.git",
    };
    const selected = { owner: project, base: branchBase("topic/local") };
    expect(sourceForProject(selected, project)).toBe(selected.base);
    expect(
      sourceForProject(selected, { ...project, repoRoot: "/clone" }),
    ).toBeNull();
    expect(
      sourceForProject(selected, { ...project, originUrl: null }),
    ).toBeNull();
    expect(sourceForProject(selected, null)).toBeNull();
  });
});

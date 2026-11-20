import { describe, expect, it } from "vitest";
import { githubRepository, joinProjects, joinRegisteredProjects, type ProjectSide } from "../project-identity";
import type { Project } from "../projects-store";

const local = (id: string, remote: string | null, addedAt = 1, githubId?: string): ProjectSide =>
  ({ id, place: "local", remote, addedAt, githubId });
const cloud = (id: string, remote: string, githubId?: string): ProjectSide =>
  ({ id, place: "cloud", remote, githubId });
const keys = (sides: ProjectSide[]) => joinProjects(sides).projects.map(project =>
  [project.key, project.local.map(side => side.id), project.cloud.map(side => side.id)]);

describe("GitHub repository identity", () => {
  it.each([
    "https://github.com/Withso/Zeros.git",
    "https://github.com/withso/zeros",
    "https://github.com/withso/zeros/",
    "http://www.github.com/WITHSO/zeros.git",
    "git@github.com:withso/zeros.git",
    "github.com:withso/zeros",
    "ssh://git@github.com/withso/Zeros.git",
    "git://github.com/withso/zeros.git",
    "withso/zeros",
  ])("normalizes %s", (remote) => {
    expect(githubRepository(remote)).toEqual({ owner: "withso", name: "zeros" });
  });

  it.each([null, "", "/Users/me/zeros", "https://gitlab.com/withso/zeros.git", "git@bitbucket.org:withso/zeros.git",
    "https://github.example.com/withso/zeros.git", "https://github.com/withso"])("rejects %s", (remote) => {
    expect(githubRepository(remote)).toBeNull();
  });
});

describe("joining projects", () => {
  it("joins a local folder and a cloud repository for the same repository, across URL forms and case", () => {
    expect(keys([local("l1", "git@github.com:Withso/Zeros.git"), cloud("c1", "withso/zeros")]))
      .toEqual([["github:withso/zeros", ["l1"], ["c1"]]]);
  });

  it("never joins a folder without a remote, a non-GitHub remote, a fork and its upstream, or same-named repositories", () => {
    expect(keys([
      local("no-remote", null),
      local("gitlab", "https://gitlab.com/withso/zeros.git"),
      cloud("upstream", "withso/zeros"),
      local("fork", "https://github.com/arunrk/zeros.git"),
      cloud("other-owner", "acme/zeros"),
    ])).toEqual([
      ["local:no-remote", ["no-remote"], []],
      ["local:gitlab", ["gitlab"], []],
      ["github:withso/zeros", [], ["upstream"]],
      ["github:arunrk/zeros", ["fork"], []],
      ["github:acme/zeros", [], ["other-owner"]],
    ]);
  });

  it("puts two clones in one project and defaults to the earliest added, then the lowest ID", () => {
    const joined = joinProjects([local("b", "withso/zeros", 5), local("a", "withso/zeros", 5), local("c", "withso/zeros", 1)]);
    expect(joined.projects).toHaveLength(1);
    expect(joined.projects[0].defaultLocal?.id).toBe("c");
    expect(joinProjects([local("b", "withso/zeros", 5), local("a", "withso/zeros", 5)]).projects[0].defaultLocal?.id).toBe("a");
  });

  it("prefers GitHub's repository ID once both sides know it", () => {
    expect(keys([local("renamed", "withso/old-name", 1, "42"), cloud("c", "withso/new-name", "42")]))
      .toEqual([["github:withso/old-name", ["renamed"], ["c"]]]);
    expect(keys([local("recreated", "withso/zeros", 1, "1"), cloud("c", "withso/zeros", "2")]))
      .toEqual([["github:withso/zeros", ["recreated"], []], ["github:withso/zeros#2", [], ["c"]]]);
    expect(keys([local("unknown", "withso/zeros"), cloud("c", "withso/zeros", "2")]))
      .toEqual([["github:withso/zeros", ["unknown"], ["c"]]]);
  });

  it("finds a project from any of its sides", () => {
    const joined = joinProjects([local("l1", "withso/zeros"), cloud("c1", "withso/zeros")]);
    expect(joined.bySide.get("l1")).toBe(joined.bySide.get("c1"));
  });

  it("does not allocate when nothing changed", () => {
    const sides = [local("l1", "withso/zeros"), cloud("c1", "withso/zeros"), local("l2", null)];
    const first = joinProjects(sides);
    expect(joinProjects(sides)).toBe(first);
    const again = joinProjects([...sides]);
    expect(again).toBe(first);
    const changed = joinProjects([...sides, cloud("c2", "acme/app")]);
    expect(changed.projects[0]).toBe(first.projects[0]);
    expect(changed.projects[1]).toBe(first.projects[1]);
  });
});

describe("registered projects", () => {
  it("joins a local folder with the cloud catalog's repository and keeps both IDs", () => {
    const projects = [
      { id: "local-zeros", name: "Zeros", repoRoot: "/Users/me/zeros", repoSlug: "zeros", originUrl: "git@github.com:withso/zeros.git", addedAt: 1 },
      { id: "cloud-repository:org:github.com:withso/zeros", name: "zeros", repoRoot: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
        repoSlug: "cloud-x", originUrl: "https://github.com/withso/zeros.git", addedAt: 2 },
    ] as Project[];
    const joined = joinRegisteredProjects(projects);
    expect(joined.projects).toHaveLength(1);
    expect(joined.projects[0].local.map(side => side.project)).toEqual([projects[0]]);
    expect(joined.projects[0].cloud.map(side => side.project)).toEqual([projects[1]]);
    expect(joinRegisteredProjects(projects)).toBe(joined);
    expect(joinRegisteredProjects([...projects])).toBe(joined);
  });
});

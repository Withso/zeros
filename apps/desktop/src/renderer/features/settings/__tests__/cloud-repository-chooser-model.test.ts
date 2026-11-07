import { describe, expect, it } from "vitest";
import { chooserRows, githubRepositoryFromUrl, repositoryOwners, type ChooserRepository } from "../cloud-repository-chooser-model";

const repo = (owner: string, name: string, id: string): ChooserRepository =>
  ({ id, owner, name, defaultBranch: "main", private: false, canPush: true });
const all = [repo("Withso", "zeros", "1"), repo("iamarunrk", "portfolio", "2"), repo("Withso", "0colors", "3")];

describe("cloud repository chooser model", () => {
  it("groups repositories by owner with how many are chosen", () => {
    expect(repositoryOwners(all, (row) => row.name !== "0colors")).toEqual([
      { owner: "iamarunrk", chosen: 1 },
      { owner: "Withso", chosen: 1 },
    ]);
  });

  it("lists one owner, a search across owners, or exactly a pasted GitHub URL", () => {
    expect(chooserRows(all, "", "withso").map((row) => row.name)).toEqual(["zeros", "0colors"]);
    expect(chooserRows(all, "port", "Withso").map((row) => row.name)).toEqual(["portfolio"]);
    expect(chooserRows(all, "https://github.com/Withso/zeros.git", null).map((row) => row.id)).toEqual(["1"]);
    expect(chooserRows(all, "github.com/withso/ZEROS/pull/9", null).map((row) => row.id)).toEqual(["1"]);
  });

  it("reads only github.com repository URLs", () => {
    expect(githubRepositoryFromUrl("https://github.com/Withso/zeros")).toEqual({ owner: "Withso", name: "zeros" });
    expect(githubRepositoryFromUrl("https://gitlab.com/Withso/zeros")).toBeNull();
    expect(githubRepositoryFromUrl("Withso/zeros")).toBeNull();
  });
});

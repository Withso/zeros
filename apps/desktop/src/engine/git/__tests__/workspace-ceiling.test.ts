import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setManagedWorkspaceRootsForTesting, withWorkspaceCeiling } from "../workspace-ceiling";

describe("withWorkspaceCeiling", () => {
  afterEach(() => setManagedWorkspaceRootsForTesting(null));

  it("keeps an inherited ceiling list, including its empty no-symlink marker, after the managed roots", () => {
    setManagedWorkspaceRootsForTesting(["/managed/workspaces"]);
    expect(withWorkspaceCeiling({ GIT_CEILING_DIRECTORIES: ":/slow/network" }).GIT_CEILING_DIRECTORIES)
      .toBe(`/managed/workspaces${path.delimiter}:/slow/network`);
  });

  it("resolves relative roots", () => {
    setManagedWorkspaceRootsForTesting(["relative/workspaces"]);
    expect(withWorkspaceCeiling({}).GIT_CEILING_DIRECTORIES).toBe(path.resolve("relative/workspaces"));
  });

  it("lists a delimiter root's nearest listable ancestor only for Git calls inside that root", () => {
    const odd = `/outer/zeros${path.delimiter}local/workspaces`;
    setManagedWorkspaceRootsForTesting([odd]);
    expect(withWorkspaceCeiling({}, `${odd}/repo/broken`).GIT_CEILING_DIRECTORIES).toBe("/outer");
    // An unrelated checkout rooted at that ancestor keeps resolving from below.
    expect(withWorkspaceCeiling({}, "/outer/packages/app").GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(withWorkspaceCeiling({}).GIT_CEILING_DIRECTORIES).toBeUndefined();
  });

  it("treats a child named like '..notes' as inside the root, and follows leading -C options", () => {
    const odd = `/outer/zeros${path.delimiter}local/workspaces`;
    setManagedWorkspaceRootsForTesting([odd]);
    expect(withWorkspaceCeiling({}, `${odd}/..notes`).GIT_CEILING_DIRECTORIES).toBe("/outer");
    expect(withWorkspaceCeiling({}, "/elsewhere", ["-C", `${odd}/repo/broken`, "status"]).GIT_CEILING_DIRECTORIES).toBe("/outer");
    expect(withWorkspaceCeiling({}, `${odd}/repo`, ["-C", "/elsewhere", "status"]).GIT_CEILING_DIRECTORIES).toBeUndefined();
    expect(withWorkspaceCeiling({}, "/elsewhere", ["--config-env", "core.pager=PAGER", "-C", `${odd}/repo`, "status"]).GIT_CEILING_DIRECTORIES).toBe("/outer");
  });
});


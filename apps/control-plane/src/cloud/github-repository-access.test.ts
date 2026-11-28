import { describe, expect, it } from "vitest";
import { githubRepositoryAccess } from "./github-repository-access";

describe("the caller's repository access", () => {
  it.each([
    [{ admin: true, push: false, pull: true }, "write"],
    [{ maintain: true, pull: true }, "write"],
    [{ push: true, pull: true }, "write"],
    [{ push: false, pull: true }, "read"],
    [{ pull: false }, "unavailable"],
    [undefined, "unavailable"],
  ] as const)("reads %j as %s", (permissions, access) => {
    expect(githubRepositoryAccess(permissions)).toBe(access);
  });
});

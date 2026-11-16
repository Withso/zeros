import { describe, expect, it } from "vitest";
import {
  releaseBranchOf,
  validateForwardOnly,
  validateInternal,
  validateReleasePrefix,
} from "../check-migrations-forward-only.mts";

const m = (version: number, up = `CREATE TABLE t${version} (id INTEGER);`) => ({ version, name: `m${version}`, up });
const ladder = (n: number) => Array.from({ length: n }, (_, i) => m(i + 1));

describe("local migration ladder on main", () => {
  it("allows appending after main's head", () => {
    expect(validateForwardOnly(ladder(3), ladder(4))).toEqual([]);
  });

  it("refuses a missing or edited released migration", () => {
    expect(validateForwardOnly(ladder(3), ladder(2)).join("\n")).toMatch(/migration 3 .* MISSING/);
    expect(validateForwardOnly(ladder(3), [m(1), m(2), m(3, "DROP TABLE t1;")]).join("\n")).toMatch(/up SQL changed/);
  });
});

describe("local migration ladder on a release branch", () => {
  it("accepts a branch cut before main appended a migration", () => {
    // release/0.1.29 measured: main has migration 46, the branch stops at 45.
    expect(validateReleasePrefix(ladder(46), ladder(45))).toEqual([]);
  });

  it("accepts a migration cherry-picked from main in order", () => {
    expect(validateReleasePrefix(ladder(47), ladder(46))).toEqual([]);
  });

  it("refuses a migration that has not landed on main", () => {
    expect(validateReleasePrefix(ladder(45), ladder(46)).join("\n")).toMatch(/migration 46 .* not on origin\/main/);
  });

  it("refuses a migration that differs from main's copy", () => {
    expect(validateReleasePrefix(ladder(46), [...ladder(45), m(46, "SELECT 1;")]).join("\n")).toMatch(/migration 46 .* differs/);
  });

  it("refuses skipping a main migration through the contiguity check", () => {
    // Cherry-picking main's 47 without 46 would make a later release skip 46 on this machine.
    expect(validateInternal([...ladder(45), m(47)]).join("\n")).toMatch(/version 47 breaks the contiguous/);
  });
});

describe("release branch detection", () => {
  it("uses a pull request's base before the pushed ref", () => {
    expect(releaseBranchOf({ GITHUB_BASE_REF: "release/0.1.31", GITHUB_REF_NAME: "12/merge" }, "x")).toBe("release/0.1.31");
    expect(releaseBranchOf({ GITHUB_BASE_REF: "main", GITHUB_REF_NAME: "12/merge" }, "release/0.1.31")).toBeNull();
  });

  it("uses the pushed ref, then the local branch", () => {
    expect(releaseBranchOf({ GITHUB_REF_NAME: "release/0.1.31" }, "main")).toBe("release/0.1.31");
    expect(releaseBranchOf({ GITHUB_REF_NAME: "main" }, "release/0.1.31")).toBeNull();
    expect(releaseBranchOf({}, "release/0.1.31")).toBe("release/0.1.31");
    expect(releaseBranchOf({}, "feature/release/0.1.31")).toBeNull();
  });
});

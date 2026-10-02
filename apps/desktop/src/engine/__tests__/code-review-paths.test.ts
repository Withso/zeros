import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertCodeReviewPath } from "../code-review/paths";

describe("review path authority failures", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-review-paths-"));
    fs.writeFileSync(path.join(root, "example.ts"), "original\n");
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it("fails the read on unreadable root metadata instead of filtering all discussions as denied paths", () => {
    vi.spyOn(fs, "realpathSync").mockImplementationOnce(() => { throw Object.assign(new Error("fixture metadata unavailable"), { code: "EACCES" }); });
    expect(() => assertCodeReviewPath(root, "example.ts")).toThrowError(expect.objectContaining({ code: "CODE_REVIEW_AUTHORITY_REJECTED" }));
  });
  it("fails closed with a generic authority error when registered-owner metadata is unavailable", () => {
    expect(() => assertCodeReviewPath(root, "example.ts", { ownerRoots: () => { throw new Error("fixture registry unavailable"); } }))
      .toThrowError(expect.objectContaining({ code: "CODE_REVIEW_AUTHORITY_REJECTED" }));
  });
  it("rejects dangling symlinks while retaining ordinary deleted historical paths", () => {
    fs.symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
    expect(() => assertCodeReviewPath(root, "dangling/deleted.ts")).toThrowError(expect.objectContaining({ code: "CODE_REVIEW_PATH_DENIED" }));
    expect(() => assertCodeReviewPath(root, "deleted/file.ts")).not.toThrow();
  });
  it.each([".env", ".zeros/private.txt", ".git/config", ".conductor/private.txt"])("applies remote/private policy to an alias targeting %s", (relative) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "EXAMPLE=synthetic-placeholder\n");
    fs.symlinkSync(relative, path.join(root, "public-alias.txt"));
    expect(() => assertCodeReviewPath(root, relative, { remote: true })).toThrowError(expect.objectContaining({ code: "CODE_REVIEW_PATH_DENIED" }));
    expect(() => assertCodeReviewPath(root, "public-alias.txt", { remote: true })).toThrowError(expect.objectContaining({ code: "CODE_REVIEW_PATH_DENIED" }));
  });
  it("rejects deleted paths below a private directory alias but keeps ordinary historical anchors", () => {
    fs.mkdirSync(path.join(root, ".zeros"));
    fs.symlinkSync(".zeros", path.join(root, "public-directory"));
    expect(() => assertCodeReviewPath(root, "public-directory/deleted.ts")).toThrowError(expect.objectContaining({ code: "CODE_REVIEW_PATH_DENIED" }));
    expect(() => assertCodeReviewPath(root, "deleted-folder/deleted.ts", { remote: true })).not.toThrow();
  });
});

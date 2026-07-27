import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "../diff";
import { isSensitiveRepoPath } from "../../files/read-file";

describe("parseUnifiedDiff path capture (remote secret-filter inputs)", () => {
  it("captures both a-side and b-side for an ordinary modification", () => {
    const sample = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const hunks = parseUnifiedDiff(sample);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].filePath).toBe("src/app.ts");
    expect(hunks[0].oldFilePath).toBe("src/app.ts");
  });

  it("captures the rename a-side so the filter can drop a rename FROM a secret", () => {
    const sample = [
      "diff --git a/.env b/notes.txt",
      "similarity index 100%",
      "rename from .env",
      "rename to notes.txt",
      "@@ -1,1 +1,1 @@",
      "-X=1",
      "+X=2",
    ].join("\n");
    const [h] = parseUnifiedDiff(sample);
    expect(h.filePath).toBe("notes.txt"); // b-side innocuous
    expect(h.oldFilePath).toBe(".env"); // a-side is the secret
    expect(isSensitiveRepoPath(h.oldFilePath ?? "")).toBe(true); // → filtered remotely
  });

  it("a greedy ' b/' mis-split lands the secret segment in the a-side (filter catches it)", () => {
    // git does not quote spaces, so a path containing ' b/' produces an
    // ambiguous header; the greedy capture mis-splits, but the secret segment
    // (.ssh) ends up in the a-side, which the both-side filter rejects.
    const sample = [
      "diff --git a/.ssh/key b/notsecret.txt b/.ssh/key b/notsecret.txt",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
    ].join("\n");
    const [h] = parseUnifiedDiff(sample);
    expect(isSensitiveRepoPath(h.oldFilePath ?? "")).toBe(true);
  });

  it("fails CLOSED (empty filePath) when a header cannot be parsed", () => {
    // A quoted header (shouldn't occur with core.quotePath=false, but if it
    // does) doesn't match → filePath empty → the remote filter drops the hunk.
    const sample = [
      'diff --git "a/weird path" "b/weird path"',
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
    ].join("\n");
    const [h] = parseUnifiedDiff(sample);
    expect(h.filePath).toBe("");
    expect(h.oldFilePath).toBe("");
  });
});
